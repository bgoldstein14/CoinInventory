/**
 * Choosing the main grid photo. `PUT /api/coins/:id` replaces the whole image
 * set, so the request must carry only `imagePaths` and keep each image's
 * `sourcePath`.
 *
 * Fake timers because CoinEditor debounces its PUT by one second.
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
 * Store over a real InventoryService (mocked ApiService) with the coin selected.
 * Setting `inv.inventory` directly keeps the coin out of the draft registry,
 * so it behaves as a server-backed record and produces a PUT.
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
    // InventoryTable.primaryImage() returns coin.imagePaths[0].
    const { store } = createStore([OBVERSE, REVERSE, LABEL]);

    expect(store.isMainImage(OBVERSE)).toBe(true);
    expect(store.isMainImage(REVERSE)).toBe(false);
    expect(store.isMainImage(LABEL)).toBe(false);
  });

  it('moves the chosen photo to position 0 and keeps the others in order', () => {
    const { store, inv } = createStore([OBVERSE, REVERSE, LABEL]);

    store.setMainImage(LABEL);

    expect(liveImages(inv)).toEqual([LABEL, OBVERSE, REVERSE]);
    expect(store.isMainImage(LABEL)).toBe(true);
  });

  it('does nothing at all when the photo is already the main one', () => {
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
    // Bare strings would be re-inserted with SourcePath NULL.
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
    // Only LABEL has a known path; OBVERSE must get null, not a neighbour's path.
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
    const { store, mockApiService } = createStore([OBVERSE, REVERSE]);

    store.setMainImage(REVERSE);
    vi.advanceTimersByTime(2000);

    expect(sentImagePaths(mockApiService as never)).toEqual([REVERSE, OBVERSE]);
  });

  it('keeps the on-screen array as plain strings, so <img [src]> still works', () => {
    // Source paths are added to the outgoing request only, not the signal.
    imageSourcePaths.record(REVERSE, 'D:\\Coin Pictures\\1921 Morgan - Reverse.jpg');

    const { store, inv } = createStore([OBVERSE, REVERSE]);

    store.setMainImage(REVERSE);
    vi.advanceTimersByTime(2000);

    expect(liveImages(inv)).toEqual([REVERSE, OBVERSE]);
  });
});
