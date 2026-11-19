/*
 * A coin's gallery shows that coin's photos and no others, including after
 * edits and batch imports (services/image-import/attach-runner.ts).
 *
 * The last group documents matcher behaviour that can look like a leak: the
 * auto-match gates are per file, so many files, even of a different physical
 * coin, can legitimately land on one record.
 */

import 'fake-indexeddb/auto';
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinImagesStore } from './coin-images.store';
import { runAttach } from '../../services/image-import/attach-runner';
import { ImageMatchingService } from '../../services/image-matching.service';
import { imageSourcePaths } from '../../services/image-source-paths';
import { BatchImageRow, CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

/* --- Fixtures --- */

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

/** Two coins with photos of their own, plus a third with none at all. */
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
    expect(morgan.filter(p => eagle.includes(p))).toEqual([]);
  });

  it('switches the whole set when the selected coin changes', () => {
    // Mirrors the row's Images button: select, then open.
    const { inv, store } = createTwoCoinInventory();

    inv.selectedCoinId.set('morgan');
    store.openImageGallery();
    expect(inv.selectedCoin()!.imagePaths).toEqual([MORGAN_OBVERSE, MORGAN_REVERSE]);

    inv.selectedCoinId.set('eagle');
    expect(inv.selectedCoin()!.imagePaths).toEqual([EAGLE_OBVERSE]);
  });

  it('does not alias one array across records — a change to one is invisible to the other', () => {
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
    const { inv, store } = createTwoCoinInventory();
    inv.selectedCoinId.set('morgan');

    store.setMainImage(MORGAN_REVERSE);
    vi.advanceTimersByTime(2000);

    expect(galleryImagesFor(inv, 'morgan')).toEqual([MORGAN_REVERSE, MORGAN_OBVERSE]);
    expect(galleryImagesFor(inv, 'eagle')).toEqual([EAGLE_OBVERSE]);
  });
});

describe('the gallery opens for a coin with no photos', () => {
  it('lets a coin with an empty gallery be opened, so a first photo can be added', () => {
    const { inv, store } = createTwoCoinInventory();
    inv.selectedCoinId.set('empty');

    expect(store.canOpenImageGallery(inv.selectedCoin())).toBe(true);

    store.openImageGallery();
    expect(store.showImageGallery()).toBe(true);
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

    // 'add' because the default ('leave') writes nothing to a coin that
    // already has photos. See services/image-import/existing-photo-mode.ts.
    await runAttach(
      [makeRow('morgan-rev.jpg', 'morgan'), makeRow('eagle-rev.jpg', 'eagle')],
      { files, inventory, attach, encode: stubEncode, existingPhotoMode: 'add' }
    );

    // One write per coin, never one write carrying both coins' photos.
    expect(attach).toHaveBeenCalledTimes(2);

    const written = new Map<string, string[]>(
      attach.mock.calls.map(call => [call[0] as string, call[1] as string[]])
    );

    expect(written.get('morgan')).toEqual([MORGAN_OBVERSE, 'data:image/jpeg;base64,SHRUNK-morgan-rev.jpg']);
    expect(written.get('eagle')).toEqual([EAGLE_OBVERSE, 'data:image/jpeg;base64,SHRUNK-eagle-rev.jpg']);

    const overlap = written.get('morgan')!.filter(p => written.get('eagle')!.includes(p));
    expect(overlap).toEqual([]);
  });

  it('gives each coin a fresh array rather than a shared one', async () => {
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
    expect(first).not.toBe(inventory[0].imagePaths);
  });
});

describe('the import can legitimately pile a whole folder onto one coin', () => {
  /** One twenty-cent record, plus two unrelated coins for the runner-up margin. */
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
    // Five files of one physical coin.
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
    // A Philadelphia 1875 photo matches the 1875-S record: the filename has no
    // mint mark to contradict it, and no other twenty-cent record competes.
    // Thresholds (matching-thresholds.ts) are tuned on real filenames; change
    // them deliberately, not to make this pass.
    const [result] = new ImageMatchingService().matchImages(
      ['1875 20-cent - Obverse.jpg'],
      inventory
    );

    expect(result.status).toBe('auto');
    expect(result.matchedRecordId).toBe('twenty-cent');
  });

  it('does hold the line when a competing attribute actually contradicts', () => {
    // 1875-CC -> 'review': a mint-mark conflict isn't a hard veto.
    // 1876    -> 'none':   a year conflict disqualifies the record (match-vetoes.ts).
    const results = new ImageMatchingService().matchImages(
      ['1875-CC 20-cent Choice F - Obverse.jpg', '1876 20-cent PCGS MS63 - Obverse.jpg'],
      inventory
    );

    expect(results.map(r => r.status)).toEqual(['review', 'none']);
    expect(results.map(r => r.matchedRecordId)).toEqual([null, null]);

    // The reason names the disqualifying year for the "Not imported" list.
    expect(results[1].candidates).toEqual([]);
    expect(results[1].reason).toContain('disqualified');
    expect(results[1].reason).toContain('1876');
  });
});
