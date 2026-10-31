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

  it('buckets images into the three review tiers', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });
    addCoin(inv, { coinType: 'Liberty Head', denomination: '20 Dollar', year: '1907' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'liberty_head.jpg', 'IMG_2024.jpg']);

    expect(sess(modal).imageReviews()).toHaveLength(3);
    expect(sess(modal).matchedImages().map(r => r.fileName)).toEqual(['mercury_dime_1945.jpg']);
    // Tier 1 by tier and tier 1 by status must agree - i.e. the tier layer has
    // not started attaching anything the auto gates did not.
    expect(sess(modal).autoMatches()).toEqual(sess(modal).matchedImages());
    // "liberty_head.jpg" has no year and no grade, so it cannot be a near
    // match however well it scores; it joins the camera file in tier 3.
    expect(sess(modal).nearMatches()).toEqual([]);
    expect(sess(modal).notImported().map(r => r.fileName))
      .toEqual(['liberty_head.jpg', 'IMG_2024.jpg']);
  });

  it('pre-selects only confident matches, and auto-skips tier 3', async () => {
    const { modal, inv } = createModal();
    const merc = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'IMG_2024.jpg']);

    expect(rowFor(modal, 'mercury_dime_1945.jpg').selectedCoinId).toBe(merc.id);
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('auto');

    // A file with no apparent match is skipped by the importer itself. Under
    // the old two-bucket screen this sat in a queue waiting for a decision
    // whose only honest answer was "yes, skip it"; with ~2,140 files that was
    // hundreds of pointless clicks.
    const skipped = rowFor(modal, 'IMG_2024.jpg');
    expect(skipped.selectedCoinId).toBeNull();
    expect(skipped.decision).toBe('skipped');
    expect(skipped.selected).toBe(false);
    // ...and it is reported, not dropped.
    expect(skipped.result.skipReason).toBeTruthy();
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

  it('leaves nothing awaiting a decision when nothing is a near match', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'IMG_2024.jpg', 'IMG_2025.jpg']);

    // The confident one is attached; the two camera files have no apparent
    // match, so they are skipped automatically rather than queued. This is
    // the whole point of the three tiers: with ~2,140 files, a queue entry
    // the user can only answer one way is not a question, it is a chore.
    expect(sess(modal).outstandingCount()).toBe(0);
    expect(sess(modal).notImported()).toHaveLength(2);
  });

  /* =======================================================================
   * TIER 2: the near-match queue
   * =====================================================================
   * Two 1881 Morgan Dollars that differ only by mint mark, both PCGS MS63 -
   * the ambiguity the product owner described. The filenames agree with both
   * on year, coin type, denomination and grade, so they are near matches; the
   * mint mark the records disagree on is what stops the matcher attaching
   * them unasked.
   */
  function addAmbiguousMorgans(inv: InventoryService) {
    return {
      morganS: addCoin(inv, {
        coinType: 'Morgan', denomination: 'Dollar', year: '1881',
        mintMark: 'S', grade: 'MS63', certCompany: 'PCGS'
      }),
      morganO: addCoin(inv, {
        coinType: 'Morgan', denomination: 'Dollar', year: '1881',
        mintMark: 'O', grade: 'MS63', certCompany: 'PCGS'
      })
    };
  }

  /* The "- Obverse" name is verbatim from the share survey; the others follow
   * the Obverse / Reverse / Label convention the survey shows everywhere. */
  const MORGAN_SIDES = [
    '1881 Morgan Dollar PCGS MS63 - Obverse.jpg',
    '1881 Morgan Dollar PCGS MS63 - Reverse.jpg',
    '1881 Morgan Dollar PCGS MS63 - Label.jpg'
  ];

  it('queues a near match without attaching it', async () => {
    const { modal, inv } = createModal();
    addAmbiguousMorgans(inv);

    await selectFiles(modal, [MORGAN_SIDES[0]]);

    const row = rowFor(modal, MORGAN_SIDES[0]);
    expect(row.result.tier).toBe('near');
    expect(sess(modal).nearMatches()).toHaveLength(1);
    expect(sess(modal).outstandingCount()).toBe(1);

    // The hard constraint: a near match attaches NOTHING on its own.
    expect(row.selectedCoinId).toBeNull();
    expect(row.selected).toBe(false);
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('groups the sides of one coin into a single question', async () => {
    const { modal, inv } = createModal();
    addAmbiguousMorgans(inv);

    await selectFiles(modal, MORGAN_SIDES);

    const groups = sess(modal).nearMatchGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(3);
    expect(groups[0].outstandingCount).toBe(3);
    // Obverse first, then reverse, then the label - the same ordering the
    // matched coin groups use.
    expect(groups[0].rows.map(r => r.photo.side)).toEqual(['obverse', 'reverse', 'label']);

    // ...and one click settles all three.
    sess(modal).acceptNearMatchGroup(groups[0].coinId);

    expect(sess(modal).outstandingCount()).toBe(0);
    expect(sess(modal).attachCount()).toBe(3);
    for (const name of MORGAN_SIDES) {
      expect(rowFor(modal, name).selectedCoinId).toBe(groups[0].coinId);
      expect(rowFor(modal, name).decision).toBe('confirmed');
    }
  });

  it('accepts one near match at a time and can undo it', async () => {
    const { modal, inv } = createModal();
    addAmbiguousMorgans(inv);

    await selectFiles(modal, [MORGAN_SIDES[0]]);
    const suggested = rowFor(modal, MORGAN_SIDES[0]).result.nearMatch!.suggestedCoinId;

    sess(modal).acceptNearMatch(MORGAN_SIDES[0]);
    expect(rowFor(modal, MORGAN_SIDES[0]).selectedCoinId).toBe(suggested);
    expect(sess(modal).attachCount()).toBe(1);

    sess(modal).resetDecision(MORGAN_SIDES[0]);
    expect(rowFor(modal, MORGAN_SIDES[0]).decision).toBe('review');
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('picks a different coin from the near-candidate dropdown', async () => {
    const { modal, inv } = createModal();
    const { morganS, morganO } = addAmbiguousMorgans(inv);

    await selectFiles(modal, [MORGAN_SIDES[0]]);

    const detail = rowFor(modal, MORGAN_SIDES[0]).result.nearMatch!;
    expect(detail.candidates.map(c => c.coinId).sort())
      .toEqual([morganO.id, morganS.id].sort());

    const other = detail.candidates.find(c => c.coinId !== detail.suggestedCoinId)!;
    sess(modal).chooseNearCandidate(MORGAN_SIDES[0], other.coinId);

    expect(rowFor(modal, MORGAN_SIDES[0]).selectedCoinId).toBe(other.coinId);
    expect(rowFor(modal, MORGAN_SIDES[0]).decision).toBe('confirmed');
  });

  it('ignores a dropdown choice that is not one of the near candidates', async () => {
    const { modal, inv } = createModal();
    addAmbiguousMorgans(inv);
    const unrelated = addCoin(inv, { coinType: 'Peace', denomination: 'Dollar', year: '1922' });

    await selectFiles(modal, [MORGAN_SIDES[0]]);
    sess(modal).chooseNearCandidate(MORGAN_SIDES[0], unrelated.id);

    // A coin the near-match test rejected must never be one click away.
    expect(rowFor(modal, MORGAN_SIDES[0]).selectedCoinId).toBeNull();
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('skips a whole near-match group', async () => {
    const { modal, inv } = createModal();
    addAmbiguousMorgans(inv);

    await selectFiles(modal, MORGAN_SIDES);
    sess(modal).skipNearMatchGroup(sess(modal).nearMatchGroups()[0].coinId);

    expect(sess(modal).outstandingCount()).toBe(0);
    expect(sess(modal).attachCount()).toBe(0);
    for (const name of MORGAN_SIDES) {
      expect(rowFor(modal, name).decision).toBe('skipped');
    }
  });

  it('creates near-match thumbnails only when the user asks for them', async () => {
    const { modal, inv } = createModal();
    addAmbiguousMorgans(inv);

    await selectFiles(modal, MORGAN_SIDES);
    const coinId = sess(modal).nearMatchGroups()[0].coinId;

    expect(sess(modal).thumbnailUrls()).toEqual({});
    expect(sess(modal).areNearMatchPhotosShown(coinId)).toBe(false);

    sess(modal).toggleNearMatchPhotos(coinId);
    expect(sess(modal).areNearMatchPhotosShown(coinId)).toBe(true);

    sess(modal).toggleNearMatchPhotos(coinId);
    expect(sess(modal).areNearMatchPhotosShown(coinId)).toBe(false);
  });

  it('summarises the shape of the work before anything is scrolled', async () => {
    const { modal, inv } = createModal();
    addAmbiguousMorgans(inv);
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, [
      'mercury_dime_1945.jpg',   // tier 1
      MORGAN_SIDES[0],           // tier 2
      'Gold Coins.JPG',          // tier 3, not a single coin at all
      'liberty_head.jpg'         // tier 3, a coin photo with no apparent match
    ]);

    const summary = sess(modal).tierSummary();
    expect(summary.total).toBe(4);
    expect(summary.willAttach).toBe(1);
    expect(summary.needsAttention).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(summary.skippedNotACoin).toBe(1);
    expect(summary.skippedNoMatch).toBe(1);

    // Answering the question moves it from "needs attention" to "will attach".
    sess(modal).acceptNearMatch(MORGAN_SIDES[0]);
    expect(sess(modal).tierSummary().needsAttention).toBe(0);
    expect(sess(modal).tierSummary().willAttach).toBe(2);
  });

  it('writes a near match to its coin only after the user accepts it', async () => {
    const { modal, inv } = createModal();
    addAmbiguousMorgans(inv);

    await selectFiles(modal, [MORGAN_SIDES[0]]);

    // Confirm with nothing accepted: the inventory must be untouched.
    await sess(modal).applyConfirmedMatches();
    expect(inv.inventory().every(c => c.imagePaths.length === 0)).toBe(true);

    sess(modal).acceptNearMatch(MORGAN_SIDES[0]);
    const target = rowFor(modal, MORGAN_SIDES[0]).selectedCoinId!;
    await sess(modal).applyConfirmedMatches();

    expect(inv.inventory().find(c => c.id === target)!.imagePaths).toHaveLength(1);
  });

  it('skips a whole matched coin and drops it out of the list', async () => {
    const { modal, inv } = createModal();
    const morgan = addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse - Photo.jpg',
      '1881-S Morgan Dollar - Reverse - Photo.jpg'
    ]);
    expect(sess(modal).coinGroups()).toHaveLength(1);

    sess(modal).skipCoinGroup(morgan.id);

    // Unlike the "None" bulk button, Skip is a decision: the group leaves the
    // screen rather than sitting there reading "0 of 2 selected".
    expect(sess(modal).coinGroups()).toHaveLength(0);
    expect(sess(modal).attachCount()).toBe(0);
    expect(sess(modal).imageReviews().every(r => r.decision === 'skipped')).toBe(true);
  });

  it('asks nothing on a not-imported row until the user opts in', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['Gold Coins.JPG']);

    const row = rowFor(modal, 'Gold Coins.JPG');
    expect(row.decision).toBe('skipped');
    /* Tier 3 carries exactly one control, "Attach anyway", and it is opt-in:
     * nothing is revealed and nothing is decided until that row's link is
     * clicked. See tier3-rescue.spec.ts for the escape hatch itself; what
     * matters here is that an untouched row behaves exactly as it always
     * did. */
    expect(sess(modal).rescueOpen().size).toBe(0);
    expect(sess(modal).isRescueOpen('Gold Coins.JPG')).toBe(false);
    // "Undo" on a row the IMPORTER skipped must put it straight back to
    // skipped - it has no apparent match, so there is nothing to offer.
    sess(modal).resetDecision('Gold Coins.JPG');
    expect(rowFor(modal, 'Gold Coins.JPG').decision).toBe('skipped');
    expect(rowFor(modal, 'Gold Coins.JPG').selectedCoinId).toBeNull();
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

    /* EACH COIN NEEDS A PHOTO OF THE COIN, not just of its slab label.
     *
     * The owner ruled that a label shot "only alongside a coin photo" may
     * identify a coin -- a photograph of the paperwork never names a coin by
     * itself (see the LABEL gate in match-decider.ts). So a batch of nothing
     * but label shots now attaches nothing at all, and this test, which is
     * about bulk rules being scoped to ONE coin, would be testing an empty
     * list instead.
     *
     * Adding the obverse of each coin restores what the test is actually
     * about, and incidentally exercises the ride-along: each label is placed
     * by sibling-inference.ts because the obverse beside it shares the same
     * identifying text. */
    await selectFiles(modal, [
      '1881-S Morgan Dollar - Obverse.jpg',
      '1881-S Morgan Dollar - Label.jpg',
      'mercury_dime_1945 - Obverse.jpg',
      'mercury_dime_1945 - Label.jpg'
    ]);

    sess(modal).runBulkAction('deselect-labels', morgan.id);

    // Only the MORGAN's label is dropped; the Mercury dime's is untouched.
    expect(selectedNames(modal)).toEqual([
      '1881-S Morgan Dollar - Obverse.jpg',
      'mercury_dime_1945 - Obverse.jpg',
      'mercury_dime_1945 - Label.jpg'
    ]);
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

  it('renders the not-imported list a page at a time so hundreds of files stay fast', async () => {
    const { modal } = createModal();

    // 60 camera-default names, none of which can match anything.
    await selectFiles(modal, Array.from({ length: 60 }, (_, i) => `IM0000${i}.JPG`));

    expect(sess(modal).notImported()).toHaveLength(60);
    expect(modal['visibleNotImported']()).toHaveLength(25);

    modal['showMoreSkipped']();
    expect(modal['visibleNotImported']()).toHaveLength(50);

    modal['showMoreSkipped']();
    expect(modal['visibleNotImported']()).toHaveLength(60);
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
