import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { StorageKeys, StorageService } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(() => {
    // fake-indexeddb persists its in-memory database across tests unless
    // explicitly reset, so each test gets a fresh backing store to avoid
    // bleeding state between assertions.
    indexedDB.deleteDatabase('coin-inventory-db');
    service = new StorageService();
  });

  it('returns undefined for a key that has never been written', async () => {
    const value = await service.get(StorageKeys.Inventory);
    expect(value).toBeUndefined();
  });

  it('round-trips a simple stored value', async () => {
    const coins = [{ id: 'c-001', name: 'Test Coin' }];

    await service.set(StorageKeys.Inventory, coins);
    const loaded = await service.get(StorageKeys.Inventory);

    expect(loaded).toEqual(coins);
  });

  it('round-trips a large inventory payload including image data URLs', async () => {
    const largeImage = `data:image/jpeg;base64,${'A'.repeat(200_000)}`;
    const inventory = [
      { id: 'c-001', name: 'Liberty Head Double Eagle', imagePaths: [largeImage] }
    ];

    await service.set(StorageKeys.Inventory, inventory);
    const loaded = await service.get<typeof inventory>(StorageKeys.Inventory);

    expect(loaded).toEqual(inventory);
  });

  it('overwrites a previously stored value', async () => {
    await service.set(StorageKeys.VisibleColumns, ['name', 'grade']);
    await service.set(StorageKeys.VisibleColumns, ['name']);

    const loaded = await service.get(StorageKeys.VisibleColumns);

    expect(loaded).toEqual(['name']);
  });

  it('keeps separate keys independent of one another', async () => {
    await service.set(StorageKeys.Inventory, ['inventory-value']);
    await service.set(StorageKeys.VisibleColumns, ['columns-value']);

    expect(await service.get(StorageKeys.Inventory)).toEqual(['inventory-value']);
    expect(await service.get(StorageKeys.VisibleColumns)).toEqual(['columns-value']);
  });
});
