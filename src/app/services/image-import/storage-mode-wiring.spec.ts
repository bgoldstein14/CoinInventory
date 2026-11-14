/*
 * storage-mode-wiring.spec.ts
 *
 * image-storage-settings.spec.ts proves the SETTING is read and written
 * correctly. referenced-encoder.spec.ts proves one photo turns into the
 * right thing. This file proves the setting is actually WIRED to the import
 * — that `applyConfirmedMatches` consults it, and that what reaches
 * `updateCoin` differs between the two modes.
 *
 * That separation is the same one base-folder-guard-wiring.spec.ts makes,
 * and for the same reason: a correctly-read setting that nothing acts on
 * looks exactly like a working feature until someone opens the database.
 *
 * WHAT IS BEING PROTECTED
 *   - referenced mode must not put a picture in the database;
 *   - referenced mode must not READ the files either (that is the speed, and
 *     the only observable difference on a 4 GB share);
 *   - stored mode must still store, and must pass the user's size budget to
 *     the downscaler;
 *   - a referenced import with no folder to point at must be refused
 *     outright rather than writing rows that point nowhere.
 */

import 'fake-indexeddb/auto';
import '@angular/compiler';
import { IDBFactory } from 'fake-indexeddb';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { InventoryService } from '../inventory.service';
import { ImageMatchingService } from '../image-matching.service';
import { BatchImageImportService } from '../batch-image-import.service';
import { ImageDownscaleService } from './image-downscaler';
import { BatchImportSession } from './batch-import-session';
import { ApiService } from '../api.service';
import { StorageService } from '../storage.service';
import { createTestInventoryService } from '../../testing/test-helpers';
import { CoinRecord } from '../../types/coin.model';
import { AppSettings } from '../../features/app-settings';
import { StorageKeys } from '../storage.service';
import { sourcePathFromReferenceUrl } from './reference-url';
import type { ImageStorageMode } from './image-storage-settings';

/** A File as a directory picker produces it. */
function pickedFile(name: string, relativePath: string): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

const MORGAN_FILE = '1881-S Morgan Dollar - Obverse.jpg';

async function createSession(settings: Partial<AppSettings>) {
  const storage = new StorageService();
  await storage.set<AppSettings>(StorageKeys.AppSettings, {
    showTransactionsInDetails: false,
    ...settings
  });

  const { inv } = createTestInventoryService();

  /** Stands in for the <canvas>, and records the budget it was handed. */
  const budgets: number[] = [];
  const downscaler = {
    downscaleWithin: vi.fn(async (file: File, maxStoredBytes: number) => {
      budgets.push(maxStoredBytes);
      return {
        result: {
          dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
          width: 1600,
          height: 1200,
          originalBytes: file.size,
          storedBytes: 250_000,
          resized: true
        },
        attempt: { maxEdge: 1600, quality: 0.85 },
        attempts: 1,
        overBudget: false
      };
    })
  } as unknown as ImageDownscaleService;

  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useClass: ImageMatchingService },
      { provide: ImageDownscaleService, useValue: downscaler },
      { provide: BatchImageImportService, useClass: BatchImageImportService }
    ]
  });

  const api = {
    getAppFolder: () => of(''),
    // Every path this import would record resolves, so the base-folder guard
    // is not the thing refusing anything below.
    checkImagesExist: (paths: string[]) =>
      of({ results: Object.fromEntries(paths.map(p => [p, true])) }),
    imageFileUrl: (path: string) =>
      `http://localhost:3000/api/images/file?path=${encodeURIComponent(path)}`
  } as unknown as ApiService;

  const session = runInInjectionContext(
    injector,
    () =>
      new BatchImportSession(
        inv,
        injector.get(ImageMatchingService),
        injector.get(BatchImageImportService),
        storage,
        api
      )
  );

  inv.inventory.set([
    {
      id: 'morgan',
      coinType: 'Morgan',
      denomination: 'Dollar',
      year: '1881',
      mintMark: 'S',
      imagePaths: [],
      imageCount: 0
    } as unknown as CoinRecord
  ]);

  await session.handleDirectorySelection({
    target: { files: [pickedFile(MORGAN_FILE, `Dollars/${MORGAN_FILE}`)], value: '' }
  } as unknown as Event);

  return { session, inv, downscaler, budgets };
}

describe('applyConfirmedMatches — the storage mode', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('attaches a REFERENCE, not a picture, when the user chose referenced', async () => {
    const { session, inv, downscaler } = await createSession({
      imageStorageMode: 'referenced' as ImageStorageMode
    });
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    session.folder.set('D:\\Coin Pictures');

    await session.applyConfirmedMatches();

    expect(updateCoin).toHaveBeenCalledOnce();
    const [, changes] = updateCoin.mock.calls[0]!;
    const attached = (changes as { imagePaths: string[] }).imagePaths;

    // THE MUTATION THIS CATCHES: storing the downscaled picture anyway.
    expect(attached[0]).not.toContain('base64');
    expect(sourcePathFromReferenceUrl(attached[0]!)).toBe(
      `D:\\Coin Pictures\\Dollars\\${MORGAN_FILE}`
    );

    // And the file was never read, which is the whole point of the mode.
    expect(downscaler.downscaleWithin).not.toHaveBeenCalled();
    expect(session.summary()?.storedBytes).toBe(0);
  });

  it('stores the picture, at the user\'s budget, when the user chose stored', async () => {
    const { session, inv, budgets } = await createSession({
      imageStorageMode: 'stored' as ImageStorageMode,
      maxStoredImageBytes: 400 * 1024
    });
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    session.folder.set('D:\\Coin Pictures');

    await session.applyConfirmedMatches();

    const [, changes] = updateCoin.mock.calls[0]!;
    expect((changes as { imagePaths: string[] }).imagePaths[0]).toContain('base64');
    // The Settings value reached the encoder rather than a hardcoded one.
    expect(budgets).toEqual([400 * 1024]);
  });

  it('defaults to storing the picture when nothing has ever been chosen', async () => {
    // A fresh install must behave exactly as the app always has.
    const { session, inv } = await createSession({});
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    session.folder.set('D:\\Coin Pictures');

    await session.applyConfirmedMatches();

    const [, changes] = updateCoin.mock.calls[0]!;
    expect((changes as { imagePaths: string[] }).imagePaths[0]).toContain('base64');
  });

  it('refuses a referenced import that has nowhere to point', async () => {
    /* A referenced row with no path is a photograph with neither a picture
     * nor a location — thrown away. The run is refused before any coin is
     * touched, and the screen says why. */
    const { session, inv } = await createSession({
      imageStorageMode: 'referenced' as ImageStorageMode
    });
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    session.folder.set('');

    await session.applyConfirmedMatches();

    expect(updateCoin).not.toHaveBeenCalled();
    expect(session.blockedReason()).toContain('folder');
    // ...and the screen is usable again rather than stuck busy.
    expect(session.busy()).toBe(false);
  });
});
