/*
 * CoinImagesStore against a coin whose photos haven't loaded (the normal
 * state after the list fetch: `imagePaths` absent, `imageCount` present).
 * Reads fall back to the count; writes load first or do nothing.
 *
 * Fake timers: CoinEditor debounces its PUT by one second.
 */
import 'fake-indexeddb/auto';
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { CoinImagesStore } from './coin-images.store';
import { imageSourcePaths } from '../../services/image-source-paths';
import { CoinRecord } from '../../types/coin.model';
import { CoinImageRecord } from '../../types/coin-image.model';
import { createTestInventoryService } from '../../testing/test-helpers';

const OLD_A = 'data:image/jpeg;base64,OLD-A';
const OLD_B = 'data:image/jpeg;base64,OLD-B';

/** A coin as the list hands it over: an imageCount and no imagePaths key. */
function listLoadedCoin(imageCount: number): CoinRecord {
  const coin = {
    id: 'coin-1', denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 100, currentValue: 150, notes: '',
    source: 'manual', imageCount
  } as unknown as CoinRecord;
  delete (coin as { imagePaths?: unknown }).imagePaths;
  return coin;
}

function createStore(options: { imageCount?: number; images?: unknown } = {}) {
  const harness = createTestInventoryService();
  const getCoinImages = vi.fn(() => (options.images ?? of([
    { imageId: 1, imageData: OLD_A, sourcePath: null, sortOrder: 0 },
    { imageId: 2, imageData: OLD_B, sourcePath: null, sortOrder: 1 }
  ] as CoinImageRecord[])) as never);
  (harness.mockApiService as unknown as Record<string, unknown>)['getCoinImages'] = getCoinImages;

  harness.inv.inventory.set([listLoadedCoin(options.imageCount ?? 2)]);
  harness.inv.selectedCoinId.set('coin-1');

  return { ...harness, getCoinImages, store: new CoinImagesStore(harness.inv) };
}

/** A fake file-picker change event carrying one image. */
function pickEvent(): Event {
  const file = new File([new Uint8Array([1, 2, 3])], 'new.jpg', { type: 'image/jpeg' });
  return { target: { files: [file], value: 'x' } } as unknown as Event;
}

const putsSent = (api: unknown) =>
  (api as { updateCoin: ReturnType<typeof vi.fn> }).updateCoin.mock.calls;

describe('reads tolerate photographs that have not arrived yet', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the full-screen viewer on the strength of imageCount alone', () => {
    const { store } = createStore({ imageCount: 3 });

    store.openPhotoViewer(0);

    expect(store.showPhotoViewer()).toBe(true);
  });

  it('refuses to open it for a coin the list says has none', () => {
    const { store } = createStore({ imageCount: 0 });

    store.openPhotoViewer(0);

    expect(store.showPhotoViewer()).toBe(false);
  });

  it('steps through the photographs using the count, without throwing', () => {
    const { store } = createStore({ imageCount: 3 });

    store.openPhotoViewer(0);
    store.movePhotoViewer(-1);

    // Wrapped round to the last of three, from `imageCount`.
    expect(store.photoViewerIndex()).toBe(2);
  });

  it('reports no main image rather than throwing', () => {
    const { store } = createStore();

    expect(store.isMainImage(OLD_A)).toBe(false);
  });
});

describe('writes refuse to act on photographs they do not have', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    imageSourcePaths.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    imageSourcePaths.clear();
  });

  it('setMainImage does nothing at all', () => {
    const { store, mockApiService } = createStore();

    store.setMainImage(OLD_B);
    vi.advanceTimersByTime(2000);

    expect(putsSent(mockApiService)).toHaveLength(0);
  });

  it('removeCoinImage does nothing at all', () => {
    const { store, mockApiService } = createStore();

    store.removeCoinImage(OLD_A);
    vi.advanceTimersByTime(2000);

    expect(putsSent(mockApiService)).toHaveLength(0);
  });

  it('adding a photo LOADS the existing ones first and keeps them', async () => {
    const { store, mockApiService, getCoinImages } = createStore();

    await store.addCoinImages(pickEvent());
    await vi.advanceTimersByTimeAsync(2000);

    expect(getCoinImages).toHaveBeenCalledWith('coin-1');

    const calls = putsSent(mockApiService);
    expect(calls).toHaveLength(1);
    const sent = (calls[0]![1] as { imagePaths: string[] }).imagePaths;
    expect(sent[0]).toBe(OLD_A);
    expect(sent[1]).toBe(OLD_B);
    expect(sent).toHaveLength(3);
  });

  it('adding a photo writes NOTHING when the existing ones cannot be loaded', async () => {
    const { store, mockApiService } = createStore({
      images: throwError(() => new Error('offline'))
    });

    await store.addCoinImages(pickEvent());
    await vi.advanceTimersByTimeAsync(2000);

    expect(putsSent(mockApiService)).toHaveLength(0);
  });

  it('adding a photo to a coin with none needs no fetch', async () => {
    const { store, mockApiService, getCoinImages } = createStore({ imageCount: 0 });

    await store.addCoinImages(pickEvent());
    await vi.advanceTimersByTimeAsync(2000);

    expect(getCoinImages).not.toHaveBeenCalled();
    const sent = (putsSent(mockApiService)[0]![1] as { imagePaths: string[] }).imagePaths;
    expect(sent).toHaveLength(1);
  });
});
