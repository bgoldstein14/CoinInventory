/**
 * Tests for choosing and remembering the photo base folder.
 *
 * Three things matter here:
 *
 *  - the PRIORITY ORDER, which is now simply: saved value -> ''. There used to
 *    be a rung between them (the app's own install folder, from the server);
 *    it was removed after causing a real data bug, and the block comment
 *    further down explains why in full.
 *  - that the value comes back next time at all (otherwise the user retypes a
 *    long path on every import) — and that a CLEARED value stays cleared.
 *  - that saving it does not clobber the other preferences sharing the same
 *    storage key — a bug that would silently reset the user's settings.
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
   * THERE IS NO APP-FOLDER FALLBACK ANY MORE, AND THAT IS THE POINT
   * =====================================================================
   * The original requirement was "start out from the app folder and then
   * memorize subsequent choices", and this file used to have six tests
   * pinning that behaviour. It was removed after it caused a real data bug
   * twice in one day: the owner imported a folder and every row was stamped
   * under his development directory, because the box was still holding that
   * seed. A plausible-looking path that is never correct is worse than a
   * blank one, because nobody checks it.
   *
   * The tests below pin the REPLACEMENT behaviour, including the sneaky
   * second-order bug the old fallback caused.
   * =================================================================== */

  it('starts empty when nothing has ever been saved', async () => {
    await expect(loadImportBaseFolder(storage)).resolves.toBe('');
  });

  /**
   * *** The regression test for the "it keeps coming back" complaint. ***
   *
   * An empty saved value used to be read as "nothing saved", which fell
   * through to the app folder. So CLEARING THE BOX — exactly what a user does
   * on noticing the path is wrong — brought the wrong path straight back on
   * the next open. A cleared box must stay cleared.
   */
  it('keeps a deliberately cleared folder cleared', async () => {
    await saveImportBaseFolder(storage, 'D:\\Coin Pictures');
    await expect(loadImportBaseFolder(storage)).resolves.toBe('D:\\Coin Pictures');

    await saveImportBaseFolder(storage, '');

    await expect(loadImportBaseFolder(storage)).resolves.toBe('');
  });

  it('starts empty when there is no storage at all', async () => {
    // A session built without StorageService (which is how some unit tests
    // construct it) simply cannot remember anything. Empty, not a guess.
    await expect(loadImportBaseFolder(undefined)).resolves.toBe('');
  });

  it('survives storage throwing, rather than taking the modal down with it', async () => {
    const broken = {
      get: () => Promise.reject(new Error('IndexedDB unavailable'))
    } as unknown as StorageService;

    await expect(loadImportBaseFolder(broken)).resolves.toBe('');
  });
});
