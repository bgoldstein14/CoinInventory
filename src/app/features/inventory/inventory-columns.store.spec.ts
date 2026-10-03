/**
 * Tests for inventory column ORDER and for the way a saved column preference
 * interacts with it.
 *
 * WHY THESE TESTS LOOK LIKE THIS
 * ------------------------------
 * There is no jsdom in this project's vitest setup, so nothing here renders a
 * component or inspects a `<th>`. That is fine, because the grid's column
 * sequence is not decided by the template: `inventory-table.html` just loops
 * over `columns().visibleInventoryColumns()`. Testing the store therefore
 * tests the thing that actually decides the order.
 *
 * IndexedDB is provided by `fake-indexeddb`, the same way the batch-import
 * specs do it, so `restoreFromStorage()` can be exercised for real rather than
 * against a hand-written stub of StorageService.
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
    // The owner's request, stated as the invariant it really is: adjacency,
    // not just "somewhere to the left of".
    expect(canonicalIndex('grade') - canonicalIndex('certNumber')).toBe(1);
  });

  it('still places mintMark directly after year', () => {
    // The pre-existing rule. Inserting certNumber must not have displaced it.
    expect(canonicalIndex('mintMark') - canonicalIndex('year')).toBe(1);
  });

  it('places denomination directly after mintMark', () => {
    // Also the owner's request. Year / Mint Mark / Denomination is how a coin
    // is spoken about and written on a holder -- "1881-S Dollar" -- so the
    // three read together at the left edge of the grid. Denomination was
    // previously stranded between category and country.
    expect(canonicalIndex('denomination') - canonicalIndex('mintMark')).toBe(1);
  });

  it('lists denomination exactly once', () => {
    // The move was a cut-and-paste out of the middle of the list; a leftover
    // would give the grid two Denomination columns.
    expect(inventoryColumnOrder.filter(c => c === 'denomination')).toHaveLength(1);
  });

  it('keeps the first four columns reading as a coin is described', () => {
    // Guards the whole leading group rather than one gap, so a later insertion
    // between any two of them fails here rather than quietly reordering the
    // grid. This also mirrors the first row of the coin editor.
    expect(inventoryColumnOrder.slice(0, 4)).toEqual(
      ['year', 'mintMark', 'denomination', 'coinType']
    );
  });

  it('lists certNumber exactly once', () => {
    // The move was a cut-and-paste; a duplicate would give the grid two Cert
    // columns and the picker two tick boxes.
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
    // A brand new in-memory IndexedDB per test, so one test's saved preference
    // can never leak into the next.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    storage = new StorageService();
    store = new InventoryColumnsStore(storage);
  });

  it('inserts a newly ticked Cert column before Grade, not at the far right', () => {
    // THE BUG THIS LOCKS DOWN.
    // toggleColumn() used to append to the end of the visible list, so ticking
    // "Cert" put it after the last column and the re-order looked broken until
    // the page was reloaded.
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
    // This is the migration question, and the answer is "no migration needed".
    //
    // The preference is persisted as an ORDERED array under one fixed key
    // (StorageKeys.VisibleColumns, no version stamp). A user who had the Cert
    // column switched on before this change therefore has the OLD order sitting
    // in IndexedDB — here, cert stored near the end, after soldPrice.
    //
    // If restoreFromStorage() trusted that order, the saved value would pin the
    // old layout forever and the change would appear not to work for exactly
    // the people who use the app most. It does not: normalizeVisibleColumns()
    // reads the stored array as a SET and sorts it into inventoryColumnOrder.
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
