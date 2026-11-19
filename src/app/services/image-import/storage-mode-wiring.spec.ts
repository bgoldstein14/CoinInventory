/*
 * storage-mode-wiring.spec.ts
 *
 * The storage-mode setting wired into `applyConfirmedMatches`:
 *   - referenced mode stores no picture and reads no files;
 *   - stored mode stores, passing the user's size budget to the downscaler;
 *   - a referenced import with no folder is refused before writing anything.
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
    // Every path resolves, so the base-folder guard never refuses.
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

    expect(attached[0]).not.toContain('base64');
    expect(sourcePathFromReferenceUrl(attached[0]!)).toBe(
      `D:\\Coin Pictures\\Dollars\\${MORGAN_FILE}`
    );

    // The file was never read.
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
    // The Settings value reached the encoder.
    expect(budgets).toEqual([400 * 1024]);
  });

  it('defaults to storing the picture when nothing has ever been chosen', async () => {
    const { session, inv } = await createSession({});
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    session.folder.set('D:\\Coin Pictures');

    await session.applyConfirmedMatches();

    const [, changes] = updateCoin.mock.calls[0]!;
    expect((changes as { imagePaths: string[] }).imagePaths[0]).toContain('base64');
  });

  it('refuses a referenced import that has nowhere to point', async () => {
    const { session, inv } = await createSession({
      imageStorageMode: 'referenced' as ImageStorageMode
    });
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    session.folder.set('');

    await session.applyConfirmedMatches();

    expect(updateCoin).not.toHaveBeenCalled();
    expect(session.blockedReason()).toContain('folder');
    // ...and the screen is usable again.
    expect(session.busy()).toBe(false);
  });
});
