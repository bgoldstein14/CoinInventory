import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageMatchingService } from '../../services/image-matching.service';
import { InventoryService } from '../../services/inventory.service';
import { BatchImageImportService } from '../../services/batch-image-import.service';
import { ImageDownscaleService } from '../../services/image-import/image-downscaler';
import { BatchImportSession } from '../../services/image-import/batch-import-session';
import { ImageImportModal } from './image-import-modal';
import { createTestInventoryService } from '../../testing/test-helpers';

/**
 * There is no <canvas> in the Node test environment, so the session's encoder
 * seam is stubbed with something that returns a predictable data URL. The
 * resize maths itself is covered in image-downscaler.spec.ts.
 */
const stubEncoder = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 250_000
});

/**
 * The modal keeps all of its state in a BatchImportSession. The session is
 * `protected` (it is only meant for the template), so the tests reach it
 * through a cast rather than making it public just for their benefit.
 */
function sess(modal: ImageImportModal): BatchImportSession {
  return (modal as unknown as { session: BatchImportSession }).session;
}

function createModal() {
  // InventoryService uses inject() so must be created in an injection context
  const { inv } = createTestInventoryService();
  const imageMatching = new ImageMatchingService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useValue: imageMatching },
      { provide: ImageDownscaleService, useValue: {} as ImageDownscaleService },
      { provide: BatchImageImportService, useClass: BatchImageImportService }
    ]
  });
  const modal = runInInjectionContext(injector, () => new ImageImportModal());
  // Install the test encoder in place of the real canvas downscaler.
  sess(modal).encoder = stubEncoder;
  return { modal, inv };
}

function addCoin(inv: InventoryService, overrides: Record<string, unknown> = {}) {
  inv.addBlankCoin();
  const coin = inv.inventory().at(-1)!;
  if (Object.keys(overrides).length > 0) inv.updateCoin(coin.id, overrides);
  return inv.inventory().find(c => c.id === coin.id)!;
}

function selectFiles(modal: ImageImportModal, names: string[]): Promise<void> {
  const files = names.map(name => new File(['img'], name, { type: 'image/jpeg' }));
  return sess(modal).handleDirectorySelection({ target: { files, value: '' } } as unknown as Event);
}

function rowFor(modal: ImageImportModal, fileName: string) {
  return sess(modal).imageReviews().find(r => r.fileName === fileName)!;
}

const selectedNames = (modal: ImageImportModal) =>
  sess(modal).imageReviews().filter(r => r.selected).map(r => r.fileName);

describe('ImageImportModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('buckets images into confident / needs-choice / no-match', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });
    addCoin(inv, { coinType: 'Liberty Head', denomination: '20 Dollar', year: '1907' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'liberty_head.jpg', 'IMG_2024.jpg']);

    expect(sess(modal).imageReviews()).toHaveLength(3);
    expect(sess(modal).autoMatches().map(r => r.fileName)).toEqual(['mercury_dime_1945.jpg']);
    expect(sess(modal).reviewMatches().map(r => r.fileName)).toEqual(['liberty_head.jpg']);
    expect(sess(modal).unmatchedImages().map(r => r.fileName)).toEqual(['IMG_2024.jpg']);
  });

  it('pre-selects only confident matches, never review or no-match rows', async () => {
    const { modal, inv } = createModal();
    const merc = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'IMG_2024.jpg']);

    expect(rowFor(modal, 'mercury_dime_1945.jpg').selectedCoinId).toBe(merc.id);
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('auto');
    expect(rowFor(modal, 'IMG_2024.jpg').selectedCoinId).toBeNull();
    expect(rowFor(modal, 'IMG_2024.jpg').decision).toBe('review');
  });

  it('never pre-selects a coin when two near-identical records compete', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'O' });

    await selectFiles(modal, ['1881-S Morgan Dollar.jpg']);

    const row = rowFor(modal, '1881-S Morgan Dollar.jpg');
    expect(row.result.status).toBe('review');
    expect(row.selectedCoinId).toBeNull();
    expect(row.result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('exposes the parsed filename attributes as display chips', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, ['1881-S Morgan Dollar MS63.jpg']);

    const chips = sess(modal).coins.chips(rowFor(modal, '1881-S Morgan Dollar MS63.jpg'));
    expect(chips).toContain('Year 1881');
    expect(chips).toContain('Mint S');
    expect(chips).toContain('Grade MS63');
  });

  it('confirms and rejects a confident match', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg']);

    sess(modal).confirmImageMatch('mercury_dime_1945.jpg');
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('confirmed');

    sess(modal).rejectImageMatch('mercury_dime_1945.jpg');
    const rejected = rowFor(modal, 'mercury_dime_1945.jpg');
    expect(rejected.decision).toBe('review');
    expect(rejected.selectedCoinId).toBeNull();
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('lets the user pick one of the ranked candidates', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'O' });

    await selectFiles(modal, ['1881-S Morgan Dollar.jpg']);

    const row = rowFor(modal, '1881-S Morgan Dollar.jpg');
    const top = row.result.candidates[0];
    sess(modal).chooseCandidate('1881-S Morgan Dollar.jpg', top);

    const chosen = rowFor(modal, '1881-S Morgan Dollar.jpg');
    expect(chosen.decision).toBe('confirmed');
    expect(chosen.selectedCoinId).toBe(top.coinId);
    expect(chosen.selectionReason).toContain('Chosen from suggestions');
    expect(sess(modal).attachCount()).toBe(1);
  });

  it('searches the inventory for a different coin', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });
    const peace = addCoin(inv, { coinType: 'Peace', denomination: 'Dollar', year: '1922' });

    await selectFiles(modal, ['IMG_2024.jpg']);

    // Below the minimum search length -> no noise.
    sess(modal).coins.setTerm('IMG_2024.jpg', 'p');
    expect(sess(modal).coins.results('IMG_2024.jpg')).toEqual([]);

    sess(modal).coins.setTerm('IMG_2024.jpg', 'peace 1922');
    const results = sess(modal).coins.results('IMG_2024.jpg');
    expect(results.map(c => c.id)).toEqual([peace.id]);

    sess(modal).coins.setTerm('IMG_2024.jpg', 'nothing like this');
    expect(sess(modal).coins.results('IMG_2024.jpg')).toEqual([]);
  });

  it('reassigns an image to any coin the user chooses', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });
    const peace = addCoin(inv, { coinType: 'Peace', denomination: 'Dollar', year: '1922' });

    await selectFiles(modal, ['IMG_2024.jpg']);
    sess(modal).reassignImageMatch('IMG_2024.jpg', peace.id);

    const row = rowFor(modal, 'IMG_2024.jpg');
    expect(row.selectedCoinId).toBe(peace.id);
    expect(row.decision).toBe('confirmed');
    expect(row.confidence).toBe(1);
    expect(row.selectionReason).toContain('Manually assigned');
  });

  it('clears the selection when reassigned to an empty coin id', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg']);
    sess(modal).reassignImageMatch('mercury_dime_1945.jpg', '');

    expect(rowFor(modal, 'mercury_dime_1945.jpg').selectedCoinId).toBeNull();
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('review');
  });

  it('skips an image and can undo the skip', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg']);

    sess(modal).skipImage('mercury_dime_1945.jpg');
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('skipped');
    expect(sess(modal).attachCount()).toBe(0);

    sess(modal).resetDecision('mercury_dime_1945.jpg');
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('auto');
    expect(sess(modal).attachCount()).toBe(1);
  });

  it('counts images still awaiting a decision', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'IMG_2024.jpg', 'IMG_2025.jpg']);

    // The confident one is already decided; the two camera files are not.
    expect(sess(modal).outstandingCount()).toBe(2);
  });

  it('attaches only confirmed / auto matches to their coins', async () => {
    const { modal, inv } = createModal();
    const merc = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'IMG_2024.jpg']);
    await sess(modal).applyConfirmedMatches();

    const updated = inv.inventory().find(c => c.id === merc.id)!;
    expect(updated.imagePaths.length).toBe(1);
  });

  it('attaches nothing when every image was skipped', async () => {
    const { modal, inv } = createModal();
    const merc = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg']);
    sess(modal).skipImage('mercury_dime_1945.jpg');
    await sess(modal).applyConfirmedMatches();

    expect(inv.inventory().find(c => c.id === merc.id)!.imagePaths).toHaveLength(0);
  });

  it('ignores a selection that contains no image files', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await sess(modal).handleDirectorySelection({
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })], value: '' }
    } as unknown as Event);

    expect(sess(modal).imageReviews()).toHaveLength(0);
  });

  it('resolves coin name by id', () => {
    const { modal, inv } = createModal();
    const coin = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    expect(sess(modal).coins.nameById(coin.id)).toBe('Mercury Dime 1945');
    expect(sess(modal).coins.nameById(null)).toBe('None');
    expect(sess(modal).coins.nameById('nonexistent')).toBe('Unknown');
  });

  /* =======================================================================
   * BATCH IMPORT: filtering, selection, bulk controls, confirmation
   * ===================================================================== */

  it('filters out non-displayable files and counts them with a reason', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    const files = [
      new File(['x'], 'mercury_dime_1945 - Obverse.jpg', { type: 'image/jpeg' }),
      new File(['x'], 'mercury_dime_1945 - Obverse.dng', { type: 'image/x-adobe-dng' }),
      new File(['x'], 'shot.CR2', { type: '' }),
      new File(['x'], 'layers.psd', { type: '' }),
      new File(['x'], 'Thumbs.db', { type: '' }),
      new File(['x'], 'album.info', { type: 'text/plain' })
    ];
    await sess(modal).handleDirectorySelection({ target: { files, value: '' } } as unknown as Event);

    // Only the JPEG made it into the review screen.
    expect(sess(modal).imageReviews().map(r => r.fileName))
      .toEqual(['mercury_dime_1945 - Obverse.jpg']);

    const report = sess(modal).filterResult()!;
    expect(report.totalSelected).toBe(6);
    expect(report.accepted).toHaveLength(1);
    expect(report.skipped).toHaveLength(5);
    // Every rejection is explained, so nothing looks silently dropped.
    expect(report.tallies.reduce((sum, t) => sum + t.count, 0)).toBe(5);
    expect(report.tallies.some(t => t.reason.includes('.dng'))).toBe(true);
  });

  it('still reports the skipped files when the folder had no usable images', async () => {
    const { modal } = createModal();

    await sess(modal).handleDirectorySelection({
      target: { files: [new File(['x'], 'a.dng'), new File(['x'], 'b.dng')], value: '' }
    } as unknown as Event);

    expect(sess(modal).imageReviews()).toHaveLength(0);
    expect(sess(modal).filterResult()!.skipped).toHaveLength(2);
  });

  it('starts every matched image selected', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg',
      '1881-S Morgan Dollar - Obverse - Small.jpg',
      '1881-S Morgan Dollar - Label.jpg'
    ]);

    expect(sess(modal).imageReviews()).toHaveLength(4);
    expect(selectedNames(modal)).toHaveLength(4);
    expect(sess(modal).attachCount()).toBe(4);
  });

  it('groups the matched photos by coin, obverse first', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Label.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg',
      '1881-S Morgan Dollar - Obverse - Photo.jpg'
    ]);

    const groups = sess(modal).coinGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map(r => r.photo.side)).toEqual(['obverse', 'reverse', 'label']);
    expect(groups[0].selectedCount).toBe(3);
  });

  it('excludes a deselected image from what gets written', async () => {
    const { modal, inv } = createModal();
    const morgan = addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg'
    ]);

    sess(modal).toggleImage('1881-S Morgan Dollar - Reverse - Photo.jpg');
    expect(sess(modal).attachCount()).toBe(1);

    await sess(modal).applyConfirmedMatches();

    const stored = inv.inventory().find(c => c.id === morgan.id)!.imagePaths;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('Obverse');
  });

  it('bulk "keep only Obverse + Reverse" selects exactly the two faces', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg',
      '1881-S Morgan Dollar - Label.jpg',
      '1881-S Morgan Dollar-2.jpg'
    ]);

    sess(modal).runBulkAction('keep-obverse-reverse');

    expect(selectedNames(modal)).toEqual([
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg'
    ]);
  });

  it('bulk "deselect retakes" drops derivatives and numbered takes only', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Obverse - Small.jpg',
      '1881-S Morgan Dollar - Obverse - Orig.jpg',
      '1881-S Morgan Dollar - Reverse-2.jpg'
    ]);

    sess(modal).runBulkAction('deselect-retakes');

    expect(selectedNames(modal)).toEqual(['1881-S Morgan Dollar - Obverse - Photo.jpg']);
  });

  it('bulk "deselect Label shots" leaves the coin photos alone', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Label.jpg'
    ]);

    sess(modal).runBulkAction('deselect-labels');

    expect(selectedNames(modal)).toEqual(['1881-S Morgan Dollar - Obverse - Photo.jpg']);
  });

  it('bulk select-all / deselect-all cover the whole batch', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg'
    ]);

    sess(modal).runBulkAction('deselect-all');
    expect(sess(modal).attachCount()).toBe(0);

    sess(modal).runBulkAction('select-all');
    expect(sess(modal).attachCount()).toBe(2);
  });

  it('applies a bulk rule to one coin without touching the other', async () => {
    const { modal, inv } = createModal();
    const morgan = addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Label.jpg',
      'mercury_dime_1945 - Label.jpg'
    ]);

    sess(modal).runBulkAction('deselect-labels', morgan.id);

    expect(selectedNames(modal)).toEqual(['mercury_dime_1945 - Label.jpg']);
  });

  it('writes nothing to the inventory until the import is confirmed', async () => {
    const { modal, inv } = createModal();
    const morgan = addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });
    const updateSpy = vi.spyOn(inv, 'updateCoin');

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg'
    ]);
    sess(modal).toggleImage('1881-S Morgan Dollar - Obverse - Photo.jpg');
    sess(modal).runBulkAction('select-all');
    sess(modal).coinGroups();

    // Reviewing, ticking and bulk-editing must not touch the inventory.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(inv.inventory().find(c => c.id === morgan.id)!.imagePaths).toHaveLength(0);

    await sess(modal).applyConfirmedMatches();

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(inv.inventory().find(c => c.id === morgan.id)!.imagePaths).toHaveLength(2);
  });

  it('keeps going when one file fails, and reports it in the summary', async () => {
    const { modal, inv } = createModal();
    const morgan = addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    // Fail on the reverse only.
    sess(modal).encoder = (file: File) =>
      file.name.includes('Reverse')
        ? Promise.reject(new Error('Corrupt JPEG marker'))
        : stubEncoder(file);

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg'
    ]);
    await sess(modal).applyConfirmedMatches();

    const summary = sess(modal).summary()!;
    expect(summary.attached).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].fileName).toContain('Reverse');
    expect(summary.failures[0].reason).toBe('Corrupt JPEG marker');

    // The good photo still landed on the coin.
    expect(inv.inventory().find(c => c.id === morgan.id)!.imagePaths).toHaveLength(1);
  });

  it('opens and closes a coin group without creating thumbnails up front', async () => {
    const { modal, inv } = createModal();
    const morgan = addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, ['1881-S Morgan Dollar - Obverse - Photo.jpg']);

    // No object URLs exist until a group is opened - 1,700 of them would mean
    // 1,700 image decodes.
    expect(sess(modal).thumbnailUrls()).toEqual({});
    expect(sess(modal).isCoinGroupExpanded(morgan.id)).toBe(false);

    sess(modal).toggleCoinGroup(morgan.id);
    expect(sess(modal).isCoinGroupExpanded(morgan.id)).toBe(true);

    sess(modal).toggleCoinGroup(morgan.id);
    expect(sess(modal).isCoinGroupExpanded(morgan.id)).toBe(false);
  });

  it('clears all review state when the modal is closed', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, ['1881-S Morgan Dollar - Obverse - Photo.jpg']);
    expect(sess(modal).imageReviews()).toHaveLength(1);

    modal['close']();

    expect(sess(modal).imageReviews()).toHaveLength(0);
    expect(sess(modal).filterResult()).toBeNull();
    expect(sess(modal).summary()).toBeNull();
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('renders the unmatched bucket a page at a time so hundreds of files stay fast', async () => {
    const { modal } = createModal();

    // 60 camera-default names, none of which can match anything.
    await selectFiles(modal, Array.from({ length: 60 }, (_, i) => `IM0000${i}.JPG`));

    expect(sess(modal).unmatchedImages()).toHaveLength(60);
    expect(modal['visibleUnmatchedImages']()).toHaveLength(25);

    modal['showMoreUnmatched']();
    expect(modal['visibleUnmatchedImages']()).toHaveLength(50);

    modal['showMoreUnmatched']();
    expect(modal['visibleUnmatchedImages']()).toHaveLength(60);
  });

  it('matches 1,700+ file names without reading any of them', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    // A share-sized batch. This is the responsiveness guarantee: matching is
    // filename-only, so it is fast and allocates nothing per file beyond a row.
    const names = Array.from({ length: 1700 }, (_, i) => `IMG_${1000 + i}.jpg`);
    names.push('1881-S Morgan Dollar - Obverse.jpg');

    const files = names.map(n => new File(['img'], n, { type: 'image/jpeg' }));
    const readSpies = files.slice(0, 5).map(f => vi.spyOn(f, 'arrayBuffer'));

    await sess(modal).handleDirectorySelection(
      { target: { files, value: '' } } as unknown as Event
    );

    expect(sess(modal).imageReviews()).toHaveLength(1701);
    // The one real coin photo matched; nothing was read off disk.
    expect(sess(modal).attachCount()).toBe(1);
    expect(readSpies.every(spy => spy.mock.calls.length === 0)).toBe(true);
    // And no previews were generated for 1,700 files.
    expect(sess(modal).thumbnailUrls()).toEqual({});
  });
});
