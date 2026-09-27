/**
 * Tests for choosing and remembering the photo base folder.
 *
 * Three things matter here:
 *
 *  - the PRIORITY ORDER: saved value -> the app's folder from the server -> ''.
 *    The owner's requirement was "start out from the app folder and then
 *    memorize subsequent choices", so the saved value must win every time; a
 *    regression there would silently overwrite the user's setting with the
 *    program folder on every import.
 *  - that the value comes back next time at all (otherwise the user retypes a
 *    long path on every import).
 *  - that saving it does not clobber the other preferences sharing the same
 *    storage key — a bug that would silently reset the user's settings.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSettings } from '../../features/app-settings';
import { StorageService, StorageKeys } from '../storage.service';
import { loadImportBaseFolder, saveImportBaseFolder } from './import-base-folder';

/** Stands in for `GET /api/app-info` answering with the app's own folder. */
const appFolderIs = (folder: string) => vi.fn(() => Promise.resolve(folder));

describe('import base folder persistence', () => {
  let storage: StorageService;

  beforeEach(() => {
    // A fresh in-memory IndexedDB per test, and a fresh StorageService so it
    // does not hold a connection to the previous one.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    storage = new StorageService();
  });

  it('falls back to empty when nothing is saved and no app folder is available', async () => {
    // No provider at all — the pre-existing behaviour, and what a session built
    // without an ApiService still does.
    await expect(loadImportBaseFolder(storage)).resolves.toBe('');
  });

  it('persists the base folder and reloads it', async () => {
    await saveImportBaseFolder(storage, '\\\\nas\\Photos\\Coins');

    // A second StorageService instance, to prove the value really went to
    // storage rather than being held in a field somewhere.
    await expect(loadImportBaseFolder(new StorageService()))
      .resolves.toBe('\\\\nas\\Photos\\Coins');
  });

  it('leaves the other app settings alone when saving', async () => {
    // StorageKeys.AppSettings is ONE shared object. Writing a freshly built
    // object rather than merging is how the user's "show transactions" choice
    // would silently disappear the first time he ran an import.
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

    // Whitespace would silently mean "record no paths at all", so it is treated
    // as absent rather than honoured.
    await expect(loadImportBaseFolder(storage)).resolves.toBe('');
  });

  /* =====================================================================
   * The app folder as the FALLBACK default
   * =====================================================================
   * "The import base folder should always start out from the app folder and
   * then memorize subsequent choices as the next base folder." These are the
   * two halves of that sentence, plus the failure case.
   * =================================================================== */

  it('uses the app folder from the server when nothing has been saved', async () => {
    const appFolder = appFolderIs('D:\\CoinInventory');

    await expect(loadImportBaseFolder(storage, appFolder)).resolves.toBe('D:\\CoinInventory');
    expect(appFolder).toHaveBeenCalledTimes(1);
  });

  it('lets a SAVED value win over the app folder, and does not even ask', async () => {
    // *** The most important test in this file. ***
    //
    // This is the "memorize subsequent choices" half of the requirement. Once
    // the user has said where their photos are, the app's own install folder is
    // irrelevant, and letting it win would reset their setting on every import.
    // The provider is asserted NOT to be called at all, because the saved value
    // short-circuits before the request is made — which is also why opening the
    // import screen normally costs no extra round trip.
    await saveImportBaseFolder(storage, 'E:\\My Coin Photos');
    const appFolder = appFolderIs('D:\\CoinInventory');

    await expect(loadImportBaseFolder(storage, appFolder)).resolves.toBe('E:\\My Coin Photos');
    expect(appFolder).not.toHaveBeenCalled();
  });

  it('degrades to empty when the app-info request fails, rather than throwing', async () => {
    // ApiService.getAppFolder() is built never to error, so this should not
    // happen — but if it ever does, the import screen must still open. An empty
    // box is a state the screen already handles with a visible warning; an
    // exception here would take the whole modal down over a cosmetic default.
    const failing = vi.fn(() => Promise.reject(new Error('backend unreachable')));

    await expect(loadImportBaseFolder(storage, failing)).resolves.toBe('');
  });

  it('degrades to empty when the server answers with a blank or whitespace folder', async () => {
    // What getAppFolder() actually emits on failure is '', so this is the
    // realistic unreachable-backend path.
    await expect(loadImportBaseFolder(storage, appFolderIs(''))).resolves.toBe('');
    await expect(loadImportBaseFolder(storage, appFolderIs('   '))).resolves.toBe('');
  });

  it('trims the server\'s answer before using it', async () => {
    // The value is joined onto webkitRelativePath with a single backslash, so
    // stray whitespace would end up inside a stored path.
    await expect(loadImportBaseFolder(storage, appFolderIs('  D:\\App  ')))
      .resolves.toBe('D:\\App');
  });

  it('still uses the app folder when there is no storage at all', async () => {
    // A session constructed without StorageService (which is how some unit
    // tests build it) can no longer remember anything, but it can still be
    // given a sensible starting point.
    await expect(loadImportBaseFolder(undefined, appFolderIs('D:\\CoinInventory')))
      .resolves.toBe('D:\\CoinInventory');
  });
});
