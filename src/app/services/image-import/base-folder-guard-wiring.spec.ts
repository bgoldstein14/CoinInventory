 /*
 * base-folder-guard-wiring.spec.ts
 *
 * The base-folder check is wired into `applyConfirmedMatches`: a refusal
 * stops the database write. The session must still go busy synchronously on
 * the click (before the check answers), or a double click can import twice.
  */

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

  // busy() must be true on the click's own tick and stay true across the check.
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

  // ApiService is optional; without it the guard is skipped.
  it('imports when there is no ApiService to ask', async () => {
    const { session, inv } = createSession(false, /* withApi */ false);
    const updateCoin = vi.spyOn(inv, 'updateCoin');
    seedMorgan(inv);
    await selectOneFile(session);
    session.folder.set('C:\\dev\\coin-inventory');

    await session.applyConfirmedMatches();

    expect(updateCoin).toHaveBeenCalled();
  });

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
