/*
 * Tier 3 "Attach anyway": a skipped row can be rescued from the matcher's ranked
 * candidates or from the free-text search, an untouched row stays skipped, and
 * rescuing never changes any file's tier (checked with a before/after snapshot
 * rather than pinning exact tiers, which belong to near-match.ts).
 */

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

/** Reaches the protected session through a cast. */
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

/* Fixture: scores highly against a Morgan record, but the filename states no
 * grade, so the near-match bar refuses it. */
const MORGAN_NO_GRADE = '1881 Morgan Dollar NGC 2599001.jpg';

/** A camera-default name: tier 3 with no candidates, so only the search can place it. */
const CAMERA_NAME = 'IM000025.JPG';

describe('tier 3 — the opt-in "Attach anyway" escape hatch', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  /** The inventory used throughout: one well-filled Morgan, one unrelated coin. */
  function stockInventory(inv: InventoryService) {
    return {
      /* Two complete 1881 Morgan records: the filename's missing grade fails the
             * near-match bar, and two equal fits fail the auto-assign gates. Neither
             * record has the filename's cert number, which would attach it outright. */
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

  /* 1. Opt-in */

  it('shows no control state and asks nothing until the user opens a row', async () => {
    const { modal, inv } = createModal();
    stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE, CAMERA_NAME]);

    // Both files are in the read-only tier and already skipped by the importer.
    expect(sess(modal).notImported().map(r => r.fileName).sort())
      .toEqual([CAMERA_NAME, MORGAN_NO_GRADE].sort());
    expect(sess(modal).imageReviews().every(r => r.decision === 'skipped')).toBe(true);

    // Nothing is open, so no rescue panel is rendered.
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

  /* 2. Rescue via the matcher's ranked candidates */

  it('rescues a skipped row from the ranked candidates the matcher already produced', async () => {
    const { modal, inv } = createModal();
    const { morgan } = stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE]);

    const before = rowFor(modal, MORGAN_NO_GRADE);
    expect(before.result.tier).toBe('not-imported');
    expect(before.result.candidates.length).toBeGreaterThan(0);
    expect(before.result.candidates.map(c => c.coinId)).toContain(morgan.id);
    expect(before.result.candidates[0].score).toBeGreaterThan(0.5);

    sess(modal).openRescue(MORGAN_NO_GRADE);
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, before.result.candidates[0].coinId);

    const after = rowFor(modal, MORGAN_NO_GRADE);
    expect(after.decision).toBe('confirmed');
    expect(after.selected).toBe(true);
    expect(after.selectedCoinId).toBe(before.result.candidates[0].coinId);
    // The matcher's score is kept: the user overrode the bar, not the score.
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
    // Ids come from the DOM, so only coins ranked for this file may be attached.
    expect(rowFor(modal, MORGAN_NO_GRADE).result.candidates.map(c => c.coinId))
      .not.toContain('no-such-coin');
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, 'no-such-coin');

    expect(rowFor(modal, MORGAN_NO_GRADE).selectedCoinId).toBeNull();
    expect(sess(modal).attachCount()).toBe(0);
  });

  /* 3. Rescue via the free-text search (CoinLookup) */

  it('rescues a row with no candidates at all using the CoinLookup search', async () => {
    const { modal, inv } = createModal();
    const { peace } = stockInventory(inv);

    await selectFiles(modal, [CAMERA_NAME]);

    const row = rowFor(modal, CAMERA_NAME);
    expect(row.result.tier).toBe('not-imported');
    expect(row.result.candidates).toEqual([]);

    sess(modal).openRescue(CAMERA_NAME);

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
    // Chosen by the user, so confidence 1, as with ordinary manual assignment.
    expect(after.confidence).toBe(1);
    expect(after.selectionReason).toContain('Attached anyway');
    expect(sess(modal).attachCount()).toBe(1);
    // The panel closes and takes the half-typed search with it.
    expect(sess(modal).isRescueOpen(CAMERA_NAME)).toBe(false);
    expect(sess(modal).coins.term(CAMERA_NAME)).toBe('');
  });

  /* 4. Undo, and untouched rows */

  it('puts a rescued row straight back to skipped on Undo', async () => {
    const { modal, inv } = createModal();
    const { morgan } = stockInventory(inv);

    await selectFiles(modal, [MORGAN_NO_GRADE]);
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, morgan.id);
    expect(sess(modal).attachCount()).toBe(1);

    sess(modal).resetDecision(MORGAN_NO_GRADE);

    // Undo returns a tier-3 row to skipped, not to 'review'.
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

    // Rescued rows use the ordinary attach path, like a tier-2 confirmation.
    expect(inv.inventory().find(c => c.id === morgan.id)!.imagePaths).toHaveLength(1);
    expect(inv.inventory().find(c => c.id === peace.id)!.imagePaths).toHaveLength(0);

    const summary = sess(modal).summary()!;
    expect(summary.attached).toBe(1);
    expect(summary.coinsTouched).toBe(1);
    // The untouched camera file is still counted as left out.
    expect(summary.skipped).toBe(1);
  });

  /* 5. Summary sentence */

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
    // The list keeps the row; it just reads as a decision now.
    expect(after.notImportedTotal).toBe(3);
    // Sub-counts use only still-skipped rows: Gold Coins.JPG and IM000025.JPG
        // are both "not a single coin".
    expect(after.skippedNotACoin).toBe(2);
    expect(after.skippedNoMatch).toBe(0);
    expect(after.willAttach).toBe(sess(modal).readyToAttach().length);
  });

  /* 6. Paging */

  it('keeps the read-only list paged at 25 when a row on the page is rescued', async () => {
    const { modal, inv } = createModal();
    const { peace } = stockInventory(inv);

    // 60 camera-default names: all tier 3, none of them matchable.
    const names = Array.from({ length: 60 }, (_, i) => `IM0000${i}.JPG`);
    await selectFiles(modal, names);

    expect(sess(modal).notImported()).toHaveLength(60);
    expect(modal['visibleNotImported']()).toHaveLength(25);

    sess(modal).rescueWithSearch(names[3], peace.id);

    // The rescued row keeps its tier and its position in the list.
    expect(sess(modal).notImported()).toHaveLength(60);
    expect(modal['visibleNotImported']()).toHaveLength(25);
    // Pages are of photo sets; camera names never group, so one file each.
    expect(modal['visibleNotImported']()[3].leadFileName).toBe(names[3]);
    expect(modal['rescuedLabels']()[names[3]]).toContain('Peace');

    modal['showMoreSkipped']();
    expect(modal['visibleNotImported']()).toHaveLength(50);
  });

  /* 7. Rescuing never changes the tier assignment */

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

    sess(modal).openRescue(MORGAN_NO_GRADE);
    sess(modal).rescueWithCandidate(MORGAN_NO_GRADE, morgan.id);
    sess(modal).openRescue(CAMERA_NAME);
    sess(modal).rescueWithSearch(CAMERA_NAME, peace.id);

    // The rescue is a UI override, not a loosening of the matcher: tiers and
        // the matcher's own status are unchanged.
    expect(tierMap(modal)).toEqual(before);
    expect(Object.fromEntries(
      sess(modal).imageReviews().map(r => [r.fileName, r.result.status])
    )).toEqual(statusBefore);

    // The coin lives on the user's decision, never on the match result.
    expect(rowFor(modal, MORGAN_NO_GRADE).result.matchedRecordId).toBeNull();
    expect(rowFor(modal, CAMERA_NAME).result.matchedRecordId).toBeNull();
    expect(rowFor(modal, MORGAN_NO_GRADE).result.skipReason).toBeTruthy();

    // The auto-assign gates are untouched too.
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

    // Rescue is gated on tier 'not-imported', so it cannot bypass tier 2's
        // dropdown rule or re-point a tier-1 row.
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

/*
 * Part 3: rows with no "Attach anyway". Multi-coin shots are listed but never
 * offered by the automated import, while a manual attach of any file stays
 * available. Both sides are tested.
 */

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

  /** Three genuine 1860/1861 three-cent silvers — a real-world collision. */
  function threeCentInventory(inv: InventoryService) {
    return {
      genuine1860: addCoin(inv, {
        coinType: 'Three Cent Silver', denomination: '3CS', year: '1860', grade: 'VF'
      }),
      genuine1861: addCoin(inv, {
        coinType: 'Three Cent Silver', denomination: '3CS', year: '1861', grade: 'XF'
      }),
      /* A counterfeit held as an ordinary inventory record; only the automated
             * matcher ignores it. */
      fakeRecord: addCoin(inv, {
        coinType: 'Three Cent Silver FAKE', denomination: '3CS', year: '1861', grade: 'XF45'
      })
    };
  }

  it('lists the row, with its reason, and offers no "Attach anyway" link', async () => {
    const { modal, inv } = createModal();
    threeCentInventory(inv);

    await selectFiles(modal, [COUNTERFEIT_PHOTO, COLLAGE_PHOTO, MORGAN_NO_GRADE]);

    // Counterfeit photos are ordinary rows and may be rescued.
    expect(sess(modal).canRescue(COUNTERFEIT_PHOTO)).toBe(true);

    for (const file of [COLLAGE_PHOTO]) {
      const row = rowFor(modal, file);

      // Still listed, so nothing silently disappears.
      expect(sess(modal).notImported().map(r => r.fileName), file).toContain(file);
      expect(row.result.skipReason, `${file} reason`).toBeTruthy();

      // `canRescue` is what the template branches on.
      expect(sess(modal).canRescue(file), `${file} canRescue`).toBe(false);
      expect(row.result.candidates, `${file} candidates`).toEqual([]);
    }

    /* The ordinary tier-3 row keeps its "Attach anyway" even with no ranked
         * candidates: what is withheld above is the offer itself. */
    expect(rowFor(modal, MORGAN_NO_GRADE).result.tier).toBe('not-imported');
    expect(sess(modal).canRescue(MORGAN_NO_GRADE)).toBe(true);
  });

  it('cannot be rescued even if something calls the rescue functions directly', async () => {
    const { modal, inv } = createModal();
    const { genuine1860 } = threeCentInventory(inv);

    await selectFiles(modal, [COLLAGE_PHOTO]);

    for (const file of [COLLAGE_PHOTO]) {
      // Opening is a no-op, so a stale click cannot reveal the panel.
      sess(modal).openRescue(file);
      expect(sess(modal).isRescueOpen(file), `${file} isRescueOpen`).toBe(false);

      // Both rescue paths refuse too, behind the hidden link.
      sess(modal).rescueWithCandidate(file, genuine1860.id);
      sess(modal).rescueWithSearch(file, genuine1860.id);

      expect(rowFor(modal, file).selectedCoinId, `${file} selectedCoinId`).toBeNull();
      expect(rowFor(modal, file).decision, `${file} decision`).toBe('skipped');
    }

    expect(sess(modal).attachCount()).toBe(0);
  });

  it('keeps a counterfeit RECORD away from a genuine photograph', async () => {
    /* A genuine 1861 3CS photo must not land on the counterfeit
         * "1861 3CS - XF45 - FAKE" record. */
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
    // The genuine record is still reachable: a filter, not a blanket refusal.
    expect(reachable).toContain(genuine1861.id);
  });

  /* Manual routes still work */

  it('still finds a FAKE record in the free-text coin search', () => {
    /* The exclusion lives in `buildCoinSignatures`, which only the automated
         * matcher calls; moving it lower would hide fakes from manual search too. */
    const { modal, inv } = createModal();
    const { fakeRecord } = threeCentInventory(inv);
    const matching = new ImageMatchingService();

    const hits = searchCoins(inv.inventory(), 'fake', coin => matching.describeCoin(coin));

    expect(hits.map(c => c.id), 'a fake must stay findable by hand').toContain(fakeRecord.id);
    expect(inv.inventory().map(c => c.id)).toContain(fakeRecord.id);
    expect(sess(modal).imageReviews()).toHaveLength(0);
  });

  it('lets any file whatsoever be attached to any coin by hand', async () => {
    /* Any file can be attached by hand. `assignCoin` is the import screen's
         * manual path and is not gated on tier. */
    const { modal, inv } = createModal();
    const { genuine1860, fakeRecord } = threeCentInventory(inv);

    await selectFiles(modal, [COUNTERFEIT_PHOTO, COLLAGE_PHOTO, UNRELATED_PHOTO]);

    for (const file of [COUNTERFEIT_PHOTO, COLLAGE_PHOTO, UNRELATED_PHOTO]) {
      // No marker may make a file invisible or unselectable.
      expect(rowFor(modal, file), `${file} is present`).toBeTruthy();

      sess(modal).reassignImageMatch(file, genuine1860.id);

      const row = rowFor(modal, file);
      expect(row.selectedCoinId, `${file} attached by hand`).toBe(genuine1860.id);
      expect(row.decision, `${file} decision`).toBe('confirmed');
      expect(row.selected, `${file} ticked`).toBe(true);
      // Chosen by the user, so confidence is 1.
      expect(row.confidence, `${file} confidence`).toBe(1);
    }

    expect(sess(modal).attachCount()).toBe(3);

    sess(modal).reassignImageMatch(COUNTERFEIT_PHOTO, fakeRecord.id);
    expect(rowFor(modal, COUNTERFEIT_PHOTO).selectedCoinId).toBe(fakeRecord.id);
  });
});

/*
 * Part 4: photo sets. In tier 3 one row's "Attach anyway" and Undo cover every
 * shot of a coin; in tier 2 an answer carries to the set's untouched members,
 * including one (typically the slab label) that landed in tier 3.
 */
describe('photo sets — one decision for every shot of one coin', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  const MORGAN_SET = [
    '1881 Morgan Dollar NGC 2599001 - Obverse.jpg',
    '1881 Morgan Dollar NGC 2599001 - Reverse.jpg',
    '1881 Morgan Dollar NGC 2599001 - Slab Label.jpg',
    '1881 Morgan Dollar NGC 2599001 - Obverse 2.jpg'
  ];

  function twoMorgans(inv: InventoryService) {
    return {
      morgan: addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S', grade: 'MS63' }),
      morganAlt: addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'O', grade: 'MS64' })
    };
  }

  it('lists the four shots of one coin as ONE tier-3 row', async () => {
    const { modal, inv } = createModal();
    twoMorgans(inv);
    await selectFiles(modal, MORGAN_SET);

    expect(sess(modal).notImported()).toHaveLength(4);
    const sets = sess(modal).notImportedSets();
    expect(sets).toHaveLength(1);
    expect(sets[0].descriptor).toBe('1881 Morgan Dollar NGC 2599001');
    expect(sets[0].rows).toHaveLength(4);
  });

  it('attaches the whole set with one "Attach anyway", and Undo takes it all back', async () => {
    const { modal, inv } = createModal();
    const { morgan } = twoMorgans(inv);
    await selectFiles(modal, MORGAN_SET);

    const lead = sess(modal).notImportedSets()[0].leadFileName;
    sess(modal).openRescue(lead);
    sess(modal).rescueWithCandidate(lead, morgan.id);

    for (const file of MORGAN_SET) {
      expect(rowFor(modal, file).selectedCoinId, file).toBe(morgan.id);
      expect(rowFor(modal, file).decision, file).toBe('confirmed');
    }
    expect(sess(modal).attachCount()).toBe(4);
    expect(sess(modal).isRescueOpen(lead)).toBe(false);

    sess(modal).resetPhotoSet(lead);
    for (const file of MORGAN_SET) {
      expect(rowFor(modal, file).selectedCoinId, file).toBeNull();
      expect(rowFor(modal, file).decision, file).toBe('skipped');
    }
    expect(sess(modal).attachCount()).toBe(0);
  });

  it('attaches the whole set from the free-text search too', async () => {
    const { modal, inv } = createModal();
    const { morganAlt } = twoMorgans(inv);
    await selectFiles(modal, MORGAN_SET);

    const lead = sess(modal).notImportedSets()[0].leadFileName;
    sess(modal).rescueWithSearch(lead, morganAlt.id);
    expect(sess(modal).attachCount()).toBe(4);
  });

  /* Tier 2: two 1881-S/O PCGS MS63 Morgans differing only by mint mark make
   * every side a near match; the label shot may land in either tier. */
  const NEAR_SET = [
    '1881 Morgan Dollar PCGS MS63 - Obverse.jpg',
    '1881 Morgan Dollar PCGS MS63 - Reverse.jpg',
    '1881 Morgan Dollar PCGS MS63 - Label.jpg'
  ];

  function ambiguousMorgans(inv: InventoryService) {
    return {
      morganS: addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S', grade: 'MS63', certCompany: 'PCGS' }),
      morganO: addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'O', grade: 'MS63', certCompany: 'PCGS' })
    };
  }

  it('carries a tier-2 Attach on one photo to the rest of its set', async () => {
    const { modal, inv } = createModal();
    ambiguousMorgans(inv);
    await selectFiles(modal, NEAR_SET);

    sess(modal).acceptNearMatch(NEAR_SET[0]);
    const coinId = rowFor(modal, NEAR_SET[0]).selectedCoinId;
    expect(coinId).toBeTruthy();

    for (const file of NEAR_SET) {
      expect(rowFor(modal, file).selectedCoinId, file).toBe(coinId);
      expect(rowFor(modal, file).decision, file).toBe('confirmed');
    }
    expect(sess(modal).outstandingCount()).toBe(0);
  });

  it('carries a different coin picked from the dropdown to the rest of the set', async () => {
    const { modal, inv } = createModal();
    const { morganS, morganO } = ambiguousMorgans(inv);
    await selectFiles(modal, NEAR_SET);

    const suggested = rowFor(modal, NEAR_SET[0]).result.nearMatch!.suggestedCoinId;
    const other = suggested === morganS.id ? morganO.id : morganS.id;
    sess(modal).chooseNearCandidate(NEAR_SET[0], other);

    for (const file of NEAR_SET) {
      expect(rowFor(modal, file).selectedCoinId, file).toBe(other);
    }
  });

  it('never overrides a set member the user already answered', async () => {
    const { modal, inv } = createModal();
    ambiguousMorgans(inv);
    await selectFiles(modal, NEAR_SET);

    sess(modal).skipImage(NEAR_SET[1]);
    sess(modal).acceptNearMatch(NEAR_SET[0]);

    expect(rowFor(modal, NEAR_SET[1]).decision).toBe('skipped');
    expect(rowFor(modal, NEAR_SET[1]).selectedCoinId).toBeNull();
  });

  it('pulls a tier-3 set member (the label) in behind a tier-2 Attach', async () => {
    const { modal, inv } = createModal();
    ambiguousMorgans(inv);
    // The obverse names the coin; the label must follow whatever tier it lands in.
    const files = ['1881 Morgan Dollar PCGS MS63 - Obverse.jpg', '1881 Morgan Dollar PCGS MS63 - Slab Label.jpg'];
    await selectFiles(modal, files);

    sess(modal).acceptNearMatch(files[0]);
    const coinId = rowFor(modal, files[0]).selectedCoinId;
    expect(rowFor(modal, files[1]).selectedCoinId).toBe(coinId);
    expect(sess(modal).attachCount()).toBe(2);
  });
});
