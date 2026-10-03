/**
 * Tests for "let the user choose which photo appears in the main grid".
 *
 * WHAT IS BEING PROVED, AND WHY IT IS WORTH A SPEC
 * ------------------------------------------------
 * The feature itself is one line of array shuffling. The risk is entirely in
 * what gets SENT, because `PUT /api/coins/:id` REPLACES a coin's whole image
 * set — it deletes every CoinImages row and re-inserts the array it is given.
 * Two things therefore have to hold, and this file asserts both:
 *
 *   1. Each image's `sourcePath` (where the ORIGINAL full-resolution file
 *      lives on disk) must still be attached to every entry in the outgoing
 *      array. An entry sent as a bare string is re-inserted with
 *      `SourcePath NULL`, so a careless re-order would wipe the recorded
 *      location of EVERY photo on the coin. That is the data-loss bug this
 *      project has hit before.
 *
 *   2. The request must carry ONLY the `imagePaths` key. Sending a whole coin
 *      record is the other historic way data got clobbered.
 *
 * There is no jsdom here, so nothing below renders the gallery. The button in
 * `coin-image-gallery.html` is a one-line call to `setMainImage()` /
 * `isMainImage()`, so testing the store tests the behaviour; only the markup
 * itself is unverified by this file.
 *
 * Fake timers are used because CoinEditor debounces its PUT by one second.
 */
import 'fake-indexeddb/auto';
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinImagesStore } from './coin-images.store';
import { imageSourcePaths } from '../../services/image-source-paths';
import { AttachedImage } from '../../types/coin-image.model';
import { CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

/** Three distinct images, standing in for obverse / reverse / slab label. */
const OBVERSE = 'data:image/jpeg;base64,OBVERSE';
const REVERSE = 'data:image/jpeg;base64,REVERSE';
const LABEL = 'data:image/jpeg;base64,LABEL';

function coinWithImages(imagePaths: string[]): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: 'PCGS',
    certNumber: '12345678', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 100, currentValue: 150, notes: '',
    imagePaths, source: 'manual'
  };
}

/**
 * Build a store over a real InventoryService (with a mocked ApiService) and
 * select the coin, which is what the gallery relies on.
 *
 * Setting `inv.inventory` directly means the coin is NOT in the draft registry,
 * i.e. it behaves as an ordinary server-backed record — which is the case we
 * care about, since that is the one that produces a PUT.
 */
function createStore(imagePaths: string[]) {
  const harness = createTestInventoryService();
  harness.inv.inventory.set([coinWithImages(imagePaths)]);
  harness.inv.selectedCoinId.set('coin-1');
  return { ...harness, store: new CoinImagesStore(harness.inv) };
}

/** The coin as it currently appears on screen. */
const liveImages = (inv: { inventory: () => CoinRecord[] }) =>
  inv.inventory()[0]!.imagePaths;

/** The `imagePaths` value of the single PUT that was sent. */
function sentImagePaths(mockApiService: { updateCoin: ReturnType<typeof vi.fn> }) {
  expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
  const [, payload] = mockApiService.updateCoin.mock.calls[0]!;
  return (payload as { imagePaths: unknown }).imagePaths;
}

describe('CoinImagesStore — choosing the main grid photo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    imageSourcePaths.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    imageSourcePaths.clear();
  });

  it('reports the FIRST image as the main one, matching what the grid renders', () => {
    // InventoryTable.primaryImage() returns coin.imagePaths[0], so "main
    // photo" and "position 0" have to be the same statement.
    const { store } = createStore([OBVERSE, REVERSE, LABEL]);

    expect(store.isMainImage(OBVERSE)).toBe(true);
    expect(store.isMainImage(REVERSE)).toBe(false);
    expect(store.isMainImage(LABEL)).toBe(false);
  });

  it('moves the chosen photo to position 0 and keeps the others in order', () => {
    const { store, inv } = createStore([OBVERSE, REVERSE, LABEL]);

    store.setMainImage(LABEL);

    // Position 0 IS SortOrder 0 once the server re-inserts the rows, so this
    // single array move is the whole feature.
    expect(liveImages(inv)).toEqual([LABEL, OBVERSE, REVERSE]);
    expect(store.isMainImage(LABEL)).toBe(true);
  });

  it('does nothing at all when the photo is already the main one', () => {
    // Important rather than merely tidy: a no-op PUT would still delete and
    // re-insert every image row on the server.
    const { store, mockApiService } = createStore([OBVERSE, REVERSE]);

    store.setMainImage(OBVERSE);
    vi.advanceTimersByTime(2000);

    expect(mockApiService.updateCoin).not.toHaveBeenCalled();
  });

  it('ignores an image that is not attached to this coin', () => {
    const { store, inv, mockApiService } = createStore([OBVERSE, REVERSE]);

    store.setMainImage('data:image/jpeg;base64,NOT-ATTACHED');
    vi.advanceTimersByTime(2000);

    expect(liveImages(inv)).toEqual([OBVERSE, REVERSE]);
    expect(mockApiService.updateCoin).not.toHaveBeenCalled();
  });

  it('sends ONLY the imagePaths field, so the write stays atomic', () => {
    // The partial-update rule: the PUT body is built from the dirty-field set,
    // never from the full record. Re-ordering photos must not re-send (and so
    // must not risk clobbering) grade, price, notes or anything else.
    const { store, mockApiService } = createStore([OBVERSE, REVERSE]);

    store.setMainImage(REVERSE);
    vi.advanceTimersByTime(2000);

    expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
    const [coinId, payload] = (mockApiService.updateCoin as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(coinId).toBe('coin-1');
    expect(Object.keys(payload as object)).toEqual(['imagePaths']);
  });
});

describe('CoinImagesStore — source paths survive a re-order', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    imageSourcePaths.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    imageSourcePaths.clear();
  });

  it('carries every known sourcePath through to the server', () => {
    // THE DATA-LOSS REGRESSION TEST.
    //
    // All three photos have a recorded original-file location. After promoting
    // the reverse shot to main, all three must STILL arrive as
    // { imageData, sourcePath } objects with their paths intact. If the
    // re-order were to send bare strings, the server would re-insert all three
    // rows with SourcePath NULL and the paths would be gone for good.
    imageSourcePaths.record(OBVERSE, 'D:\\Coin Pictures\\1921 Morgan - Obverse.jpg');
    imageSourcePaths.record(REVERSE, 'D:\\Coin Pictures\\1921 Morgan - Reverse.jpg');
    imageSourcePaths.record(LABEL, 'D:\\Coin Pictures\\1921 Morgan - Label.jpg');

    const { store, mockApiService } = createStore([OBVERSE, REVERSE, LABEL]);

    store.setMainImage(REVERSE);
    vi.advanceTimersByTime(2000);

    expect(sentImagePaths(mockApiService as never)).toEqual<AttachedImage[]>([
      { imageData: REVERSE, sourcePath: 'D:\\Coin Pictures\\1921 Morgan - Reverse.jpg' },
      { imageData: OBVERSE, sourcePath: 'D:\\Coin Pictures\\1921 Morgan - Obverse.jpg' },
      { imageData: LABEL, sourcePath: 'D:\\Coin Pictures\\1921 Morgan - Label.jpg' }
    ]);
  });

  it('does not invent a path for photos that never had one', () => {
    // A mixed coin: one imported photo with a known original, one added
    // straight from the gallery's file picker. The unknown one must come
    // through as an explicit null, not as a path borrowed from its neighbour —
    // mis-pairing paths with photos would be worse than losing them.
    imageSourcePaths.record(LABEL, 'D:\\Coin Pictures\\1921 Morgan - Label.jpg');

    const { store, mockApiService } = createStore([OBVERSE, LABEL]);

    store.setMainImage(LABEL);
    vi.advanceTimersByTime(2000);

    expect(sentImagePaths(mockApiService as never)).toEqual<AttachedImage[]>([
      { imageData: LABEL, sourcePath: 'D:\\Coin Pictures\\1921 Morgan - Label.jpg' },
      { imageData: OBVERSE, sourcePath: null }
    ]);
  });

  it('leaves the payload as plain strings when no path is known for any photo', () => {
    // The compatibility path. When the registry knows nothing, the request body
    // is untouched and looks exactly like it always has — the object form shows
    // up only when it actually carries information.
    const { store, mockApiService } = createStore([OBVERSE, REVERSE]);

    store.setMainImage(REVERSE);
    vi.advanceTimersByTime(2000);

    expect(sentImagePaths(mockApiService as never)).toEqual([REVERSE, OBVERSE]);
  });

  it('keeps the on-screen array as plain strings, so <img [src]> still works', () => {
    // The enrichment happens on the way OUT only. If it leaked back into the
    // signal, every <img> in the gallery, the viewer and the grid would be
    // bound to an object and render nothing.
    imageSourcePaths.record(REVERSE, 'D:\\Coin Pictures\\1921 Morgan - Reverse.jpg');

    const { store, inv } = createStore([OBVERSE, REVERSE]);

    store.setMainImage(REVERSE);
    vi.advanceTimersByTime(2000);

    expect(liveImages(inv)).toEqual([REVERSE, OBVERSE]);
  });
});
