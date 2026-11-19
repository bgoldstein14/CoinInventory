 /*
 * existing-photo-wiring.spec.ts
 *
 * The existing-photo mode wired into the import session: when the question
 * is shown, its counts, confirmation before "replace" deletes anything, and
 * when the bulk source-path lookup runs.
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

const BASE = 'D:\\Coin Pictures';

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
 * A session wired to a stub backend.
 *
 * @param sourcePaths what POST /api/coins/image-source-paths should answer,
 *                    or 'throw' to simulate the endpoint being unreachable.
 */
function createSession(sourcePaths: Record<string, string[]> | 'throw' = {}) {
  const { inv } = createTestInventoryService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useClass: ImageMatchingService },
      { provide: ImageDownscaleService, useValue: {} as ImageDownscaleService },
      { provide: BatchImageImportService, useClass: BatchImageImportService }
    ]
  });

  const getCoinImageSourcePaths = vi.fn((coinIds: string[]) => {
    if (sourcePaths === 'throw') return throwError(() => new Error('backend down'));
    const results: Record<string, string[]> = {};
    for (const id of coinIds) results[id] = sourcePaths[id] ?? [];
    return of({ results });
  });

  const api = {
    getAppFolder: () => of(''),
    // Every path resolves, so the base-folder guard never refuses.
    checkImagesExist: (paths: string[]) =>
      of({ results: Object.fromEntries(paths.map(p => [p, true])) }),
    getCoinImageSourcePaths
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
  return { session, inv, getCoinImageSourcePaths };
}

const MORGAN_FILE = '1881-S Morgan Dollar - Obverse.jpg';
const PEACE_FILE = '1922 Peace Dollar - Obverse.jpg';

function seedCoins(inv: InventoryService, morganPhotos: string[], peacePhotos: string[] = []) {
  inv.inventory.set([
    {
      id: 'morgan', coinType: 'Morgan', denomination: 'Dollar',
      year: '1881', mintMark: 'S', imagePaths: morganPhotos
    } as unknown as CoinRecord,
    {
      id: 'peace', coinType: 'Peace', denomination: 'Dollar',
      year: '1922', mintMark: '', imagePaths: peacePhotos
    } as unknown as CoinRecord
  ]);
}

async function selectFiles(session: BatchImportSession, names: string[]) {
  const files = names.map(n => pickedFile(n, `Dollars/${n}`));
  await session.handleDirectorySelection(
    { target: { files, value: '' } } as unknown as Event
  );
}

/** Install a window.confirm answer for confirmAction() to find. */
function stubConfirm(answer: boolean) {
  const spy = vi.fn(() => answer);
  (globalThis as unknown as { confirm?: unknown }).confirm = spy;
  return spy;
}

afterEach(() => {
  // confirmAction() treats a missing confirm as "yes", which is the state the
  // rest of the suite expects.
  delete (globalThis as unknown as { confirm?: unknown }).confirm;
});

describe('the three-way choice is offered only when it is relevant', () => {
  it('is hidden when no matched coin has photos', async () => {
    const { session, inv } = createSession();
    seedCoins(inv, [], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    expect(session.existingPhotoChoiceVisible()).toBe(false);
  });

  it('appears as soon as one matched coin has photos', async () => {
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,OLD'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    expect(session.existingPhotoChoiceVisible()).toBe(true);
  });

  it('ignores photos on coins this import is not touching', async () => {
    const { session, inv } = createSession();
    seedCoins(inv, [], ['data:image/jpeg;base64,OLD']);
    // Only the Morgan is in this import.
    await selectFiles(session, [MORGAN_FILE]);

    expect(session.existingPhotoChoiceVisible()).toBe(false);
  });
});

describe('the counts in the question are real', () => {
  it('reports the coins, the ones with photos, the ones without, and the photos', async () => {
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A', 'data:image/jpeg;base64,B'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    expect(session.existingPhotoCounts()).toEqual({
      matchedCoins: 2,
      coinsWithPhotos: 1,
      coinsWithoutPhotos: 1,
      existingPhotos: 2
    });
  });

  it('does not change when the user picks a different answer', async () => {
    // The counts describe the import, not the chosen answer.
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    const before = session.existingPhotoCounts();
    session.existingPhotoMode.set('leave');
    expect(session.existingPhotoCounts()).toEqual(before);
    session.existingPhotoMode.set('replace');
    expect(session.existingPhotoCounts()).toEqual(before);
  });

  it('tracks the tick boxes', async () => {
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    expect(session.existingPhotoCounts().matchedCoins).toBe(2);
    session.toggleImage(MORGAN_FILE);
    expect(session.existingPhotoCounts().matchedCoins).toBe(1);
    expect(session.existingPhotoCounts().coinsWithPhotos).toBe(0);
  });
});

describe('"Leave them alone" is the default and it really leaves them alone', () => {
  it('starts on "leave"', async () => {
    const { session } = createSession();
    expect(session.existingPhotoMode()).toBe('leave');
  });

  it('counts only the coins with no photos in the Save button total', async () => {
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    expect(session.attachCount()).toBe(1);
    session.existingPhotoMode.set('add');
    expect(session.attachCount()).toBe(2);
  });

  it('writes nothing to the coin that already has photos', async () => {
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    await session.applyConfirmedMatches();

    expect(updateCoin).toHaveBeenCalledTimes(1);
    expect(updateCoin.mock.calls[0][0]).toBe('peace');
  });

  it('does not ask the backend for source paths it will not use', async () => {
    const { session, inv, getCoinImageSourcePaths } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    await session.applyConfirmedMatches();

    expect(getCoinImageSourcePaths).not.toHaveBeenCalled();
  });

  it('asks nothing and deletes nothing', async () => {
    const confirmSpy = stubConfirm(true);
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);

    await session.applyConfirmedMatches();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(inv.inventory().find(c => c.id === 'morgan')!.imagePaths)
      .toEqual(['data:image/jpeg;base64,A']);
  });
});

describe('"Replace what they have" is confirmed before anything is deleted', () => {
  it('asks, naming the number of photos about to go', async () => {
    const confirmSpy = stubConfirm(true);
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A', 'data:image/jpeg;base64,B'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);
    session.existingPhotoMode.set('replace');

    await session.applyConfirmedMatches();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain('2 photos');
  });

  it('writes NOTHING when the confirmation is declined', async () => {
    const confirmSpy = stubConfirm(false);
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);
    session.existingPhotoMode.set('replace');

    await session.applyConfirmedMatches();

    expect(confirmSpy).toHaveBeenCalled();
    // Not even the coin with no photos: cancelling cancels the whole import.
    expect(updateCoin).not.toHaveBeenCalled();
  });

  it('leaves the screen usable after a declined confirmation', async () => {
    stubConfirm(false);
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('replace');

    await session.applyConfirmedMatches();

    expect(session.progress()).toBeNull();
    expect(session.busy()).toBe(false);
    expect(session.summary()).toBeNull();
  });

  it('replaces the coin s photos once confirmed', async () => {
    stubConfirm(true);
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('replace');

    await session.applyConfirmedMatches();

    expect(inv.inventory().find(c => c.id === 'morgan')!.imagePaths)
      .toEqual([`data:image/jpeg;base64,SHRUNK-${MORGAN_FILE}`]);
  });

  it('does not ask when no matched coin has photos', async () => {
    const confirmSpy = stubConfirm(true);
    const { session, inv } = createSession();
    seedCoins(inv, [], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);
    session.existingPhotoMode.set('replace');

    await session.applyConfirmedMatches();

    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('does not ask for "Keep both"', async () => {
    const confirmSpy = stubConfirm(true);
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('"Keep both" skips files that are already on the coin', () => {
  it('asks the backend only about the coins that already have photos', async () => {
    const { session, inv, getCoinImageSourcePaths } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE, PEACE_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(getCoinImageSourcePaths).toHaveBeenCalledTimes(1);
    expect(getCoinImageSourcePaths.mock.calls[0][0]).toEqual(['morgan']);
  });

  it('does not re-attach a file the coin already has', async () => {
    // Re-picked folder; the file is already recorded against the coin.
    const { session, inv } = createSession({
      morgan: [`D:\\Coin Pictures\\Dollars\\${MORGAN_FILE}`]
    });
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(updateCoin).not.toHaveBeenCalled();
    expect(session.summary()!.attached).toBe(0);
  });

  it('still attaches a file that is genuinely new', async () => {
    const { session, inv } = createSession({
      morgan: ['D:\\Coin Pictures\\Dollars\\something else.jpg']
    });
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(inv.inventory().find(c => c.id === 'morgan')!.imagePaths).toEqual([
      'data:image/jpeg;base64,A',
      `data:image/jpeg;base64,SHRUNK-${MORGAN_FILE}`
    ]);
  });

  it('imports everything when the lookup fails', async () => {
    // Fails open.
    const { session, inv } = createSession('throw');
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(inv.inventory().find(c => c.id === 'morgan')!.imagePaths).toHaveLength(2);
    expect(session.blockedReason()).toBeNull();
  });
});

describe('reset', () => {
  it('puts the answer back to the safe default', async () => {
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('replace');

    session.reset();

    expect(session.existingPhotoMode()).toBe('leave');
  });
});
