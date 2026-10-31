/**
 * Tests for WHEN the busy indicator exists, as opposed to what it says
 * (import-progress.spec.ts covers the wording).
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS LOOK LIKE THEY ARE TESTING setTimeout
 * ---------------------------------------------------------------------------
 * The reported bug was "the screen was basically frozen with no indication
 * that anything was going on". There were two separate causes, and only one of
 * them is a missing indicator:
 *
 *   1. NOTHING WAS SET. `applyConfirmedMatches` left `progress` at null until
 *      the FIRST file had been read, decoded and downscaled. On a 46 MB JPEG
 *      over SMB that is several seconds with no bar and — worse — with
 *      `busy()` still false, so the Save button was live and a second click
 *      re-ran the whole import.
 *
 *   2. IT WAS SET BUT COULD NOT PAINT. A signal write does not draw anything.
 *      The browser only repaints when the task that is running gives the event
 *      loop back. The old code set the matching progress and then ran the
 *      first 200-filename chunk in the SAME task — measured at ~1.1 s against
 *      a 2,000-coin inventory — so the bar's first appearance was already a
 *      second late, and the review-screen render at the end happened after
 *      `progress` had been cleared.
 *
 * A unit test cannot see a repaint. What it CAN see is the yield that makes a
 * repaint possible, by observing the state from a `setTimeout(0)` that is
 * queued before the work starts: if the session yields, our observer runs
 * while the import is still in flight and sees the indicator. If the session
 * does not yield, our observer only runs after everything is over and sees
 * nothing. That is exactly the difference the user experienced.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../inventory.service';
import { ImageMatchingService } from '../image-matching.service';
import { BatchImageImportService } from '../batch-image-import.service';
import { ImageDownscaleService } from './image-downscaler';
import { BatchImportSession } from './batch-import-session';
import { ImageImportModal } from '../../components/image-import-modal/image-import-modal';
import { runAttach } from './attach-runner';
import { StorageService } from '../storage.service';
import { imageSourcePaths } from '../image-source-paths';
import { createTestInventoryService } from '../../testing/test-helpers';
import { BatchImageRow, BatchImportProgress, CoinRecord } from '../../types/coin.model';

/** There is no <canvas> in Node. */
const stubEncoder = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 500
});

function createSession() {
  const { inv } = createTestInventoryService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useClass: ImageMatchingService },
      { provide: ImageDownscaleService, useValue: {} as ImageDownscaleService },
      { provide: BatchImageImportService, useClass: BatchImageImportService }
    ]
  });
  const session = runInInjectionContext(injector, () => new BatchImportSession(
    inv,
    injector.get(ImageMatchingService),
    injector.get(BatchImageImportService),
    undefined as unknown as StorageService,
    undefined
  ));
  session.encoder = stubEncoder;
  return { session, inv };
}

const jpg = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

function selectFiles(session: BatchImportSession, files: File[]): Promise<void> {
  return session.handleDirectorySelection({ target: { files, value: '' } } as unknown as Event);
}

/**
 * Queue an observer on the macrotask queue BEFORE kicking off `work`.
 *
 * It can only run if `work` hands the event loop back at least once — which is
 * the same condition the browser needs in order to paint. Every snapshot it
 * takes is therefore a moment the user would really have seen something.
 */
async function snapshotWhileRunning<T>(
  read: () => T,
  work: () => Promise<unknown>,
  ticks = 40
): Promise<T[]> {
  const seen: T[] = [];
  let running = true;

  const observe = () => {
    if (!running) return;
    seen.push(read());
    setTimeout(observe, 0);
  };
  setTimeout(observe, 0);

  await work();
  running = false;
  return seen;
}

/* =========================================================================
 * THE RUNNER
 * ======================================================================= */
describe('attach-runner — the indicator exists before the first file is read', () => {
  const morgan = { id: 'morgan', imagePaths: [] } as unknown as CoinRecord;

  const row = (fileName: string): BatchImageRow => ({
    fileName,
    thumbnailUrl: '',
    result: {} as BatchImageRow['result'],
    selectedCoinId: 'morgan',
    selectionReason: '',
    confidence: 1,
    decision: 'auto',
    selected: true,
    photo: {} as BatchImageRow['photo'],
    sizeBytes: 100
  });

  /**
   * The headline regression. The first `onProgress` call has to land BEFORE
   * the first `encode`, because `encode` is the slow part: it is where the
   * bytes come off the share.
   */
  it('reports 0-of-n before encoding anything', async () => {
    const order: string[] = [];
    const rows = [row('a.jpg'), row('b.jpg')];
    const files = new Map([['a.jpg', jpg('a.jpg')], ['b.jpg', jpg('b.jpg')]]);

    await runAttach(rows, {
      files,
      inventory: [morgan],
      attach: vi.fn(),
      onProgress: p => order.push(`progress:${p.processed}/${p.total}`),
      encode: file => { order.push(`encode:${file.name}`); return stubEncoder(file); }
    });

    expect(order[0]).toBe('progress:0/2');
    expect(order[1]).toBe('encode:a.jpg');
  });

  it('still reports 0-of-0 when there is nothing ticked, rather than staying silent', async () => {
    const seen: BatchImportProgress[] = [];

    await runAttach([], {
      files: new Map(),
      inventory: [],
      attach: vi.fn(),
      onProgress: p => seen.push(p),
      encode: stubEncoder
    });

    expect(seen[0].phase).toBe('attaching');
    expect(seen[0].total).toBe(0);
    expect(seen.at(-1)!.phase).toBe('done');
  });

  it('yields after announcing itself, so the bar can paint before the first read', async () => {
    const rows = [row('a.jpg')];
    const files = new Map([['a.jpg', jpg('a.jpg')]]);
    let encodeStarted = false;
    let observerRanBeforeEncode = false;

    setTimeout(() => { observerRanBeforeEncode = !encodeStarted; }, 0);

    await runAttach(rows, {
      files,
      inventory: [morgan],
      attach: vi.fn(),
      encode: file => { encodeStarted = true; return stubEncoder(file); }
    });

    expect(observerRanBeforeEncode).toBe(true);
  });
});

/* =========================================================================
 * THE SESSION
 * ======================================================================= */
describe('BatchImportSession — the screen is never silently busy', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    imageSourcePaths.clear();
  });

  it('is busy from the instant the picker fires, not from the first chunk', () => {
    const { session } = createSession();

    // Deliberately NOT awaited: this is the synchronous half of the handler,
    // i.e. everything the browser does before it is next able to paint.
    void selectFiles(session, [jpg('1881-S Morgan Dollar - Obverse.jpg')]);

    expect(session.busy()).toBe(true);
    expect(session.progress()?.phase).toBe('scanning');
  });

  it('shows a progress stage at every point a repaint is possible during a folder select', async () => {
    const { session, inv } = createSession();
    inv.inventory.set([
      { id: 'morgan', coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' } as unknown as CoinRecord
    ]);
    const files = Array.from({ length: 5 }, (_, i) => jpg(`1881-S Morgan Dollar - Obverse-${i}.jpg`));

    const phases = await snapshotWhileRunning(
      () => session.progress()?.phase ?? null,
      () => selectFiles(session, files)
    );

    // Every paintable moment had SOMETHING on screen...
    expect(phases.length).toBeGreaterThan(0);
    expect(phases).not.toContain(null);
    // ...and the stages the user sees are the honest ones.
    expect(new Set(phases)).toEqual(new Set(['scanning', 'matching', 'building']));
    // The indicator is only taken down once everything has settled.
    expect(session.progress()).toBeNull();
    expect(session.busy()).toBe(false);
  });

  it('keeps the indicator up while the review list is handed to the template', async () => {
    const { session } = createSession();
    const files = [jpg('a.jpg'), jpg('b.jpg')];

    const snapshots = await snapshotWhileRunning(
      () => ({ phase: session.progress()?.phase ?? null, rows: session.imageReviews().length }),
      () => selectFiles(session, files)
    );

    // There must be at least one paintable moment where the rows are already
    // in place AND the indicator is still showing — that is the moment Angular
    // spends building several hundred DOM nodes.
    expect(snapshots.some(s => s.rows === 2 && s.phase !== null)).toBe(true);
  });

  it('clears the indicator when the folder held no usable images', async () => {
    const { session } = createSession();

    await selectFiles(session, [new File(['x'], 'notes.txt', { type: 'text/plain' })]);

    expect(session.progress()).toBeNull();
    expect(session.busy()).toBe(false);
    expect(session.filterResult()).not.toBeNull();
  });

  it('ignores a second folder selection while one is already running', async () => {
    const { session } = createSession();
    const first = selectFiles(session, [jpg('a.jpg'), jpg('b.jpg')]);

    // The user, seeing nothing happen, clicks the picker again.
    await selectFiles(session, [jpg('c.jpg')]);
    await first;

    expect(session.imageReviews().map(r => r.fileName)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('is busy the moment Save is clicked, before any file has been read', async () => {
    const { session, inv } = createSession();
    inv.inventory.set([
      { id: 'morgan', coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S', imagePaths: [] } as unknown as CoinRecord
    ]);
    await selectFiles(session, [jpg('1881-S Morgan Dollar - Obverse.jpg')]);
    expect(session.attachCount()).toBe(1);

    const run = session.applyConfirmedMatches();

    // Synchronously, on the same tick as the click.
    expect(session.busy()).toBe(true);
    expect(session.progress()?.phase).toBe('attaching');
    expect(session.progress()?.total).toBe(1);

    await run;
    expect(session.busy()).toBe(false);
  });

  it('refuses a second Save while the first is still running', async () => {
    const { session, inv } = createSession();
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    inv.inventory.set([
      { id: 'morgan', coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S', imagePaths: [] } as unknown as CoinRecord
    ]);
    await selectFiles(session, [jpg('1881-S Morgan Dollar - Obverse.jpg')]);
    updateCoin.mockClear();

    const first = session.applyConfirmedMatches();
    await session.applyConfirmedMatches(); // the impatient second click
    await first;

    expect(updateCoin).toHaveBeenCalledTimes(1);
  });
});

/* =========================================================================
 * THE MODAL SHELL
 * ======================================================================= */
describe('ImageImportModal — cannot be closed out from under a running import', () => {
  function createModal() {
    const { inv } = createTestInventoryService();
    const injector = Injector.create({
      providers: [
        { provide: InventoryService, useValue: inv },
        { provide: ImageMatchingService, useClass: ImageMatchingService },
        { provide: ImageDownscaleService, useValue: {} as ImageDownscaleService },
        { provide: BatchImageImportService, useClass: BatchImageImportService }
      ]
    });
    const modal = runInInjectionContext(injector, () => new ImageImportModal());
    const session = (modal as unknown as { session: BatchImportSession }).session;
    session.encoder = stubEncoder;
    return { modal, session, inv };
  }

  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    imageSourcePaths.clear();
  });

  /**
   * The Cancel button is disabled while busy, but the backdrop and the ×
   * are not buttons and have no disabled state. `close()` calls
   * `session.reset()`, which clears the ThumbnailCache — i.e. the File
   * handles the attach runner is in the middle of reading. A stray backdrop
   * click used to turn the rest of the run into "File handle was lost"
   * failures.
   */
  it('ignores close() while a stage is running', async () => {
    const { modal, session, inv } = createModal();
    inv.inventory.set([
      { id: 'morgan', coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S', imagePaths: [] } as unknown as CoinRecord
    ]);
    await selectFiles(session, [jpg('1881-S Morgan Dollar - Obverse.jpg')]);

    const closed = vi.fn();
    modal.closed.subscribe(closed);

    const run = session.applyConfirmedMatches();
    modal.close(); // the stray backdrop click

    expect(closed).not.toHaveBeenCalled();
    expect(session.imageReviews()).toHaveLength(1);

    await run;
    expect(session.summary()?.attached).toBe(1);
  });

  it('still closes normally once nothing is running', async () => {
    const { modal, session } = createModal();
    await selectFiles(session, [jpg('a.jpg')]);

    const closed = vi.fn();
    modal.closed.subscribe(closed);
    modal.close();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(session.imageReviews()).toHaveLength(0);
  });
});
