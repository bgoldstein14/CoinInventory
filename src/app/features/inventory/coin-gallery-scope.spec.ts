/* ===========================================================================
 * coin-gallery-scope.spec.ts
 * ---------------------------------------------------------------------------
 * "When I hit the Images button for the coin, I expect to only see the images
 *  for that coin, not all images."
 *
 * ---------------------------------------------------------------------------
 * WHAT THE INVESTIGATION FOUND, so nobody has to repeat it
 * ---------------------------------------------------------------------------
 * There is NO cross-coin leak anywhere in the code. The gallery renders
 * `coin().imagePaths` and nothing else; the App shell binds `coin` to the
 * single selected coin; the server groups image rows strictly by CoinId
 * (server/routes/coins/list-query.ts); and the batch import buckets its rows
 * by `selectedCoinId` and merges each bucket into that coin's own array
 * (services/image-import/attach-runner.ts). The first three groups of tests
 * below pin all of that down as a property, so a future change that does
 * introduce a leak fails here.
 *
 * Two things explain the symptom instead, and the last group documents the
 * second one:
 *
 *   1. THE GALLERY HAD NO MODAL STYLING. `coin-image-gallery.scss` never
 *      imported `styles/_modal.scss`, so `.modal-backdrop` had no rules —
 *      no fixed position, no dimmed overlay, no card. The gallery rendered
 *      INLINE underneath the inventory table, and the inventory table has a
 *      Photo column. What was on screen was therefore every coin's thumbnail
 *      plus a small unstyled strip of this coin's photos below it, which
 *      reads exactly like "all the images". (The identical omission had
 *      already been found and fixed in the Settings dialog.) Pure CSS, so
 *      there is nothing to assert here — see the note in the stylesheet.
 *
 *   2. THE MATCHER LEGITIMATELY PILES A WHOLE FOLDER ONTO ONE COIN. The
 *      auto-match gates are per-FILE: nothing caps how many files may land on
 *      the same record. A folder of 20-cent photos matched against an
 *      inventory holding one 20-cent record puts all of them on that record —
 *      including shots of a DIFFERENT physical coin whose filename happens
 *      not to contradict it. That coin's gallery then really does hold a
 *      folder's worth of photos. It is a matching-accuracy question, not a
 *      scoping bug, and `describe('the import can legitimately...')` below
 *      captures the exact behaviour so a future tuning change is visible.
 * =========================================================================== */

import 'fake-indexeddb/auto';
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinImagesStore } from './coin-images.store';
import { runAttach } from '../../services/image-import/attach-runner';
import { ImageMatchingService } from '../../services/image-matching.service';
import { imageSourcePaths } from '../../services/image-source-paths';
import { BatchImageRow, CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 100, currentValue: 150, notes: '',
    imagePaths: [], source: 'manual',
    ...overrides
  };
}

const MORGAN_OBVERSE = 'data:image/jpeg;base64,MORGAN-OBVERSE';
const MORGAN_REVERSE = 'data:image/jpeg;base64,MORGAN-REVERSE';
const EAGLE_OBVERSE = 'data:image/jpeg;base64,EAGLE-OBVERSE';

/**
 * Two coins with photos of their own, plus a third with none at all — the
 * case the gallery could not previously be opened in.
 */
function createTwoCoinInventory() {
  const harness = createTestInventoryService();
  harness.inv.inventory.set([
    makeCoin({ id: 'morgan', imagePaths: [MORGAN_OBVERSE, MORGAN_REVERSE] }),
    makeCoin({ id: 'eagle', denomination: 'Eagle', coinType: 'Gold', imagePaths: [EAGLE_OBVERSE] }),
    makeCoin({ id: 'empty', denomination: 'Dime', coinType: 'Roosevelt', imagePaths: [] })
  ]);
  return { ...harness, store: new CoinImagesStore(harness.inv) };
}

/** The photos the gallery would render for a coin — it binds exactly this. */
function galleryImagesFor(inv: { inventory: () => CoinRecord[] }, coinId: string): string[] {
  return inv.inventory().find(c => c.id === coinId)!.imagePaths;
}

/* ===========================================================================
 * 1. The property the owner asked for: two coins, two disjoint galleries
 * ========================================================================= */

describe('a coin\'s gallery shows that coin\'s photos and no others', () => {
  beforeEach(() => {
    vi.useFakeTimers(); // CoinEditor debounces its PUT by a second.
    imageSourcePaths.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    imageSourcePaths.clear();
  });

  it('gives two coins completely disjoint image sets', () => {
    const { inv } = createTwoCoinInventory();

    const morgan = galleryImagesFor(inv, 'morgan');
    const eagle = galleryImagesFor(inv, 'eagle');

    expect(morgan).toEqual([MORGAN_OBVERSE, MORGAN_REVERSE]);
    expect(eagle).toEqual([EAGLE_OBVERSE]);
    // The property itself, stated directly rather than implied by the two
    // assertions above: not one image appears in both galleries.
    expect(morgan.filter(p => eagle.includes(p))).toEqual([]);
  });

  it('switches the whole set when the selected coin changes', () => {
    // This is what the Images button on a table row does: select the coin,
    // then open the overlay. The gallery is bound to the selected coin, so
    // selecting a different one replaces the contents outright.
    const { inv, store } = createTwoCoinInventory();

    inv.selectedCoinId.set('morgan');
    store.openImageGallery();
    expect(inv.selectedCoin()!.imagePaths).toEqual([MORGAN_OBVERSE, MORGAN_REVERSE]);

    inv.selectedCoinId.set('eagle');
    expect(inv.selectedCoin()!.imagePaths).toEqual([EAGLE_OBVERSE]);
  });

  it('does not alias one array across records — a change to one is invisible to the other', () => {
    // The aliasing check. If any part of the load or merge path handed two
    // coins THE SAME array object, deleting a photo from one would delete it
    // from the other, and every gallery would end up showing the same list.
    const { inv, store } = createTwoCoinInventory();

    inv.selectedCoinId.set('morgan');
    store.removeCoinImage(MORGAN_OBVERSE);

    expect(galleryImagesFor(inv, 'morgan')).toEqual([MORGAN_REVERSE]);
    expect(galleryImagesFor(inv, 'eagle')).toEqual([EAGLE_OBVERSE]);
  });

  it('adds a photo only to the selected coin', async () => {
    const { inv, store } = createTwoCoinInventory();
    inv.selectedCoinId.set('eagle');

    await store.addCoinImages({
      target: { files: [new File(['x'], 'new.jpg', { type: 'image/jpeg' })], value: '' }
    } as unknown as Event);

    expect(galleryImagesFor(inv, 'eagle')).toHaveLength(2);
    expect(galleryImagesFor(inv, 'morgan')).toEqual([MORGAN_OBVERSE, MORGAN_REVERSE]);
    expect(galleryImagesFor(inv, 'empty')).toEqual([]);
  });

  it('re-orders only the selected coin when a main photo is chosen', () => {
    // setMainImage rewrites an array in place of another; the sibling coins
    // must not notice.
    const { inv, store } = createTwoCoinInventory();
    inv.selectedCoinId.set('morgan');

    store.setMainImage(MORGAN_REVERSE);
    vi.advanceTimersByTime(2000);

    expect(galleryImagesFor(inv, 'morgan')).toEqual([MORGAN_REVERSE, MORGAN_OBVERSE]);
    expect(galleryImagesFor(inv, 'eagle')).toEqual([EAGLE_OBVERSE]);
  });
});

/* ===========================================================================
 * 2. The gallery opens for a coin with no photos at all
 * ========================================================================= */

describe('the gallery opens for a coin with no photos', () => {
  it('lets a coin with an empty gallery be opened, so a first photo can be added', () => {
    // The catch-22 this removes: the gallery owns the only per-coin "Add
    // images" picker and the only per-coin drop target, and it used to refuse
    // to open unless the coin already had a photo.
    const { inv, store } = createTwoCoinInventory();
    inv.selectedCoinId.set('empty');

    expect(store.canOpenImageGallery(inv.selectedCoin())).toBe(true);

    store.openImageGallery();
    expect(store.showImageGallery()).toBe(true);
    // ...and it is still showing nothing but this coin's (zero) photos, which
    // is what the template's `@empty` branch renders.
    expect(inv.selectedCoin()!.imagePaths).toEqual([]);
  });

  it('toggles shut again, which is what the detail panel\'s button does', () => {
    const { inv, store } = createTwoCoinInventory();
    inv.selectedCoinId.set('empty');

    store.toggleImageGallery();
    expect(store.showImageGallery()).toBe(true);

    store.toggleImageGallery();
    expect(store.showImageGallery()).toBe(false);
  });

  it('still refuses to open with no coin selected at all', () => {
    const { inv, store } = createTwoCoinInventory();
    inv.selectedCoinId.set(null);

    expect(store.canOpenImageGallery(null)).toBe(false);
    store.openImageGallery();
    expect(store.showImageGallery()).toBe(false);
  });

  it('does not open the full-size viewer for a coin with nothing to view', () => {
    const { inv, store } = createTwoCoinInventory();
    inv.selectedCoinId.set('empty');

    store.openPhotoViewer(0);
    expect(store.showPhotoViewer()).toBe(false);
  });
});

/* ===========================================================================
 * 3. The import writes each coin's photos to that coin only
 * ========================================================================= */

/** A ticked review row aimed at one coin. */
function makeRow(fileName: string, coinId: string): BatchImageRow {
  return {
    fileName,
    thumbnailUrl: '',
    result: { status: 'auto', matchedRecordId: coinId, confidence: 1, reason: '', parsed: {} } as never,
    selectedCoinId: coinId,
    selectionReason: '',
    confidence: 1,
    decision: 'auto',
    selected: true,
    photo: { side: 'obverse', takeNumber: null } as never,
    sizeBytes: 1000
  } as BatchImageRow;
}

const stubEncode = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 500
});

describe('runAttach keeps each coin\'s new photos to that coin', () => {
  it('writes two coins separately, each merged onto its OWN existing photos', async () => {
    const inventory = [
      makeCoin({ id: 'morgan', imagePaths: [MORGAN_OBVERSE] }),
      makeCoin({ id: 'eagle', imagePaths: [EAGLE_OBVERSE] })
    ];
    const files = new Map<string, File>([
      ['morgan-rev.jpg', new File(['x'], 'morgan-rev.jpg', { type: 'image/jpeg' })],
      ['eagle-rev.jpg', new File(['x'], 'eagle-rev.jpg', { type: 'image/jpeg' })]
    ]);
    const attach = vi.fn();

    await runAttach(
      [makeRow('morgan-rev.jpg', 'morgan'), makeRow('eagle-rev.jpg', 'eagle')],
      { files, inventory, attach, encode: stubEncode }
    );

    // One write per coin, never one write carrying both coins' photos.
    expect(attach).toHaveBeenCalledTimes(2);

    const written = new Map<string, string[]>(
      attach.mock.calls.map(call => [call[0] as string, call[1] as string[]])
    );

    expect(written.get('morgan')).toEqual([MORGAN_OBVERSE, 'data:image/jpeg;base64,SHRUNK-morgan-rev.jpg']);
    expect(written.get('eagle')).toEqual([EAGLE_OBVERSE, 'data:image/jpeg;base64,SHRUNK-eagle-rev.jpg']);

    // The property: nothing written for one coin appears in the other's array.
    const overlap = written.get('morgan')!.filter(p => written.get('eagle')!.includes(p));
    expect(overlap).toEqual([]);
  });

  it('gives each coin a fresh array rather than a shared one', async () => {
    // Even with identical starting contents, the two merged arrays must be
    // distinct objects. A shared array is the specific defect that would make
    // every gallery show the same photos.
    const inventory = [
      makeCoin({ id: 'morgan', imagePaths: [] }),
      makeCoin({ id: 'eagle', imagePaths: [] })
    ];
    const files = new Map<string, File>([
      ['a.jpg', new File(['x'], 'a.jpg', { type: 'image/jpeg' })],
      ['b.jpg', new File(['x'], 'b.jpg', { type: 'image/jpeg' })]
    ]);
    const attach = vi.fn();

    await runAttach([makeRow('a.jpg', 'morgan'), makeRow('b.jpg', 'eagle')], {
      files, inventory, attach, encode: stubEncode
    });

    const [first, second] = attach.mock.calls.map(call => call[1] as string[]);
    expect(first).not.toBe(second);
    // And neither is the array that was sitting on the inventory record.
    expect(first).not.toBe(inventory[0].imagePaths);
  });
});

/* ===========================================================================
 * 4. The real explanation: one coin can legitimately collect a whole folder
 * ========================================================================= */

describe('the import can legitimately pile a whole folder onto one coin', () => {
  /**
   * The inventory the owner's 20-cent folder was matched against: ONE
   * twenty-cent record, plus two unrelated coins so the runner-up margin has
   * something to measure against.
   */
  const inventory: CoinRecord[] = [
    makeCoin({
      id: 'twenty-cent', denomination: 'Twenty Cent', coinType: 'Liberty Seated',
      year: '1875', mintMark: 'S', grade: 'XF40'
    }),
    makeCoin({ id: 'morgan', denomination: 'Dollar', coinType: 'Morgan', year: '1921' }),
    makeCoin({
      id: 'double-eagle', denomination: 'Twenty Dollar', coinType: 'Liberty Head', year: '1904'
    })
  ];

  it('auto-attaches every shot of the same coin to it — which is correct', () => {
    // Obverse, reverse, slab label, a derivative and a retake are five files
    // of ONE physical coin. They SHOULD all land on it, and they do. This is
    // the benign half of "all images": a coin with ten photos looks alarming
    // but is exactly right.
    const files = [
      '1875-S 20-cent ANACS XF40 - Obverse.jpg',
      '1875-S 20-cent ANACS XF40 - Reverse.jpg',
      '1875-S 20-cent ANACS XF40 - Label.jpg',
      '1875-S 20-cent ANACS XF40 - Obverse - Small.jpg',
      '1875-S 20-cent ANACS XF40-2.jpg'
    ];

    const results = new ImageMatchingService().matchImages(files, inventory);

    expect(results.map(r => r.matchedRecordId)).toEqual(Array(files.length).fill('twenty-cent'));
  });

  it('ALSO auto-attaches a different physical coin whose filename says nothing to the contrary', () => {
    // THE PROBLEM CASE, and the reason "only show this coin's images" could
    // not be fixed in the gallery: this is a photo of the PHILADELPHIA 1875
    // twenty-cent piece, a different coin from the 1875-S in the inventory.
    // It auto-attaches anyway, because the filename states no mint mark, so
    // the one attribute that would contradict the match is simply not
    // comparable — and with no other twenty-cent record in the inventory
    // there is nothing close enough to trip the runner-up gate either.
    //
    // The gallery is right to show it: it genuinely is attached to that coin.
    // Fixing it means either tightening the matcher (which would send a lot
    // of correct matches to manual review) or adding the missing records to
    // the inventory. Flagged here rather than silently changed, because the
    // thresholds in matching-thresholds.ts are tuned against a census of the
    // owner's real filenames and must not be nudged on a hunch.
    const [result] = new ImageMatchingService().matchImages(
      ['1875 20-cent - Obverse.jpg'],
      inventory
    );

    expect(result.status).toBe('auto');
    expect(result.matchedRecordId).toBe('twenty-cent');
  });

  it('does hold the line when a competing attribute actually contradicts', () => {
    /* The gates are not useless: a stated mint mark that disagrees, or a year
     * that disagrees, both keep the file out of auto-match. So the
     * over-attachment above is specifically a MISSING-information problem,
     * not a broken one.
     *
     * THE TWO CASES NOW LAND IN DIFFERENT PLACES, and the difference is the
     * point of the hard vetoes added in match-vetoes.ts:
     *
     *   1875-CC  -> 'review'. Only the MINT MARK disagrees, and a mint mark
     *               is not one of the three vetoes. The coin stays on the
     *               shortlist and the user decides.
     *   1876     -> 'none'.   The YEAR disagrees, and the owner's rule is
     *               that a year conflict is not a close match at all: "First
     *               it's not a close match if the years don't match." The
     *               1875 record is disqualified outright, so there is nothing
     *               left to offer and nothing to click.
     *
     * Both still attach nothing, which is what this test was really guarding. */
    const results = new ImageMatchingService().matchImages(
      ['1875-CC 20-cent Choice F - Obverse.jpg', '1876 20-cent PCGS MS63 - Obverse.jpg'],
      inventory
    );

    expect(results.map(r => r.status)).toEqual(['review', 'none']);
    expect(results.map(r => r.matchedRecordId)).toEqual([null, null]);

    // The year-vetoed file names the coin it was disqualified against, so the
    // "Not imported" list can explain itself instead of shrugging.
    expect(results[1].candidates).toEqual([]);
    expect(results[1].reason).toContain('disqualified');
    expect(results[1].reason).toContain('1876');
  });
});
