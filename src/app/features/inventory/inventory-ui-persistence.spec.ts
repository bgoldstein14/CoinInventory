/*
 * Persistence of the grid's sort, filters, grouping and group order between
 * sessions, including how stale or malformed stored values degrade.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { CoinRecord } from '../../types/coin.model';
import { COLLECTION_STATUSES } from '../../types/collection-status';
import {
  DEFAULT_SORT_STATE,
  InventoryFilterStore,
  allCategoriesFilter,
  allSetsFilter
} from './inventory-filter.store';
import {
  DEFAULT_FILTER_STATE,
  activeAdvancedFilterCount,
  restoreFilterState,
  shouldRevealAdvancedFilters
} from './inventory-filter-persistence';

/** A StorageService stand-in backed by a plain Map. */
function fakeStorage(seed?: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
    data
  };
}

/** Enough of a coin for the filters to pass it and the grouping to bucket it. */
function coin(id: string, country: string): CoinRecord {
  return {
    id, country, coinType: '', denomination: '', year: '', grade: '', mintMark: '',
    variety: '', certCompany: '', certNumber: '', notes: '', category: '',
    purchasePrice: 0, currentValue: 0
  } as CoinRecord;
}

const stubInventory = (coins: CoinRecord[] = []) =>
  ({ inventory: () => coins } as unknown as InventoryService);

function createStore(seed?: Record<string, unknown>, coins: CoinRecord[] = []) {
  const storage = fakeStorage(seed);
  const store = new InventoryFilterStore(stubInventory(coins), storage as unknown as StorageService);
  return { store, storage };
}

/** Two countries, so there are real groups for the one control to act on. */
const TWO_COUNTRIES = [coin('mx-1', 'Mexico'), coin('fr-1', 'France')];

/** The last value written under a key, or undefined if it was never written. */
function saved<T>(storage: ReturnType<typeof fakeStorage>, key: string): T | undefined {
  return storage.data.get(key) as T | undefined;
}

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

/** Sort is remembered, defaults to Year, and invalid saved values are ignored. */
describe('inventory sort persistence', () => {
  it('starts sorted by Year ascending on a fresh install', () => {
    const { store } = createStore();

    expect(store.sortState()).toEqual({ column: 'year', direction: 'asc' });
    expect(DEFAULT_SORT_STATE).toEqual({ column: 'year', direction: 'asc' });
  });

  it('writes the sort when a column header is clicked', async () => {
    const { store, storage } = createStore();

    store.setSortColumn('grade');

    expect(store.sortState()).toEqual({ column: 'grade', direction: 'asc' });
    expect(storage.set).toHaveBeenCalledWith(
      StorageKeys.SortState,
      { column: 'grade', direction: 'asc' }
    );
  });

  it('writes the flipped direction when the same header is clicked again', () => {
    const { store, storage } = createStore();

    store.setSortColumn('grade');
    store.setSortColumn('grade');

    expect(store.sortState()).toEqual({ column: 'grade', direction: 'desc' });
    expect(storage.set).toHaveBeenLastCalledWith(
      StorageKeys.SortState,
      { column: 'grade', direction: 'desc' }
    );
  });

  it('restores a previously saved sort', async () => {
    const { store } = createStore({
      [StorageKeys.SortState]: { column: 'currentValue', direction: 'desc' }
    });

    await store.restoreFromStorage();

    expect(store.sortState()).toEqual({ column: 'currentValue', direction: 'desc' });
  });

  it('keeps the Year default when nothing has been saved yet', async () => {
    const { store } = createStore();

    await store.restoreFromStorage();

    expect(store.sortState()).toEqual(DEFAULT_SORT_STATE);
  });

  it('ignores a saved column that no longer exists', async () => {
    // 'dealer' is not a column (e.g. one since removed).
    const { store } = createStore({
      [StorageKeys.SortState]: { column: 'dealer', direction: 'asc' }
    });

    await store.restoreFromStorage();

    expect(store.sortState()).toEqual(DEFAULT_SORT_STATE);
  });

  it('ignores a saved direction that is not asc or desc', async () => {
    const { store } = createStore({
      [StorageKeys.SortState]: { column: 'grade', direction: 'sideways' }
    });

    await store.restoreFromStorage();

    expect(store.sortState()).toEqual(DEFAULT_SORT_STATE);
  });

  it('survives a storage read that throws', async () => {
    const storage = fakeStorage();
    storage.get.mockRejectedValue(new Error('IndexedDB unavailable'));
    const store = new InventoryFilterStore(
      stubInventory(),
      storage as unknown as StorageService
    );

    await expect(store.restoreFromStorage()).resolves.toBeUndefined();
    expect(store.sortState()).toEqual(DEFAULT_SORT_STATE);
  });

  it('works with no StorageService at all', async () => {
    const store = new InventoryFilterStore(stubInventory());

    await expect(store.restoreFromStorage()).resolves.toBeUndefined();
    expect(() => store.setSortColumn('grade')).not.toThrow();
    expect(store.sortState()).toEqual({ column: 'grade', direction: 'asc' });
  });
});

describe('the filters are remembered', () => {
  it('writes every filter the moment one of them is changed', () => {
    // The filter bar writes signals directly; the signal itself saves.
    const { store, storage } = createStore();

    store.gradeFilter.set('MS');

    expect(storage.set).toHaveBeenCalledWith(StorageKeys.Filters, expect.objectContaining({
      gradeFilter: 'MS'
    }));
  });

  it('saves the search box and the category dropdown too, wherever they are written from', () => {
    // The App shell writes these two rather than the filter bar.
    const { store, storage } = createStore();

    store.searchQuery.set('morgan');
    store.categoryFilter.set('Type Set');

    const written = saved<Record<string, unknown>>(storage, StorageKeys.Filters);
    expect(written?.searchQuery).toBe('morgan');
    expect(written?.categoryFilter).toBe('Type Set');
  });

  it('saves the status tick boxes', () => {
    const { store, storage } = createStore();

    store.toggleCollectionStatus('wanted');

    const written = saved<Record<string, unknown>>(storage, StorageKeys.Filters);
    expect(written?.collectionStatuses).not.toContain('wanted');
    expect(written?.collectionStatuses).toContain('owned');
  });

  it('persists NOTHING about the detail panel', () => {
    // The detail panel always opens closed; nothing about it is stored.
    const { store, storage } = createStore();
    store.gradeFilter.set('MS');

    const written = saved<Record<string, unknown>>(storage, StorageKeys.Filters);
    expect(Object.keys(written ?? {}).sort()).toEqual([
      'categoryFilter', 'coinSetFilter', 'collectionStatuses', 'countryFilter',
      'gradeFilter', 'searchQuery', 'showAdvancedFilters', 'sourceFilter',
      'valueMaxFilter', 'valueMinFilter'
    ]);
    expect(Object.keys(StorageKeys).join(' ')).not.toMatch(/detail/i);
  });

  it('brings them all back next session', async () => {
    const { store } = createStore({
      [StorageKeys.Filters]: {
        searchQuery: 'eagle',
        categoryFilter: 'Type Set',
        gradeFilter: 'MS',
        valueMinFilter: '10',
        valueMaxFilter: '500',
        sourceFilter: 'quicken',
        countryFilter: 'Mexico',
        coinSetFilter: 'Morgan Set',
        collectionStatuses: ['owned', 'for-sale'],
        showAdvancedFilters: false
      }
    });

    await store.restoreFromStorage();

    expect(store.searchQuery()).toBe('eagle');
    expect(store.categoryFilter()).toBe('Type Set');
    expect(store.gradeFilter()).toBe('MS');
    expect(store.valueMinFilter()).toBe('10');
    expect(store.valueMaxFilter()).toBe('500');
    expect(store.sourceFilter()).toBe('quicken');
    expect(store.countryFilter()).toBe('Mexico');
    expect(store.coinSetFilter()).toBe('Morgan Set');
    expect(store.collectionStatusFilter()).toEqual(['owned', 'for-sale']);
  });

  it('starts unfiltered when nothing was ever saved', async () => {
    const { store } = createStore();
    await store.restoreFromStorage();

    expect(store.searchQuery()).toBe('');
    expect(store.categoryFilter()).toBe(allCategoriesFilter);
    expect(store.coinSetFilter()).toBe(allSetsFilter);
    expect(store.collectionStatusFilter()).toEqual([...COLLECTION_STATUSES]);
    expect(store.showAdvancedFilters()).toBe(false);
  });
});

describe('a restored filter must not be invisible', () => {
  it('opens the advanced panel when something in it is hiding rows', async () => {
    const { store } = createStore({
      [StorageKeys.Filters]: { countryFilter: 'Mexico', showAdvancedFilters: false }
    });

    await store.restoreFromStorage();

    expect(store.countryFilter()).toBe('Mexico');
    expect(store.showAdvancedFilters()).toBe(true);
  });

  it('leaves it shut when nothing in it is hiding anything', async () => {
    const { store } = createStore({
      [StorageKeys.Filters]: { searchQuery: 'morgan', showAdvancedFilters: false }
    });

    await store.restoreFromStorage();

    // The search box is always visible, so there is nothing to reveal.
    expect(store.searchQuery()).toBe('morgan');
    expect(store.showAdvancedFilters()).toBe(false);
  });

  it('leaves a panel the user left open, open', async () => {
    const { store } = createStore({
      [StorageKeys.Filters]: { showAdvancedFilters: true }
    });

    await store.restoreFromStorage();
    expect(store.showAdvancedFilters()).toBe(true);
  });

  it('counts only the filters that can hide inside the panel', () => {
    expect(activeAdvancedFilterCount(DEFAULT_FILTER_STATE)).toBe(0);
    expect(activeAdvancedFilterCount({ ...DEFAULT_FILTER_STATE, searchQuery: 'x' })).toBe(0);
    expect(activeAdvancedFilterCount({ ...DEFAULT_FILTER_STATE, countryFilter: 'Mexico' })).toBe(1);
    expect(activeAdvancedFilterCount({
      ...DEFAULT_FILTER_STATE,
      collectionStatuses: ['owned']
    })).toBe(1);
    expect(shouldRevealAdvancedFilters({ ...DEFAULT_FILTER_STATE, gradeFilter: 'MS' })).toBe(true);
  });
});

describe('a saved filter that no longer makes sense', () => {
  it('drops a status token that no longer exists', () => {
    const state = restoreFilterState({ collectionStatuses: ['owned', 'consigned'] });
    expect(state.collectionStatuses).toEqual(['owned']);
  });

  it('falls back to ALL statuses when the saved set would show nothing', async () => {
    // An empty set shows no coins; restored into a new session that would be an unexplained empty grid.
    const { store } = createStore({
      [StorageKeys.Filters]: { collectionStatuses: ['consigned'] }
    });

    await store.restoreFromStorage();
    expect(store.collectionStatusFilter()).toEqual([...COLLECTION_STATUSES]);
  });

  it('does the same for a deliberately emptied set', () => {
    expect(restoreFilterState({ collectionStatuses: [] }).collectionStatuses)
      .toEqual([...COLLECTION_STATUSES]);
  });

  it('rebuilds the status order rather than trusting the saved one', () => {
    const state = restoreFilterState({ collectionStatuses: ['sold', 'owned'] });
    expect(state.collectionStatuses).toEqual(['owned', 'sold']);
  });

  it('ignores a field of the wrong type without losing the others', () => {
    const state = restoreFilterState({ countryFilter: 42, gradeFilter: 'MS' });
    expect(state.countryFilter).toBe('');
    expect(state.gradeFilter).toBe('MS');
  });

  it('degrades anything unreadable to an unfiltered grid, without throwing', async () => {
    for (const junk of [null, undefined, 'filters', 7, []]) {
      expect(() => restoreFilterState(junk)).not.toThrow();
    }
    expect(restoreFilterState('filters')).toEqual(DEFAULT_FILTER_STATE);

    const { store } = createStore({ [StorageKeys.Filters]: 'nonsense' });
    await store.restoreFromStorage();
    expect(store.countryFilter()).toBe('');
    expect(store.collectionStatusFilter()).toEqual([...COLLECTION_STATUSES]);
  });
});

describe('the grouping is remembered', () => {
  it('starts with no grouping at all — today\'s flat grid', () => {
    const { store } = createStore();
    expect(store.groupColumn()).toBeNull();
    expect(store.isGrouped()).toBe(false);
    expect(store.groupColumnValue()).toBe('');
  });

  it('saves the grouping the moment it is chosen, with every group shut', () => {
    const { store, storage } = createStore();

    store.setGroupColumn('country');

    expect(store.groupColumn()).toBe('country');
    expect(saved(storage, StorageKeys.GridGrouping)).toEqual({
      column: 'country',
      collapsedByDefault: true,
      // Group order is stored in the same blob as the grouping.
      exceptions: [],
      orders: {}
    });
  });

  it('saves a group being opened', () => {
    const { store, storage } = createStore();

    store.setGroupColumn('country');
    store.toggleGroupExpansion('Mexico');

    expect(saved(storage, StorageKeys.GridGrouping)).toEqual({
      column: 'country',
      collapsedByDefault: true,
      exceptions: ['Mexico'],
      orders: {}
    });
    expect(store.isGroupOpen('Mexico')).toBe(true);
  });

  it('saves Expand all, and then Collapse all', () => {
    const { store, storage } = createStore(undefined, TWO_COUNTRIES);

    store.setGroupColumn('country');
    expect(store.expandAllControl().action).toBe('expand');
    store.applyExpandAll();
    expect(saved<{ collapsedByDefault: boolean }>(storage, StorageKeys.GridGrouping)?.collapsedByDefault)
      .toBe(false);

    store.applyExpandAll();
    expect(saved<{ collapsedByDefault: boolean }>(storage, StorageKeys.GridGrouping)?.collapsedByDefault)
      .toBe(true);
  });

  it('does NOT re-collapse when the same grouping is chosen again', () => {
    // A <select> fires `change` on re-select; open groups must stay open.
    const { store } = createStore();

    store.setGroupColumn('country');
    store.toggleGroupExpansion('Mexico');
    store.setGroupColumn('country');

    expect(store.isGroupOpen('Mexico')).toBe(true);
  });

  it('collapses everything again when the grouping CHANGES', () => {
    const { store } = createStore();

    store.setGroupColumn('country');
    store.toggleGroupExpansion('Mexico');
    store.setGroupColumn('category');

    expect(store.groupColumn()).toBe('category');
    expect(store.isGroupOpen('Mexico')).toBe(false);
  });

  it('refuses a numeric column, leaving the flat grid', () => {
    const { store } = createStore();
    store.setGroupColumn('currentValue');
    expect(store.groupColumn()).toBeNull();
  });

  it('goes back to the flat grid on None', () => {
    const { store } = createStore();
    store.setGroupColumn('country');
    store.setGroupColumn('');
    expect(store.groupColumn()).toBeNull();
    expect(store.isGrouped()).toBe(false);
  });

  it('brings the grouping and the open groups back next session', async () => {
    const { store } = createStore({
      [StorageKeys.GridGrouping]: {
        column: 'country',
        collapsedByDefault: true,
        exceptions: ['Mexico']
      }
    });

    await store.restoreFromStorage();

    expect(store.groupColumn()).toBe('country');
    expect(store.isGroupOpen('Mexico')).toBe(true);
    expect(store.isGroupOpen('France')).toBe(false);
  });

  it('degrades a saved grouping for a DELETED column to the flat grid', async () => {
    // `source` is no longer a grid column.
    const { store } = createStore({
      [StorageKeys.GridGrouping]: { column: 'source', collapsedByDefault: true, exceptions: [] }
    });

    await store.restoreFromStorage();

    expect(store.groupColumn()).toBeNull();
    expect(store.isGrouped()).toBe(false);
  });

  it('survives a corrupt saved grouping without throwing', async () => {
    const { store } = createStore({ [StorageKeys.GridGrouping]: 'country' });
    await expect(store.restoreFromStorage()).resolves.toBeUndefined();
    expect(store.groupColumn()).toBeNull();
  });
});

/*
 * Custom group order: saved under the grouping key, restored, kept per column,
 * and tolerant of stale or malformed saved orders. Ordering rules themselves
 * are tested in group-order.spec.ts.
 */
describe('the dragged group order is remembered', () => {
  const THREE_COUNTRIES = [coin('fr-1', 'France'), coin('de-1', 'Germany'), coin('mx-1', 'Mexico')];

  const headings = (store: InventoryFilterStore) => store.coinGroups().map(group => group.label);

  function groupedByCountry(seed?: Record<string, unknown>) {
    const made = createStore(seed, THREE_COUNTRIES);
    made.store.setGroupColumn('country');
    return made;
  }

  it('starts alphabetical, with no custom order and nothing to reset', () => {
    const { store } = groupedByCountry();

    expect(headings(store)).toEqual(['France', 'Germany', 'Mexico']);
    expect(store.hasCustomGroupOrder()).toBe(false);
    expect(store.canReorderGroups()).toBe(true);
  });

  it('drags a group to the top and saves it under the grouping key', () => {
    const { store, storage } = groupedByCountry();

    expect(store.dropGroupOn('Mexico', 'France')).toBe(true);

    expect(headings(store)).toEqual(['Mexico', 'France', 'Germany']);
    expect(saved<{ orders: Record<string, string[]> }>(storage, StorageKeys.GridGrouping)?.orders)
      .toEqual({ country: ['Mexico', 'France', 'Germany'] });
  });

  it('moves one place with the keyboard and announces where it landed', () => {
    const { store } = groupedByCountry();

    expect(store.moveGroup('Mexico', -1)).toBe(true);

    expect(headings(store)).toEqual(['France', 'Mexico', 'Germany']);
    expect(store.groupOrderAnnouncement()).toBe('Mexico moved to position 2 of 3');
  });

  it('does not save, or announce, a move that could not happen', () => {
    const { store, storage } = groupedByCountry();
    const writes = storage.set.mock.calls.length;

    expect(store.moveGroup('France', -1)).toBe(false);
    expect(store.dropGroupOn('France', 'France')).toBe(false);

    expect(store.groupOrderAnnouncement()).toBe('');
    expect(storage.set.mock.calls.length).toBe(writes);
  });

  it('brings the order back next session', async () => {
    const { store } = createStore({
      [StorageKeys.GridGrouping]: {
        column: 'country',
        collapsedByDefault: true,
        exceptions: [],
        orders: { country: ['Mexico', 'France', 'Germany'] }
      }
    }, THREE_COUNTRIES);

    await store.restoreFromStorage();

    expect(headings(store)).toEqual(['Mexico', 'France', 'Germany']);
    expect(store.hasCustomGroupOrder()).toBe(true);
  });

  it('KEEPS the order when the grouping column changes, and does not apply it', () => {
    // Orders are keyed per column: kept but not applied under another column.
    const { store } = groupedByCountry();
    store.dropGroupOn('Mexico', 'France');

    store.setGroupColumn('grade');
    expect(store.hasCustomGroupOrder()).toBe(false);

    store.setGroupColumn('country');
    expect(store.hasCustomGroupOrder()).toBe(true);
    expect(headings(store)).toEqual(['Mexico', 'France', 'Germany']);
  });

  it('resets this column back to alphabetical, and saves the reset', () => {
    const { store, storage } = groupedByCountry();
    store.dropGroupOn('Mexico', 'France');

    store.resetGroupOrder();

    expect(headings(store)).toEqual(['France', 'Germany', 'Mexico']);
    expect(store.hasCustomGroupOrder()).toBe(false);
    expect(saved<{ orders: Record<string, string[]> }>(storage, StorageKeys.GridGrouping)?.orders)
      .toEqual({});
  });

  it('does not lose a group to a saved order that names groups which are gone', async () => {
    // Unknown groups in the saved order are skipped; unplaced groups follow.
    const { store } = createStore({
      [StorageKeys.GridGrouping]: {
        column: 'country',
        collapsedByDefault: true,
        exceptions: [],
        orders: { country: ['Atlantis', 'Mexico', 'Narnia'] }
      }
    }, THREE_COUNTRIES);

    await expect(store.restoreFromStorage()).resolves.toBeUndefined();

    expect(headings(store)).toEqual(['Mexico', 'France', 'Germany']);
    expect(store.filteredInventory()).toHaveLength(3);
  });

  it('survives a saved order that is not even the right shape', async () => {
    const { store } = createStore({
      [StorageKeys.GridGrouping]: {
        column: 'country',
        collapsedByDefault: true,
        exceptions: [],
        orders: 'Mexico, France'
      }
    }, THREE_COUNTRIES);

    await expect(store.restoreFromStorage()).resolves.toBeUndefined();
    expect(headings(store)).toEqual(['France', 'Germany', 'Mexico']);
  });

  it('keeps a Country order that was saved beside a grouping by a DELETED column', async () => {
    // The grouping falls back to flat, but the saved Country order is kept.
    const { store } = createStore({
      [StorageKeys.GridGrouping]: {
        column: 'source',
        collapsedByDefault: true,
        exceptions: [],
        orders: { country: ['Mexico', 'France', 'Germany'] }
      }
    }, THREE_COUNTRIES);

    await store.restoreFromStorage();
    expect(store.groupColumn()).toBeNull();

    store.setGroupColumn('country');
    expect(headings(store)).toEqual(['Mexico', 'France', 'Germany']);
  });
});

describe('what the grid shows once a grouping is chosen', () => {
  it('is exactly the flat grid with no grouping chosen', () => {
    const { store } = createStore(undefined, TWO_COUNTRIES);

    expect(store.gridRows().every(row => row.kind === 'coin')).toBe(true);
    expect(store.renderedInventory()).toBe(store.filteredInventory());
  });

  it('shows headings and NO rows the moment a grouping is chosen', () => {
    const { store } = createStore(undefined, TWO_COUNTRIES);

    store.setGroupColumn('country');

    expect(store.gridRows().map(row => row.kind)).toEqual(['group', 'group']);
    expect(store.renderedInventory()).toEqual([]);
  });

  it('shows the rows of the group the user opens, and only those', () => {
    const { store } = createStore(undefined, TWO_COUNTRIES);

    store.setGroupColumn('country');
    store.toggleGroupExpansion('Mexico');

    expect(store.renderedInventory().map(c => c.id)).toEqual(['mx-1']);
  });

  it('counts the coins the CURRENT FILTERS let through, not the whole collection', () => {
    const { store } = createStore(undefined, TWO_COUNTRIES);

    store.setGroupColumn('country');
    store.countryFilter.set('Mexico');

    expect(store.coinGroups().map(group => group.label)).toEqual(['Mexico']);
    expect(store.coinGroups()[0].count).toBe(1);
  });
});

describe('restoring does not write back what it just read', () => {
  it('makes no storage writes while applying a restore', async () => {
    const { store, storage } = createStore({
      [StorageKeys.Filters]: { countryFilter: 'Mexico', gradeFilter: 'MS' }
    });

    await store.restoreFromStorage();

    expect(storage.set).not.toHaveBeenCalled();
  });

  it('saves again as soon as the user changes something', async () => {
    const { store, storage } = createStore({
      [StorageKeys.Filters]: { countryFilter: 'Mexico' }
    });

    await store.restoreFromStorage();
    store.gradeFilter.set('MS');

    expect(storage.set).toHaveBeenCalledTimes(1);
    const written = saved<Record<string, unknown>>(storage, StorageKeys.Filters);
    expect(written?.countryFilter).toBe('Mexico');
    expect(written?.gradeFilter).toBe('MS');
  });
});

describe('the store without a StorageService at all', () => {
  it('still filters and still groups, it simply forgets', () => {
    const store = new InventoryFilterStore(stubInventory());

    expect(() => {
      store.gradeFilter.set('MS');
      store.setGroupColumn('country');
      store.toggleGroupExpansion('Mexico');
      store.applyExpandAll();
    }).not.toThrow();

    expect(store.groupColumn()).toBe('country');
  });
});
