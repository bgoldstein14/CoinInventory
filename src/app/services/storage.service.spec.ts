import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { StorageKeys, StorageService } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(() => {
    // Swap in a brand-new, empty IndexedDB factory for every test rather
    // than deleting the previous database in place. `StorageService`
    // caches its open connection for its lifetime and never closes it, so
    // a same-name `indexedDB.deleteDatabase()` call would queue behind the
    // still-open connection from the previous test and hang indefinitely
    // (observed as a 5s test timeout). A fresh `IDBFactory` sidesteps that
    // entirely since it shares no state with anything opened before it.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    service = new StorageService();
  });

  it('returns undefined for a key that has never been written', async () => {
    const value = await service.get(StorageKeys.Inventory);
    expect(value).toBeUndefined();
  });

  it('round-trips a simple stored value', async () => {
    // Test with simplified coin-like object (CoinRecord no longer has 'name')
    const coins = [{ id: 'c-001', denomination: 'Quarter', coinType: 'Washington' }];

    await service.set(StorageKeys.Inventory, coins);
    const loaded = await service.get(StorageKeys.Inventory);

    expect(loaded).toEqual(coins);
  });

  it('round-trips a large inventory payload including image data URLs', async () => {
    const largeImage = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
    // CoinRecord no longer has 'name' - use denomination/coinType instead
    const inventory = [
      { id: 'c-001', denomination: 'Double Eagle', coinType: 'Liberty Head', imagePaths: [largeImage] }
    ];

    await service.set(StorageKeys.Inventory, inventory);
    const loaded = await service.get<typeof inventory>(StorageKeys.Inventory);

    expect(loaded).toEqual(inventory);
  });

  it('overwrites a previously stored value', async () => {
    // Column 'name' no longer exists - use 'coinType' instead
    await service.set(StorageKeys.VisibleColumns, ['coinType', 'grade']);
    await service.set(StorageKeys.VisibleColumns, ['coinType']);

    const loaded = await service.get(StorageKeys.VisibleColumns);

    expect(loaded).toEqual(['coinType']);
  });

  it('keeps separate keys independent of one another', async () => {
    await service.set(StorageKeys.Inventory, ['inventory-value']);
    await service.set(StorageKeys.VisibleColumns, ['columns-value']);

    expect(await service.get(StorageKeys.Inventory)).toEqual(['inventory-value']);
    expect(await service.get(StorageKeys.VisibleColumns)).toEqual(['columns-value']);
  });
});
