/* ===========================================================================
 * base-folder-guard-wiring.spec.ts
 * ---------------------------------------------------------------------------
 * base-folder-check.spec.ts proves the DECISION is right. This file proves the
 * decision is actually WIRED to the import — that `applyConfirmedMatches`
 * consults it, and that a refusal really does stop the database write.
 *
 * The two are worth separating because the original bug was not a wrong
 * decision. The screen already computed and displayed the exact wrong path it
 * was about to store; the preview was simply advisory, and the import went
 * ahead anyway. A check nothing acts on is the bug, not the fix, so the
 * assertion that matters here is `updateCoin` NOT being called.
 *
 * The ordering assertion matters just as much. `progress` must still be set
 * synchronously on the click's own tick — that is the fix for the separate
 * double-import bug, where a dead-looking screen got clicked twice and wrote
 * every photo twice — so the guard had to be inserted AFTER that write rather
 * than before it. A test pins that, because the obvious refactor (check first,
 * then start) silently reopens the older bug.
 * =========================================================================== */

import 'fake-indexeddb/auto';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
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

/** There is no <canvas> in Node. */
const stubEncoder = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 500
});

/** A File as a directory picker produces it. */
function pickedFile(name: string, relativePath: string): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

/**
 * @param existence what `POST /api/images/exists` should report for every
 *                  path it is asked about, or 'throw' to simulate the
 *                  endpoint being unreachable.
 */
function createSession(existence: boolean | 'throw', withApi = true) {
  const { inv } = createTestInventoryService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useClass: ImageMatchingService },
      { provide: ImageDownscaleService, useValue: {} as ImageDownscaleService },
      { provide: BatchImageImportService, useClass: BatchImageImportService }
    ]
  });

  const checkImagesExist = vi.fn((paths: string[]) => {
    if (existence === 'throw') throw new Error('backend down');
    return of({ results: Object.fromEntries(paths.map(p => [p, existence])) });
  });

  const api = {
    getAppFolder: () => of(''),
    checkImagesExist
  } as unknown as ApiService;

  const session = runInInjectionContext(injector, () => new BatchImportSession(
    inv,
    injector.get(ImageMatchingService),
    injector.get(BatchImageImportService),
    undefined as unknown as StorageService,
    withApi ? api : undefined
  ));
  session.encoder = stubEncoder;
  return { session, inv, checkImagesExist };
}

/** One coin the filename below will match. */
function seedMorgan(inv: InventoryService) {
  inv.inventory.set([
    {
      id: 'morgan', coinType: 'Morgan', denomination: 'Dollar',
      year: '1881', mintMark: 'S', imagePaths: []
    } as unknown as CoinRecord
  ]);
}

const MORGAN_FILE = '1881-S Morgan Dollar - Obverse.jpg';

async function selectOneFile(session: BatchImportSession) {
  const files = [pickedFile(MORGAN_FILE, `Dollars/${MORGAN_FILE}`)];
  await session.handleDirectorySelection(
    { target: { files, value: '' } } as unknown as Event
  );
}

describe('applyConfirmedMatches — the base-folder guard', () => {
  /**
   * THE HEADLINE REGRESSION. This is the owner's bug, end to end: a base
   * folder pointing at the app's own directory, a real selection, and an
   * import that must not happen.
   */
  it('writes nothing when every path it would record is unreadable', async () => {
    const { session, inv } = createSession(false);
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('C:\\dev\\coin-inventory');

    await session.applyConfirmedMatches();

    expect(updateCoin).not.toHaveBeenCalled();
    expect(session.blockedReason()).toContain('C:\\dev\\coin-inventory\\Dollars\\' + MORGAN_FILE);
  });

  it('clears the busy state when it refuses, so the screen is usable again', async () => {
    const { session, inv } = createSession(false);
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('C:\\dev\\coin-inventory');

    await session.applyConfirmedMatches();

    expect(session.progress()).toBeNull();
    expect(session.busy()).toBe(false);
  });

  /**
   * The ordering guarantee. `busy()` has to go true on the click's own tick
   * and STAY true across the existence check — otherwise the window the
   * double-import fix closed is open again, just narrower and harder to find.
   */
  it('is busy synchronously, before the check has answered', async () => {
    const { session, inv } = createSession(false);
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('C:\\dev\\coin-inventory');

    const run = session.applyConfirmedMatches();

    expect(session.busy()).toBe(true);        // same tick as the click
    await run;
    expect(session.busy()).toBe(false);
  });

  it('imports normally when the paths resolve', async () => {
    const { session, inv, checkImagesExist } = createSession(true);
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('D:\\Coin Pictures');

    await session.applyConfirmedMatches();

    expect(checkImagesExist).toHaveBeenCalledOnce();
    expect(updateCoin).toHaveBeenCalled();
    expect(session.blockedReason()).toBeNull();
  });

  /**
   * Fails open. If the check cannot run, the import must still be possible —
   * otherwise a flaky endpoint becomes a worse bug than the one being
   * prevented, because the user has no way to proceed at all.
   */
  it('imports anyway when the existence check itself fails', async () => {
    const { session, inv } = createSession('throw');
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('D:\\Coin Pictures');

    await session.applyConfirmedMatches();

    expect(updateCoin).toHaveBeenCalled();
    expect(session.blockedReason()).toBeNull();
  });

  /**
   * No ApiService at all is a supported configuration (the component injects
   * it optionally, and some tests build the session from a bare Injector).
   * The guard must degrade to the previous behaviour rather than block.
   */
  it('imports when there is no ApiService to ask', async () => {
    const { session, inv } = createSession(false, /* withApi */ false);
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('C:\\dev\\coin-inventory');

    await session.applyConfirmedMatches();

    expect(updateCoin).toHaveBeenCalled();
  });

  /**
   * Importing WITHOUT recording paths is a long-standing legitimate choice —
   * the screen warns about it and `sourcePathForFile` returns null. The guard
   * must not turn that into an error.
   */
  it('does not block, or even ask, when no base folder is set', async () => {
    const { session, inv, checkImagesExist } = createSession(false);
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('');

    await session.applyConfirmedMatches();

    expect(checkImagesExist).not.toHaveBeenCalled();
    expect(updateCoin).toHaveBeenCalled();
  });

  it('forgets a previous refusal when the screen is reset', async () => {
    const { session, inv } = createSession(false);
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('C:\\dev\\coin-inventory');
    await session.applyConfirmedMatches();
    expect(session.blockedReason()).not.toBeNull();

    session.reset();

    expect(session.blockedReason()).toBeNull();
  });
});
