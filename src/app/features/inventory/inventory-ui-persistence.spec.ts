/*
 * Remembering the user's choices between sessions — the grid's grouping,
 * which groups are open, and what it is filtered to.
 *
 * TWO THINGS ARE BEING TESTED AND ONLY ONE OF THEM IS "DOES IT SAVE".
 *
 * The other, and the one with teeth, is what happens when what comes back
 * out of storage no longer makes sense. It is JSON from a browser database
 * that an older build wrote, and columns and statuses in this project do
 * come and go — `Source` left the grid yesterday. A restore that throws
 * takes the app down; a restore that quietly applies nonsense leaves a
 * collector looking at eleven of his four hundred coins with nothing on
 * screen to say why. Both are worse than forgetting the preference.
 *
 * The suite runs under Node with no jsdom: the store is a plain class and
 * the rules it leans on are pure modules, so none of this needs a DOM.
 *
 * MERGED FILE. inventory-sort-persistence.spec.ts was folded in here; its
 * tests are the `inventory sort persistence` block below, under the header
 * that came with them.
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

/**
 * Tests for remembering the grid's sort between sessions.
 *
 * Two requirements: the sort survives a restart, and a fresh installation
 * starts sorted by Year.
 *
 * The validation tests matter more than they look. The stored value is JSON
 * from a browser database that may have been written by an older build, and
 * columns in this project do come and go. A remembered sort naming a column
 * that no longer exists would otherwise produce a silently meaningless order
 * with no clue as to why.
 */
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
    // 'dealer' is not a column. A browser that sorted by one that has since
    // been removed still has the name sitting in IndexedDB.
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
    // A cosmetic preference must never stop the inventory from rendering.
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
    // Several specs build the store with only an InventoryService; that must
    // mean "sort is not remembered", not a crash.
    const store = new InventoryFilterStore(stubInventory());

    await expect(store.restoreFromStorage()).resolves.toBeUndefined();
    expect(() => store.setSortColumn('grade')).not.toThrow();
    expect(store.sortState()).toEqual({ column: 'grade', direction: 'asc' });
  });
});

describe('the filters are remembered', () => {
  it('writes every filter the moment one of them is changed', () => {
    // The filter bar writes straight into the signal — `gradeFilter.set(...)`
    // — and there is no setter method to hang a save off. The signal itself
    // saves; see `remembered()` in inventory-filter.store.ts.
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
    // Explicitly excluded: the panel opens closed every session, as it
    // always has. Pinned from this end because the payload is the only
    // place it could creep back in.
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
    // Four hundred coins are missing and the only control that could say
    // why lives in a panel that opens closed. Opening it IS the explanation.
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

    // The search box is always on screen and shows its own state, so there
    // is nothing to reveal.
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
    // An empty status set deliberately shows no coins, and that is right
    // within a session, where the user has just unticked the last box with
    // the panel open in front of him. Restored into a fresh session it is
    // an empty grid with no author.
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
      // The dragged group order rides in the same blob — one key for the
      // column, the open groups and the order, because none of the three
      // means anything without the first. Empty until he drags something.
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
    // The one control reads the state: everything shut, so it offers expand.
    expect(store.expandAllControl().action).toBe('expand');
    store.applyExpandAll();
    expect(saved<{ collapsedByDefault: boolean }>(storage, StorageKeys.GridGrouping)?.collapsedByDefault)
      .toBe(false);

    store.applyExpandAll();
    expect(saved<{ collapsedByDefault: boolean }>(storage, StorageKeys.GridGrouping)?.collapsedByDefault)
      .toBe(true);
  });

  it('does NOT re-collapse when the same grouping is chosen again', () => {
    // A <select> fires `change` on a re-select; shutting the group the user
    // has just opened would look like the app undoing his click.
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
    // `Source` was dropped from the grid yesterday. This is the real case.
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
 * THE GROUPS CAN BE PUT IN THE OWNER'S ORDER, AND IT HAS TO SURVIVE THE NIGHT.
 *
 * "The grid groupings should be movable, so I could drag a grouping to the
 * top, or wherever I like." The rules are pure and exhaustively tested in
 * group-order.spec.ts; what is tested here is the half that is this store's —
 * that a move is written to storage under the same key as the grouping, that
 * it comes back, that it is kept per column, and that a saved order naming
 * groups which no longer exist cannot throw or empty the grid.
 */
describe('the dragged group order is remembered', () => {
  /** Three countries, so a move has somewhere to go and somewhere to stop. */
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
    /* Decision 1. An order of countries is meaningless under Grade, so it is
     * not applied — but dropping it because the user glanced at another
     * column would destroy a minute of dragging. Both are avoided by keying
     * the order to its column, and the Reset control appearing and
     * disappearing with it is what makes that visible. */
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
    /* The rule inventory-filter-persistence.ts set, applied here: stale
     * state degrades. Atlantis was never a country in this collection and
     * Germany was never placed — neither may cost the user a row. */
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
    // The grouping itself degrades to the flat grid; the order it was saved
    // next to is still perfectly good and is waiting when he picks Country.
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
    // All groups start collapsed: the point is to see the shape of the
    // collection, not to add sixty headings to the scroll it already was.
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
    // A heading reading 2 above a grid that can only ever show 1 of them
    // would be the grouping telling the same lie the filter does.
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
    // A dozen specs build this store with only an InventoryService, and a
    // missing StorageService must mean "not remembered", never a crash.
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
