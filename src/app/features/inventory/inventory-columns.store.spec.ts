/**
 * Column order and saved column preferences. The table template loops over
 * visibleInventoryColumns(), so testing the store tests the grid's order.
 * IndexedDB comes from fake-indexeddb.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryColumnsStore } from './inventory-columns.store';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { InventoryColumn, inventoryColumnOrder } from '../../types/inventory-columns';

/** Index of a column in the canonical list — the single source of order. */
const canonicalIndex = (column: InventoryColumn) => inventoryColumnOrder.indexOf(column);

describe('inventoryColumnOrder — Cert sits immediately before Grade', () => {
  it('places certNumber directly before grade with nothing in between', () => {
    // The requirement is adjacency, not just "somewhere to the left of".
    expect(canonicalIndex('grade') - canonicalIndex('certNumber')).toBe(1);
  });

  it('still places mintMark directly after year', () => {
    expect(canonicalIndex('mintMark') - canonicalIndex('year')).toBe(1);
  });

  it('places denomination directly after mintMark', () => {
    expect(canonicalIndex('denomination') - canonicalIndex('mintMark')).toBe(1);
  });

  it('lists denomination exactly once', () => {
    // A duplicate entry would give the grid two Denomination columns.
    expect(inventoryColumnOrder.filter(c => c === 'denomination')).toHaveLength(1);
  });

  it('keeps the first four columns reading as a coin is described', () => {
    // Guards the whole leading group so an insertion between them fails here.
    expect(inventoryColumnOrder.slice(0, 4)).toEqual(
      ['year', 'mintMark', 'denomination', 'coinType']
    );
  });

  it('lists certNumber exactly once', () => {
    expect(inventoryColumnOrder.filter(c => c === 'certNumber')).toHaveLength(1);
  });

  it('has no duplicate columns at all', () => {
    expect(new Set(inventoryColumnOrder).size).toBe(inventoryColumnOrder.length);
  });
});

describe('InventoryColumnsStore — ordering', () => {
  let storage: StorageService;
  let store: InventoryColumnsStore;

  beforeEach(() => {
    // Fresh in-memory IndexedDB per test.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    storage = new StorageService();
    store = new InventoryColumnsStore(storage);
  });

  it('inserts a newly ticked Cert column before Grade, not at the far right', () => {
    // Appending would put it after the last column until a reload.
    expect(store.visibleInventoryColumns()).not.toContain('certNumber');

    store.toggleColumn('certNumber');

    const visible = store.visibleInventoryColumns();
    expect(visible.indexOf('grade') - visible.indexOf('certNumber')).toBe(1);
    expect(visible.at(-1)).not.toBe('certNumber');
  });

  it('keeps the whole visible list in canonical order after any toggle', () => {
    store.toggleColumn('certNumber');
    store.toggleColumn('coinSet');
    store.toggleColumn('variety');
    store.toggleColumn('category'); // switching one OFF must not scramble the rest

    const visible = store.visibleInventoryColumns();
    const indexes = visible.map(canonicalIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('never leaves the table with zero columns', () => {
    // Untick everything; the last one standing has to stay.
    for (const column of [...store.visibleInventoryColumns()]) {
      store.toggleColumn(column);
    }
    expect(store.visibleInventoryColumns().length).toBeGreaterThan(0);
  });
});

describe('InventoryColumnsStore — a PRE-EXISTING saved preference', () => {
  let storage: StorageService;

  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    storage = new StorageService();
  });

  it('ignores the ORDER of the stored array and re-derives it from the canonical list', async () => {
    // The stored array is read as a set and re-sorted, so a saved old
    // order (cert after soldPrice) doesn't pin the old layout.
    const savedWithOldOrder: InventoryColumn[] = [
      'year', 'mintMark', 'coinType', 'grade', 'category', 'denomination',
      'country', 'purchasePrice', 'currentValue', 'soldPrice', 'certNumber'
    ];
    await storage.set(StorageKeys.VisibleColumns, savedWithOldOrder);

    const store = new InventoryColumnsStore(storage);
    await store.restoreFromStorage();

    const visible = store.visibleInventoryColumns();
    expect(visible).toContain('certNumber');
    expect(visible.indexOf('grade') - visible.indexOf('certNumber')).toBe(1);
  });

  it('keeps the user\'s CHOICE of extra columns while rewriting their order', async () => {
    // Re-deriving the order must not be an excuse to throw the selection away.
    await storage.set<InventoryColumn[]>(StorageKeys.VisibleColumns, [
      'coinSet', 'certNumber', 'year', 'grade'
    ]);

    const store = new InventoryColumnsStore(storage);
    await store.restoreFromStorage();

    const visible = store.visibleInventoryColumns();
    expect(visible).toContain('coinSet');
    expect(visible).toContain('certNumber');
    const indexes = visible.map(canonicalIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('discards columns that no longer exist rather than breaking', async () => {
    await storage.set(StorageKeys.VisibleColumns, [
      'year', 'certNumber', 'grade', 'someColumnWeDeletedInV1'
    ] as unknown as InventoryColumn[]);

    const store = new InventoryColumnsStore(storage);
    await store.restoreFromStorage();

    expect(store.visibleInventoryColumns())
      .not.toContain('someColumnWeDeletedInV1' as InventoryColumn);
  });

  it('writes the canonicalised order back out, so storage self-heals on the next toggle', async () => {
    await storage.set<InventoryColumn[]>(StorageKeys.VisibleColumns, [
      'year', 'grade', 'certNumber'
    ]);

    const store = new InventoryColumnsStore(storage);
    await store.restoreFromStorage();
    store.toggleColumn('coinSet'); // any toggle persists the current list

    // Let the fire-and-forget IndexedDB write land.
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const reread = await storage.get<InventoryColumn[]>(StorageKeys.VisibleColumns);
    const indexes = (reread ?? []).map(canonicalIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});

