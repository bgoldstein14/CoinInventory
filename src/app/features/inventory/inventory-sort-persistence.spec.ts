/**
 * Tests for remembering the grid's sort between sessions.
 *
 * Two requirements from the owner: the sort should survive a restart, and a
 * fresh installation should start sorted by Year.
 *
 * The validation tests matter more than they look. The stored value is JSON
 * from a browser database that may have been written by an older build of the
 * app, and columns in this project really do come and go — `name` became
 * `coinType`, and `tags` and `dealer` were both deleted outright. A remembered
 * sort naming one of those would otherwise produce a silently meaningless
 * order with no clue as to why.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { DEFAULT_SORT_STATE, InventoryFilterStore } from './inventory-filter.store';

/** A StorageService stand-in backed by a plain Map. */
function fakeStorage(seed?: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
    data
  };
}

/** The store only reads `inventory()` for filtering, which these tests do not exercise. */
const stubInventory = () => ({ inventory: () => [] } as unknown as InventoryService);

function createStore(seed?: Record<string, unknown>) {
  const storage = fakeStorage(seed);
  const store = new InventoryFilterStore(
    stubInventory(),
    storage as unknown as StorageService
  );
  return { store, storage };
}

describe('inventory sort persistence', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

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
    // 'dealer' was a real column until it was removed. A browser that used it
    // as its sort still has it in IndexedDB.
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
