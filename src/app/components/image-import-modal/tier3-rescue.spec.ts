/* ===========================================================================
 * tier3-rescue.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   That tier 3 -- the read-only "not imported" list -- now has a way back in,
 *   WITHOUT having become a queue and WITHOUT the matcher having been made
 *   braver.
 *
 *   Those two halves are equally important, so the file is in two parts:
 *
 *     1. THE HATCH WORKS. A skipped row can be rescued from the matcher's own
 *        ranked candidates, or from the free-text CoinLookup search when there
 *        are no candidates at all; it then travels the ordinary attach path.
 *
 *     2. THE HATCH COSTS NOTHING. A row nobody touches stays skipped and
 *        writes nothing; the control is opt-in, so no panel exists until it is
 *        clicked; the read-only list keeps its paging; and -- the constraint
 *        the owner was most explicit about -- the TIER ASSIGNMENT ITSELF is
 *        byte-for-byte the same before and after any amount of rescuing.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TIER-ASSIGNMENT TEST IS WRITTEN THE WAY IT IS
 * ---------------------------------------------------------------------------
 *   It deliberately asserts that tiers do not CHANGE, rather than asserting
 *   that specific files land in specific tiers. The four-attribute bar and the
 *   grade-equivalence rule behind it are owned by
 *   services/image-matching/near-match.ts and are tuned there; pinning exact
 *   tier membership here would make this spec fail every time that rule is
 *   legitimately adjusted, which would be noise rather than protection.
 *
 *   What this spec guards is the thing THIS work could plausibly break: that
 *   an escape hatch bolted onto the review screen cannot reach back and alter
 *   how the matcher classified anything. Hence the before/after snapshot.
 *
 *   The fixtures below rely only on a filename carrying NO GRADE AT ALL, which
 *   is a hard "absence is not agreement" failure and is not affected by how
 *   forgiving the comparison of two PRESENT grades is.
 * =========================================================================== */

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
import { searchCoins } from '../../services/image-import/row-decisions';

/** No <canvas> in Node, so the read-and-shrink step is stubbed. */
const stubEncoder = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 250_000
});

/** The session is `protected` on the component; reach it the same way the
 *  sibling spec does rather than widening the API for the tests' benefit. */
function sess(modal: ImageImportModal): BatchImportSession {
  return (modal as unknown as { session: BatchImportSession }).session;
}

function createModal() {
  const { inv } = createTestInventoryService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useValue: new ImageMatchingService() },
      { provide: ImageDownscaleService, useValue: {} as ImageDownscaleService },
      { provide: BatchImageImportService, useClass: BatchImageImportService }
    ]
  });
  const modal = runInInjectionContext(injector, () => new ImageImportModal());
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

/** Every row's tier, keyed by filename — the snapshot the last section compares. */
function tierMap(modal: ImageImportModal): Record<string, string> {
  const tiers: Record<string, string> = {};
  for (const row of sess(modal).imageReviews()) tiers[row.fileName] = row.result.tier;
  return tiers;
}

/* ---------------------------------------------------------------------------
 * THE FIXTURE: the owner's own worst case, in miniature.
 *
 * "1881 Morgan Dollar NGC 2599001.jpg" is verbatim from the share. Against a
 * matching Morgan record it scores very highly -- 97% on the real inventory --
 * and the near-match bar still refuses it, because the FILENAME STATES NO
 * GRADE and absence is never agreement. Under a strictly button-less tier 3
 * the right coin would be sitting at the top of a ranked list nobody can see.
 * ------------------------------------------------------------------------- */
const MORGAN_NO_GRADE = '1881 Morgan Dollar NGC 2599001.jpg';

/** A camera-default name: tier 3 with NO candidates at all, so the ranked list
 *  has nothing to offer and only the free-text search can place it. */
const CAMERA_NAME = 'IM000025.JPG';

describe('tier 3 — the opt-in "Attach anyway" escape hatch', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  /** The inventory used throughout: one well-filled Morgan, one unrelated coin. */
  function stockInventory(inv: InventoryService) {
    return {
      /* TWO 1881 Morgan dollars, because that is what the real collection
       * holds and it is what makes this the interesting case:
       *
       *   - both records are COMPLETE, grade included; it is the FILENAME
       *     that states no grade, which is why the four-attribute bar
       *     refuses it (absence is never agreement);
       *   - two equally good fits means the auto-assign gates refuse it as
       *     well, so it is not quietly attached either.
       *
       * The result is exactly the owner's dead end: a very high-scoring
       * photo, a ranked candidate list that contains the right coin, and
       * nothing on screen that could reach it. Neither record carries the
       * cert number from the filename - if one did, that would be an
       * independent strong attribute and the gates would attach the file
       * outright, which is the opposite of the case under test. */
      morgan: addCoin(inv, {
        coinType: 'Morgan', denomination: 'Dollar', year: '1881',
        mintMark: 'S', grade: 'MS63'
      }),
      morganAlt: addCoin(inv, {
        coinType: 'Morgan', denomination: 'Dollar', year: '1881',
        mintMark: 'O', grade: 'MS64'
      }),
      peace: addCoin(inv, { coinType: 'Peace', denomination: 'Dollar', year: '1922' })
    };
  }

  /* =======================================================================
   * 1. THE HATCH IS OPT-IN
   * ===================================================================== */

  it('shows no control state and asks nothing until the user opens a row', async () => {
    const { modal, inv } = createModal();
    stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE, CAMERA_NAME]);

    // Both files are in the read-only tier and already skipped by the importer.
    expect(sess(modal).notImported().map(r => r.fileName).sort())
      .toEqual([CAMERA_NAME, MORGAN_NO_GRADE].sort());
    expect(sess(modal).imageReviews().every(r => r.decision === 'skipped')).toBe(true);

    // Nothing is open, so the template renders no panel for any row. This is
    // the whole "stays a report, not a queue" guarantee, in one assertion.
    expect(sess(modal).rescueOpen().size).toBe(0);
    expect(sess(modal).isRescueOpen(MORGAN_NO_GRADE)).toBe(false);
    expect(sess(modal).outstandingCount()).toBe(0);
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('opens and closes one row at a time, without deciding anything', async () => {
    const { modal, inv } = createModal();
    stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE, CAMERA_NAME]);

    sess(modal).openRescue(MORGAN_NO_GRADE);
    expect(sess(modal).isRescueOpen(MORGAN_NO_GRADE)).toBe(true);
    // Opening one row must not open its neighbours.
    expect(sess(modal).isRescueOpen(CAMERA_NAME)).toBe(false);
    // ...and opening is not deciding.
    expect(rowFor(modal, MORGAN_NO_GRADE).decision).toBe('skipped');
    expect(sess(modal).attachCount()).toBe(0);

    sess(modal).closeRescue(MORGAN_NO_GRADE);
    expect(sess(modal).isRescueOpen(MORGAN_NO_GRADE)).toBe(false);
    expect(rowFor(modal, MORGAN_NO_GRADE).decision).toBe('skipped');
  });

  /* =======================================================================
   * 2. RESCUE VIA THE MATCHER'S OWN RANKED CANDIDATES
   * ===================================================================== */

  it('rescues a skipped row from the ranked candidates the matcher already produced', async () => {
    const { modal, inv } = createModal();
    const { morgan } = stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE]);

    const before = rowFor(modal, MORGAN_NO_GRADE);
    expect(before.result.tier).toBe('not-imported');
    // The point of the whole feature: the right coin IS in the list, ranked
    // first, and before this work nothing on screen showed it.
    expect(before.result.candidates.length).toBeGreaterThan(0);
    expect(before.result.candidates.map(c => c.coinId)).toContain(morgan.id);
    expect(before.result.candidates[0].score).toBeGreaterThan(0.5);

    sess(modal).openRescue(MORGAN_NO_GRADE);
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, before.result.candidates[0].coinId);

    const after = rowFor(modal, MORGAN_NO_GRADE);
    expect(after.decision).toBe('confirmed');
    expect(after.selected).toBe(true);
    expect(after.selectedCoinId).toBe(before.result.candidates[0].coinId);
    // The matcher's own score is kept: the user overrode the BAR, not the
    // arithmetic, and the score is the most useful thing we know here.
    expect(after.confidence).toBe(before.result.candidates[0].score);
    expect(after.selectionReason).toContain('Attached anyway');
    expect(sess(modal).attachCount()).toBe(1);
    // Choosing closes the panel, so the row goes back to one line.
    expect(sess(modal).isRescueOpen(MORGAN_NO_GRADE)).toBe(false);
  });

  it('refuses a coin id that is not one of that row\'s candidates', async () => {
    const { modal, inv } = createModal();
    stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE]);
    // A stale or hand-crafted id must attach nothing. The guard matters
    // because the ids come out of the DOM: the only coins this control may
    // ever reach are the ones the matcher itself ranked for THIS file.
    expect(rowFor(modal, MORGAN_NO_GRADE).result.candidates.map(c => c.coinId))
      .not.toContain('no-such-coin');
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, 'no-such-coin');

    expect(rowFor(modal, MORGAN_NO_GRADE).selectedCoinId).toBeNull();
    expect(sess(modal).attachCount()).toBe(0);
  });

  /* =======================================================================
   * 3. RESCUE VIA THE FREE-TEXT SEARCH (reusing CoinLookup)
   * ===================================================================== */

  it('rescues a row with no candidates at all using the CoinLookup search', async () => {
    const { modal, inv } = createModal();
    const { peace } = stockInventory(inv);

    await selectFiles(modal, [CAMERA_NAME]);

    const row = rowFor(modal, CAMERA_NAME);
    expect(row.result.tier).toBe('not-imported');
    // Nothing ranked, so the candidate list cannot help; the search is the
    // only honest option for this row.
    expect(row.result.candidates).toEqual([]);

    sess(modal).openRescue(CAMERA_NAME);

    // This is CoinLookup, unchanged and reused: per-row term, capped results,
    // every typed word has to appear in the coin's label.
    sess(modal).coins.setTerm(CAMERA_NAME, 'p');
    expect(sess(modal).coins.results(CAMERA_NAME)).toEqual([]);   // under 2 chars = noise

    sess(modal).coins.setTerm(CAMERA_NAME, 'peace 1922');
    const hits = sess(modal).coins.results(CAMERA_NAME);
    expect(hits.map(c => c.id)).toEqual([peace.id]);

    sess(modal).rescueWithSearch(CAMERA_NAME, peace.id);

    const after = rowFor(modal, CAMERA_NAME);
    expect(after.decision).toBe('confirmed');
    expect(after.selected).toBe(true);
    expect(after.selectedCoinId).toBe(peace.id);
    // Stated outright rather than picked off a ranked list, so confidence 1 -
    // the same convention the ordinary manual assignment uses.
    expect(after.confidence).toBe(1);
    expect(after.selectionReason).toContain('Attached anyway');
    expect(sess(modal).attachCount()).toBe(1);
    // The panel closes and takes the half-typed search with it.
    expect(sess(modal).isRescueOpen(CAMERA_NAME)).toBe(false);
    expect(sess(modal).coins.term(CAMERA_NAME)).toBe('');
  });

  /* =======================================================================
   * 4. UNDO, AND WHAT AN UNTOUCHED ROW DOES
   * ===================================================================== */

  it('puts a rescued row straight back to skipped on Undo', async () => {
    const { modal, inv } = createModal();
    const { morgan } = stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE]);
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, morgan.id);
    expect(sess(modal).attachCount()).toBe(1);

    sess(modal).resetDecision(MORGAN_NO_GRADE);

    // Undo on a tier-3 row means "back to how the IMPORTER left it", which is
    // skipped - not 'review', which would quietly add it to a queue.
    const undone = rowFor(modal, MORGAN_NO_GRADE);
    expect(undone.decision).toBe('skipped');
    expect(undone.selectedCoinId).toBeNull();
    expect(undone.selected).toBe(false);
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('writes nothing at all for a tier-3 row the user never touched', async () => {
    const { modal, inv } = createModal();
    stockInventory(inv);
    const updateSpy = vi.spyOn(inv, 'updateCoin');

    await selectFiles(modal, [MORGAN_NO_GRADE, CAMERA_NAME]);
    await sess(modal).applyConfirmedMatches();

    // The whole batch was tier 3 and nothing was clicked, so the import is a
    // no-op: no coin written, nothing attached, and every file reported.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(inv.inventory().every(c => c.imagePaths.length === 0)).toBe(true);
    const summary = sess(modal).summary()!;
    expect(summary.attached).toBe(0);
    expect(summary.skipped).toBe(2);
  });

  it('attaches the rescued row and only the rescued row', async () => {
    const { modal, inv } = createModal();
    const { morgan, peace } = stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE, CAMERA_NAME]);
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, morgan.id);

    await sess(modal).applyConfirmedMatches();

    // Same route as a tier-2 confirmation: the row is simply 'confirmed' with
    // a coin, and attach-runner's ordinary filter picks it up. There is no
    // second attach path anywhere in this feature.
    expect(inv.inventory().find(c => c.id === morgan.id)!.imagePaths).toHaveLength(1);
    expect(inv.inventory().find(c => c.id === peace.id)!.imagePaths).toHaveLength(0);

    const summary = sess(modal).summary()!;
    expect(summary.attached).toBe(1);
    expect(summary.coinsTouched).toBe(1);
    // The untouched camera file is still counted as left out.
    expect(summary.skipped).toBe(1);
  });

  /* =======================================================================
   * 5. THE SUMMARY SENTENCE AT THE TOP OF THE SCREEN
   * ===================================================================== */

  it('moves a rescued photo out of "skipped" and into "will be attached"', async () => {
    const { modal, inv } = createModal();
    const { morgan } = stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE, CAMERA_NAME, 'Gold Coins.JPG']);

    const before = sess(modal).tierSummary();
    expect(before.total).toBe(3);
    expect(before.willAttach).toBe(0);
    expect(before.skipped).toBe(3);
    expect(before.rescued).toBe(0);
    expect(before.notImportedTotal).toBe(3);

    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, morgan.id);

    const after = sess(modal).tierSummary();
    expect(after.willAttach).toBe(1);
    // Reported as skipped only if it really will be skipped.
    expect(after.skipped).toBe(2);
    expect(after.rescued).toBe(1);
    // The read-only LIST is unchanged in length - the row is still in it, it
    // just reads as a decision now.
    expect(after.notImportedTotal).toBe(3);
    // The sub-counts are drawn from the still-skipped rows only.
    // Gold Coins.JPG (a group shot) and IM000025.JPG (a camera-default name)
    // are both vetoed as "not a single coin"; the rescued Morgan has left the
    // skipped counts altogether.
    expect(after.skippedNotACoin).toBe(2);
    expect(after.skippedNoMatch).toBe(0);
    // And the counters agree with what the attach run will actually do.
    expect(after.willAttach).toBe(sess(modal).readyToAttach().length);
  });

  /* =======================================================================
   * 6. PAGING
   * ===================================================================== */

  it('keeps the read-only list paged at 25 when a row on the page is rescued', async () => {
    const { modal, inv } = createModal();
    const { peace } = stockInventory(inv);

    // 60 camera-default names: all tier 3, none of them matchable.
    const names = Array.from({ length: 60 }, (_, i) => `IM0000${i}.JPG`);
    await selectFiles(modal, names);

    expect(sess(modal).notImported()).toHaveLength(60);
    expect(modal['visibleNotImported']()).toHaveLength(25);

    sess(modal).rescueWithSearch(names[3], peace.id);

    // The rescued row keeps its tier, so it keeps its position: the list is
    // still 60 long, still shows 25, and the rescued row has not jumped out
    // from under the cursor into another section.
    expect(sess(modal).notImported()).toHaveLength(60);
    expect(modal['visibleNotImported']()).toHaveLength(25);
    expect(modal['visibleNotImported']()[3].fileName).toBe(names[3]);
    expect(modal['rescuedLabels']()[names[3]]).toContain('Peace');

    modal['showMoreSkipped']();
    expect(modal['visibleNotImported']()).toHaveLength(50);
  });

  /* =======================================================================
   * 7. THE CONSTRAINT: THE BAR DOES NOT MOVE
   * ===================================================================== */

  it('does not change the tier assignment of a single file, however much is rescued', async () => {
    const { modal, inv } = createModal();
    const { morgan, peace } = stockInventory(inv);
    // A file that DOES clear all three auto gates, so tier 1 is represented
    // in the snapshot too.
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, [
      'mercury_dime_1945.jpg',   // tier 1
      MORGAN_NO_GRADE,           // tier 3, with candidates
      CAMERA_NAME,               // tier 3, with none
      'Gold Coins.JPG'           // tier 3, not a single coin at all
    ]);

    const before = tierMap(modal);
    const statusBefore = Object.fromEntries(
      sess(modal).imageReviews().map(r => [r.fileName, r.result.status])
    );

    // Rescue both kinds of tier-3 row, by both routes.
    sess(modal).openRescue(MORGAN_NO_GRADE);
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, morgan.id);
    sess(modal).openRescue(CAMERA_NAME);
    sess(modal).rescueWithSearch(CAMERA_NAME, peace.id);

    // THE ASSERTION THE OWNER ASKED FOR: the escape hatch is a UI override,
    // not a loosening of the matcher. Every file is classified exactly as it
    // was, and the matcher's own verdict (`status`) is untouched as well.
    expect(tierMap(modal)).toEqual(before);
    expect(Object.fromEntries(
      sess(modal).imageReviews().map(r => [r.fileName, r.result.status])
    )).toEqual(statusBefore);

    // The matcher still refuses to name a coin on a rescued row: the coin
    // lives on the user's DECISION, never on the match result.
    expect(rowFor(modal, MORGAN_NO_GRADE).result.matchedRecordId).toBeNull();
    expect(rowFor(modal, CAMERA_NAME).result.matchedRecordId).toBeNull();
    // ...and the skip reason is still recorded, so the row can still explain
    // itself in the read-only list.
    expect(rowFor(modal, MORGAN_NO_GRADE).result.skipReason).toBeTruthy();

    // The auto-assign gates are likewise untouched: tier 1 by tier and tier 1
    // by status still describe exactly the same set of files.
    expect(sess(modal).autoMatches()).toEqual(sess(modal).matchedImages());
    expect(sess(modal).matchedImages().map(r => r.fileName)).toEqual(['mercury_dime_1945.jpg']);
  });

  it('cannot be used as a back door into tier 1 or tier 2', async () => {
    const { modal, inv } = createModal();
    // Two Morgans that differ only by mint mark: a genuine TIER 2 row.
    const morganS = addCoin(inv, {
      coinType: 'Morgan', denomination: 'Dollar', year: '1881',
      mintMark: 'S', grade: 'MS63', certCompany: 'PCGS'
    });
    addCoin(inv, {
      coinType: 'Morgan', denomination: 'Dollar', year: '1881',
      mintMark: 'O', grade: 'MS63', certCompany: 'PCGS'
    });
    const mercury = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, [
      '1881 Morgan Dollar PCGS MS63 - Obverse.jpg',   // tier 2
      'mercury_dime_1945.jpg'                          // tier 1
    ]);

    const nearFile = '1881 Morgan Dollar PCGS MS63 - Obverse.jpg';
    expect(rowFor(modal, nearFile).result.tier).toBe('near');

    // The rescue functions are gated on tier 'not-imported' precisely so they
    // cannot be used to sidestep tier 2's "only candidates that passed the
    // near-match test" dropdown rule, or to re-point a tier-1 row.
    sess(modal).rescueWithCandidate(nearFile, morganS.id);
    expect(rowFor(modal, nearFile).selectedCoinId).toBeNull();
    expect(rowFor(modal, nearFile).decision).toBe('review');

    sess(modal).rescueWithSearch('mercury_dime_1945.jpg', morganS.id);
    expect(rowFor(modal, 'mercury_dime_1945.jpg').selectedCoinId).toBe(mercury.id);
  });

  it('forgets every open panel when the modal is closed', async () => {
    const { modal, inv } = createModal();
    stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE]);
    sess(modal).openRescue(MORGAN_NO_GRADE);
    expect(sess(modal).rescueOpen().size).toBe(1);

    modal['close']();

    expect(sess(modal).rescueOpen().size).toBe(0);
    expect(sess(modal).imageReviews()).toHaveLength(0);
  });
});

/* ===========================================================================
 * PART 3 -- THE ROWS THAT GET NO HATCH, AND THE LINE THAT PROTECTS
 * ---------------------------------------------------------------------------
 * Counterfeits and multi-coin shots are the one group tier 3 does NOT offer
 * to rescue. The owner, about the group shots, and he said the same about the
 * fakes:
 *
 *   "Never automatically attach nor offer as attachable in the automated
 *    import. A user can try to manually choose such a photo manually at a
 *    later time to attach to a coin(s)."
 *   "Ignore the Fake coins."
 *
 * Everything in PART 1 and PART 2 above is the "attachable in the automated
 * import" that those rows must not have. So these tests are the mirror image
 * of those: the same controls, asserted absent.
 *
 * THE OTHER HALF IS EQUALLY LOAD-BEARING, AND IT IS WHY THIS IS NOT SIMPLY
 * "HIDE THE ROW". He was explicit that the restriction stops at the automated
 * run:
 *
 *   "I never want a picture file to be off limits from choosing to attach to
 *    a coin even if the descriptor has nothing relevant to the coin itself."
 *   "Maybe it's an article about the coin or something like that that I'd
 *    want to attach."
 *   "I should be able to manually add a Fake coin to my inventory, just don't
 *    worry about automating such a thing."
 *
 * So the asymmetry below -- withheld by the importer, freely available by
 * hand -- is the actual requirement, and it is the thing a future change is
 * most likely to break silently. Both sides are pinned.
 * ========================================================================= */

/** Verbatim from the share. Complete, valid descriptor; the coin is a fake. */
const COUNTERFEIT_PHOTO = 'FAKE - 1860 3CS - VF - Obverse.jpg';
/** Verbatim from the share. Several coins in one frame. */
const COLLAGE_PHOTO = '20¢ Collage.jpg';
/** Constructed: a name with NOTHING in it that relates to any coin at all. */
const UNRELATED_PHOTO = 'scan of auction catalogue page 47.png';

describe('tier 3 — photos the automated import will not offer', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  /** Three genuine 1860/1861 three-cent silvers — the collision he actually has. */
  function threeCentInventory(inv: InventoryService) {
    return {
      genuine1860: addCoin(inv, {
        coinType: 'Three Cent Silver', denomination: '3CS', year: '1860', grade: 'VF'
      }),
      genuine1861: addCoin(inv, {
        coinType: 'Three Cent Silver', denomination: '3CS', year: '1861', grade: 'XF'
      }),
      /* And the counterfeit he really does hold as an inventory record. It is
       * in the inventory exactly like any other coin — it has to be, because
       * he asked to be able to add one by hand — and the only thing different
       * about it is that the automated matcher will not consider it. */
      fakeRecord: addCoin(inv, {
        coinType: 'Three Cent Silver FAKE', denomination: '3CS', year: '1861', grade: 'XF45'
      })
    };
  }

  it('lists the row, with its reason, and offers no "Attach anyway" link', async () => {
    const { modal, inv } = createModal();
    threeCentInventory(inv);

    await selectFiles(modal, [COUNTERFEIT_PHOTO, COLLAGE_PHOTO, MORGAN_NO_GRADE]);

    for (const file of [COUNTERFEIT_PHOTO, COLLAGE_PHOTO]) {
      const row = rowFor(modal, file);

      // VISIBLE. Nothing silently disappears; this is the whole reason the
      // rule is "do not offer" rather than "do not list".
      expect(sess(modal).notImported().map(r => r.fileName), file).toContain(file);
      expect(row.result.skipReason, `${file} reason`).toBeTruthy();

      // ...but with no hatch. `canRescue` is what the template branches on.
      expect(sess(modal).canRescue(file), `${file} canRescue`).toBe(false);
      // And no ranked list behind it either, so even a rendered panel would
      // have nothing in it.
      expect(row.result.candidates, `${file} candidates`).toEqual([]);
    }

    /* The ordinary tier-3 row in the same run is untouched: this is a rule
     * about two kinds of photo, not a weakening of the hatch itself. Note it
     * keeps its hatch even though this inventory holds no Morgan for it, so
     * it has no ranked candidates either — what is withdrawn above is the
     * OFFER, and an empty candidate list is not the same thing. */
    expect(rowFor(modal, MORGAN_NO_GRADE).result.tier).toBe('not-imported');
    expect(sess(modal).canRescue(MORGAN_NO_GRADE)).toBe(true);
  });

  it('cannot be rescued even if something calls the rescue functions directly', async () => {
    const { modal, inv } = createModal();
    const { genuine1860 } = threeCentInventory(inv);

    await selectFiles(modal, [COUNTERFEIT_PHOTO, COLLAGE_PHOTO]);

    for (const file of [COUNTERFEIT_PHOTO, COLLAGE_PHOTO]) {
      // Opening is a no-op, so a stale click cannot even reveal the panel.
      sess(modal).openRescue(file);
      expect(sess(modal).isRescueOpen(file), `${file} isRescueOpen`).toBe(false);

      // And both rescue paths refuse. The template already hides the link;
      // these guards are the same rule where it cannot be bypassed.
      sess(modal).rescueWithCandidate(file, genuine1860.id);
      sess(modal).rescueWithSearch(file, genuine1860.id);

      expect(rowFor(modal, file).selectedCoinId, `${file} selectedCoinId`).toBeNull();
      expect(rowFor(modal, file).decision, `${file} decision`).toBe('skipped');
    }

    expect(sess(modal).attachCount()).toBe(0);
  });

  it('keeps a counterfeit RECORD out of the automated candidate pool', async () => {
    /* The same rule pointing the other way, and the reason it is needed: a
     * GENUINE 1861 3CS photograph must not land on the record
     * "1861 3CS - XF45 - FAKE". He owns five real 1861 3CS records and three
     * counterfeit ones, so this collision is live in his actual data. */
    const { modal, inv } = createModal();
    const { genuine1861, fakeRecord } = threeCentInventory(inv);

    await selectFiles(modal, ['1861 3CS - XF45 - Obverse.jpg']);

    const row = rowFor(modal, '1861 3CS - XF45 - Obverse.jpg');
    const reachable = [
      row.result.matchedRecordId,
      ...row.result.candidates.map(c => c.coinId),
      ...(row.result.nearMatch?.candidates ?? []).map(c => c.coinId)
    ].filter(Boolean);

    expect(reachable, 'the fake record must be unreachable automatically')
      .not.toContain(fakeRecord.id);
    // The genuine record of the same date and grade is still perfectly
    // reachable, so this is a filter and not a blanket refusal.
    expect(reachable).toContain(genuine1861.id);
  });

  /* =======================================================================
   * THE OTHER SIDE OF THE LINE: EVERYTHING MANUAL STILL WORKS
   * ===================================================================== */

  it('still finds a FAKE record in the free-text coin search', () => {
    /* The single most likely way to break his instruction by accident. The
     * exclusion lives in `buildCoinSignatures`, which only the automated
     * matcher calls; implement it one level lower — in the inventory service,
     * or in `searchCoins` — and the fake would vanish from the manual search
     * too, which is the escape hatch his whole answer depends on. */
    const { modal, inv } = createModal();
    const { fakeRecord } = threeCentInventory(inv);
    const matching = new ImageMatchingService();

    const hits = searchCoins(inv.inventory(), 'fake', coin => matching.describeCoin(coin));

    expect(hits.map(c => c.id), 'a fake must stay findable by hand').toContain(fakeRecord.id);
    // ...and it is a normal inventory row in every other respect.
    expect(inv.inventory().map(c => c.id)).toContain(fakeRecord.id);
    expect(sess(modal).imageReviews()).toHaveLength(0);
  });

  it('lets any file whatsoever be attached to any coin by hand', async () => {
    /* "I never want a picture file to be off limits from choosing to attach
     *  to a coin even if the descriptor has nothing relevant to the coin
     *  itself." — so this runs the three worst cases through the manual
     *  assignment path: a counterfeit, a collage, and a scan that is not a
     *  photograph of a coin at all ("Maybe it's an article about the coin or
     *  something like that that I'd want to attach").
     *
     * `assignCoin` is the import screen's own by-hand path and is NOT gated
     * on the tier, which is what makes it the right thing to assert here. The
     * per-coin image gallery is a separate route again and never consults the
     * matcher at all, so it cannot be affected by any of this. */
    const { modal, inv } = createModal();
    const { genuine1860, fakeRecord } = threeCentInventory(inv);

    await selectFiles(modal, [COUNTERFEIT_PHOTO, COLLAGE_PHOTO, UNRELATED_PHOTO]);

    for (const file of [COUNTERFEIT_PHOTO, COLLAGE_PHOTO, UNRELATED_PHOTO]) {
      // The file was read and listed in the first place — no marker may make
      // a file invisible or unselectable.
      expect(rowFor(modal, file), `${file} is present`).toBeTruthy();

      sess(modal).reassignImageMatch(file, genuine1860.id);

      const row = rowFor(modal, file);
      expect(row.selectedCoinId, `${file} attached by hand`).toBe(genuine1860.id);
      expect(row.decision, `${file} decision`).toBe('confirmed');
      expect(row.selected, `${file} ticked`).toBe(true);
      // Stated by the user, so confidence is 1 by definition — the matcher's
      // opinion of the pairing does not enter into it.
      expect(row.confidence, `${file} confidence`).toBe(1);
    }

    expect(sess(modal).attachCount()).toBe(3);

    // And a fake RECORD is just as available by hand as any other coin.
    sess(modal).reassignImageMatch(COUNTERFEIT_PHOTO, fakeRecord.id);
    expect(rowFor(modal, COUNTERFEIT_PHOTO).selectedCoinId).toBe(fakeRecord.id);
  });
});
