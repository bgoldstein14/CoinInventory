 /*
 * existing-photo-wiring.spec.ts
 *
 * existing-photo-mode.spec.ts proves the DECISION is right and
 * existing-photo-attach.spec.ts proves the attach runner OBEYS it. This file
 * proves the two are actually joined up to the screen: that the question is
 * only asked when it means something, that its counts are real, that the
 * destructive answer is confirmed before anything is deleted, and that the
 * bulk source-path lookup happens exactly when it is needed and never when it
 * is not.
 *
 * That separation is the same one base-folder-guard-wiring.spec.ts draws, and
 * for the same reason: the original base-folder bug was not a wrong decision,
 * it was a correct decision nothing acted on.
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
    // Every path resolves, so the base-folder guard never refuses and these
    // tests are only ever exercising the new code.
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

/* =========================================================================
 * WHEN THE QUESTION IS ASKED AT ALL
 * ======================================================================= */

describe('the three-way choice is offered only when it is relevant', () => {
  it('is hidden when no matched coin has photos', async () => {
    // A question with no meaning trains people to stop reading the ones that
    // do have meaning. Importing into a fresh inventory must look exactly as
    // it always did.
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
    // Only the Morgan is being imported for; the Peace dollar's photos are
    // none of this import's business.
    await selectFiles(session, [MORGAN_FILE]);

    expect(session.existingPhotoChoiceVisible()).toBe(false);
  });
});

/* =========================================================================
 * THE COUNTS
 * ======================================================================= */

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
    // The numbers describe the IMPORT, not the current answer. If choosing
    // "Leave them alone" rewrote them to "0 of 1", the sentence offering the
    // choice would destroy itself and the user could never get back to it.
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

/* =========================================================================
 * THE DEFAULT
 * ======================================================================= */

describe('"Leave them alone" is the default and it really leaves them alone', () => {
  it('starts on "leave"', async () => {
    const { session } = createSession();
    expect(session.existingPhotoMode()).toBe('leave');
  });

  it('counts only the coins with no photos in the Save button total', async () => {
    // The Save button must not promise to import 2 photos and import 1.
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
    // Under "leave" the coins with photos are not written to at all, so there
    // is nothing to compare against and no reason to pay for the round trip.
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

/* =========================================================================
 * THE DESTRUCTIVE ANSWER
 * ======================================================================= */

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
    // Not even the coin with no photos, which would have been safe: a
    // cancelled import is a cancelled import, and a half-done one the user
    // did not ask for is its own surprise.
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
    // "Replace" with nothing to replace deletes nothing, so there is nothing
    // to warn about. A confirmation that fires when it need not is how people
    // learn to click through the ones that matter.
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

/* =========================================================================
 * "KEEP BOTH" AND THE BULK LOOKUP
 * ======================================================================= */

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
    // THE HEADLINE REGRESSION, end to end: the folder is re-picked, the file
    // is already recorded against the coin, and nothing must be written.
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
    // FAILS OPEN, like the base-folder check does. A diagnostic endpoint
    // hiccup must not silently drop photos the user asked for.
    const { session, inv } = createSession('throw');
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('add');

    await session.applyConfirmedMatches();

    expect(inv.inventory().find(c => c.id === 'morgan')!.imagePaths).toHaveLength(2);
    expect(session.blockedReason()).toBeNull();
  });
});

/* =========================================================================
 * RESET
 * ======================================================================= */

describe('reset', () => {
  it('puts the answer back to the safe default', async () => {
    // Picking a new folder after a replace import must not carry the
    // destructive answer silently into the next run.
    const { session, inv } = createSession();
    seedCoins(inv, ['data:image/jpeg;base64,A'], []);
    await selectFiles(session, [MORGAN_FILE]);
    session.existingPhotoMode.set('replace');

    session.reset();

    expect(session.existingPhotoMode()).toBe('leave');
  });
});
