/**
 * Tests for remembering the photo base folder: saved value or '', a cleared
 * value stays cleared, and saving doesn't clobber other preferences.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettings } from '../../features/app-settings';
import { StorageService, StorageKeys } from '../storage.service';
import { loadImportBaseFolder, saveImportBaseFolder } from './import-base-folder';


describe('import base folder persistence', () => {
  let storage: StorageService;

  beforeEach(() => {
    // Fresh in-memory IndexedDB and StorageService per test.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    storage = new StorageService();
  });

  it('persists the base folder and reloads it', async () => {
    await saveImportBaseFolder(storage, '\\\\nas\\Photos\\Coins');

    // A second StorageService proves the value was persisted.
    await expect(loadImportBaseFolder(new StorageService()))
      .resolves.toBe('\\\\nas\\Photos\\Coins');
  });

  it('leaves the other app settings alone when saving', async () => {
    // StorageKeys.AppSettings is one shared object; writes must merge.
    await storage.set<AppSettings>(StorageKeys.AppSettings, {
      showTransactionsInDetails: true
    });

    await saveImportBaseFolder(storage, 'C:\\Pics');

    const settings = await storage.get<AppSettings>(StorageKeys.AppSettings);
    expect(settings?.showTransactionsInDetails).toBe(true);
    expect(settings?.imageImportBaseFolder).toBe('C:\\Pics');
  });

  it('ignores a saved value that is blank or the wrong type', async () => {
    await storage.set<AppSettings>(StorageKeys.AppSettings, {
      showTransactionsInDetails: false,
      imageImportBaseFolder: '   '
    });

    // Whitespace is treated as absent.
    await expect(loadImportBaseFolder(storage)).resolves.toBe('');
  });

  // No fallback to the app folder (see import-base-folder.ts).

  it('starts empty when nothing has ever been saved', async () => {
    await expect(loadImportBaseFolder(storage)).resolves.toBe('');
  });

  it('keeps a deliberately cleared folder cleared', async () => {
    await saveImportBaseFolder(storage, 'D:\\Coin Pictures');
    await expect(loadImportBaseFolder(storage)).resolves.toBe('D:\\Coin Pictures');

    await saveImportBaseFolder(storage, '');

    await expect(loadImportBaseFolder(storage)).resolves.toBe('');
  });

  it('starts empty when there is no storage at all', async () => {
    await expect(loadImportBaseFolder(undefined)).resolves.toBe('');
  });

  it('survives storage throwing, rather than taking the modal down with it', async () => {
    const broken = {
      get: () => Promise.reject(new Error('IndexedDB unavailable'))
    } as unknown as StorageService;

    await expect(loadImportBaseFolder(broken)).resolves.toBe('');
  });
});
