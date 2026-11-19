 /*
 * import-without-loaded-photos.spec.ts
 *
 * The batch photo import against coins as `GET /api/coins` returns them: an
 * `imageCount` and no `imagePaths` (the list endpoint doesn't inline photos;
 * see server/routes/coins/list-query.ts). This is the usual state at startup.
 *
 * The existing-photo question and the 'leave' mode must work from
 * `imageCount`, and 'add' must fetch the existing photos, because PUT replaces
 * the whole image set and an empty "existing" half would delete them.
 * existing-photo-wiring.spec.ts covers coins whose photos are loaded.
  */

import 'fake-indexeddb/auto';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { InventoryService } from '../inventory.service';
import { ImageMatchingService } from '../image-matching.service';
import { BatchImageImportService } from '../batch-image-import.service';
import { ImageDownscaleService } from './image-downscaler';
import { BatchImportSession } from './batch-import-session';
import { ApiService } from '../api.service';
import { StorageService } from '../storage.service';
import { createTestInventoryService } from '../../testing/test-helpers';
import { CoinRecord } from '../../types/coin.model';
import { CoinImageRecord } from '../../types/coin-image.model';

const BASE = 'D:\\Coin Pictures';
const MORGAN_FILE = '1881-S Morgan Dollar - Obverse.jpg';
const PEACE_FILE = '1922 Peace Dollar - Obverse.jpg';

const OLD_PHOTO = 'data:image/jpeg;base64,OLD-MORGAN';

const stubEncoder = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 500
});

function pickedFile(name: string, relativePath: string): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

/**
 * Two coins as `GET /api/coins` returns them: counts, and no imagePaths key
 * (deleted explicitly so the property is truly absent).
 */
function seedListLoadedCoins(inv: InventoryService, morganCount: number, peaceCount = 0) {
  const make = (fields: Record<string, unknown>, imageCount: number) => {
    const coin = { ...fields, imageCount } as Record<string, unknown>;
    delete coin['imagePaths'];
    return coin as unknown as CoinRecord;
  };

  inv.inventory.set([
    make({ id: 'morgan', coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' }, morganCount),
    make({ id: 'peace', coinType: 'Peace', denomination: 'Dollar', year: '1922', mintMark: '' }, peaceCount)
  ]);
}

function createSession(options: { coinImages?: unknown } = {}) {
  const harness = createTestInventoryService();
  const inv = harness.inv;

  const getCoinImages = vi.fn(() => (options.coinImages ?? of([
    { imageId: 1, imageData: OLD_PHOTO, sourcePath: null, sortOrder: 0 } as CoinImageRecord
  ])) as never);
  (harness.mockApiService as unknown as Record<string, unknown>)['getCoinImages'] = getCoinImages;

  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useClass: ImageMatchingService },
      { provide: ImageDownscaleService, useValue: {} as ImageDownscaleService },
      { provide: BatchImageImportService, useClass: BatchImageImportService }
    ]
  });

  const api = {
    getAppFolder: () => of(''),
    checkImagesExist: (paths: string[]) =>
      of({ results: Object.fromEntries(paths.map(p => [p, true])) }),
    getCoinImageSourcePaths: (coinIds: string[]) =>
      of({ results: Object.fromEntries(coinIds.map(id => [id, [] as string[]])) })
  } as unknown as ApiService;

  const session = runInInjectionContext(injector, () => new BatchImportSession(
    inv,
    injector.get(ImageMatchingService),
    injector.get(BatchImageImportService),
    undefined as unknown as StorageService,
    api
  ));
  session.encoder = stubEncoder;
  session.folder.set(BASE);

  const updateCoin = vi.spyOn(inv, 'updateCoin');
  return { session, inv, getCoinImages, updateCoin };
}

async function selectFiles(session: BatchImportSession, names: string[]) {
  const files = names.map(n => pickedFile(n, `Dollars/${n}`));
  await session.handleDirectorySelection(
    { target: { files, value: '' } } as unknown as Event
  );
}

function stubConfirm(answer: boolean) {
  const spy = vi.fn(() => answer);
  (globalThis as unknown as { confirm?: unknown }).confirm = spy;
  return spy;
}

afterEach(() => {
  delete (globalThis as unknown as { confirm?: unknown }).confirm;
});

describe('the "already has photos" question, for coins straight off the list', () => {
  it('is still asked, from imageCount alone', async () => {
    const { session, inv } = createSession();
    seedListLoadedCoins(inv, 2, 0);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    // The counts come from the list; nothing is fetched.
    expect(session.existingPhotoChoiceVisible()).toBe(true);
    expect(session.existingPhotoCounts().coinsWithPhotos).toBe(1);
    expect(session.existingPhotoCounts().coinsWithoutPhotos).toBe(1);
  });

  it('counts the photographs themselves, not just the coins', async () => {
    const { session, inv } = createSession();
    seedListLoadedCoins(inv, 5, 0);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    expect(session.existingPhotoCounts().existingPhotos).toBe(5);
  });

  it('is not asked when the list says no matched coin has any', async () => {
    const { session, inv } = createSession();
    seedListLoadedCoins(inv, 0, 0);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    expect(session.existingPhotoChoiceVisible()).toBe(false);
  });
});

describe('"Keep both", for coins straight off the list', () => {
  it('fetches the existing photographs and KEEPS them', async () => {
    const { session, inv, getCoinImages, updateCoin } = createSession();
    seedListLoadedCoins(inv, 1, 0);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(getCoinImages).toHaveBeenCalledWith('morgan');

    const morganWrite = updateCoin.mock.calls.find(call => call[0] === 'morgan');
    expect(morganWrite).toBeDefined();
    const imagePaths = (morganWrite![1] as { imagePaths?: string[] }).imagePaths;

    // The old photo must be in the saved array, or PUT would delete it.
    expect(imagePaths).toContain(OLD_PHOTO);
    expect(imagePaths).toContain(`data:image/jpeg;base64,SHRUNK-${MORGAN_FILE}`);
  });

  it('writes NOTHING to a coin whose photographs cannot be fetched', async () => {
    const { session, inv, updateCoin } = createSession({
      coinImages: throwError(() => new Error('backend down'))
    });
    seedListLoadedCoins(inv, 3, 0);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(updateCoin).not.toHaveBeenCalled();
    // Reported to the user as a failure.
    expect(session.summary()?.failures.length ?? 0).toBeGreaterThan(0);
  });

  it('makes no fetch at all for a coin the list says has none', async () => {
    const { session, inv, getCoinImages, updateCoin } = createSession();
    seedListLoadedCoins(inv, 0, 0);
    await selectFiles(session, [PEACE_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(getCoinImages).not.toHaveBeenCalled();
    const peaceWrite = updateCoin.mock.calls.find(call => call[0] === 'peace');
    expect((peaceWrite![1] as { imagePaths?: string[] }).imagePaths)
      .toEqual([`data:image/jpeg;base64,SHRUNK-${PEACE_FILE}`]);
  });
});

describe('"Replace", for coins straight off the list', () => {
  it('still confirms before deleting photographs it has never seen', async () => {
    // The confirmation is driven by the imageCount-based counts.
    const confirm = stubConfirm(false);
    const { session, inv, updateCoin } = createSession();
    seedListLoadedCoins(inv, 4, 0);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('replace');

    await session.applyConfirmedMatches();

    expect(confirm).toHaveBeenCalled();
    expect(updateCoin).not.toHaveBeenCalled();
  });

  it('deletes without a pointless fetch once confirmed', async () => {
    stubConfirm(true);
    const { session, inv, getCoinImages, updateCoin } = createSession();
    seedListLoadedCoins(inv, 4, 0);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('replace');

    await session.applyConfirmedMatches();

    // 'replace' discards the old photos, so there is nothing to fetch.
    expect(getCoinImages).not.toHaveBeenCalled();
    const morganWrite = updateCoin.mock.calls.find(call => call[0] === 'morgan');
    expect((morganWrite![1] as { imagePaths?: string[] }).imagePaths)
      .toEqual([`data:image/jpeg;base64,SHRUNK-${MORGAN_FILE}`]);
  });
});
