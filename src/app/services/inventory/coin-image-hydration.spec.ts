 /*
  * `GET /api/coins` returns `imageCount` but no `imagePaths`; when a coin is
  * selected its photos are fetched once and written onto the in-memory record
  * (which the write paths also read, so no separate cache).
  *
  * Hydration must never look like an edit: otherwise the debounced PUT would
  * send the images back, deleting and re-inserting every row. Several tests check
  * that no request was sent.
  */
import 'fake-indexeddb/auto';
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { CoinRecord } from '../../types/coin.model';
import { CoinImageRecord } from '../../types/coin-image.model';
import { imageSourcePaths } from '../image-source-paths';
import { createTestInventoryService } from '../../testing/test-helpers';

const OBVERSE = 'data:image/jpeg;base64,OBVERSE';
const REVERSE = 'data:image/jpeg;base64,REVERSE';

function serverImages(): CoinImageRecord[] {
  return [
    { imageId: 1, imageData: OBVERSE, sourcePath: 'D:\\pics\\obv.jpg', sortOrder: 0 },
    { imageId: 2, imageData: REVERSE, sourcePath: null, sortOrder: 1 }
  ];
}

/** A coin as `GET /api/coins` returns it: imageCount, no imagePaths key. */
function listLoadedCoin(imageCount = 2, id = 'coin-1'): CoinRecord {
  const coin = {
    id, denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 100, currentValue: 150, notes: '',
    source: 'manual', imageCount
  } as unknown as CoinRecord;
  delete (coin as { imagePaths?: unknown }).imagePaths;
  return coin;
}

function createHarness(options: { images?: unknown; imageCount?: number } = {}) {
  const harness = createTestInventoryService();
  const getCoinImages = vi.fn(() => (options.images ?? of(serverImages())) as never);
  (harness.mockApiService as unknown as Record<string, unknown>)['getCoinImages'] = getCoinImages;
  harness.inv.inventory.set([listLoadedCoin(options.imageCount ?? 2)]);
  return { ...harness, getCoinImages };
}

const liveCoin = (inv: { inventory: () => CoinRecord[] }) => inv.inventory()[0]!;

describe('InventoryService.loadCoinImages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    imageSourcePaths.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    imageSourcePaths.clear();
  });

  it('fetches the coin\'s photographs and writes them onto the record', async () => {
    const { inv, getCoinImages } = createHarness();

    expect('imagePaths' in liveCoin(inv)).toBe(false);

    const images = await inv.loadCoinImages('coin-1');

    expect(getCoinImages).toHaveBeenCalledWith('coin-1');
    expect(images).toEqual([OBVERSE, REVERSE]);
    // SortOrder is display order; position 0 is the main photo.
    expect(liveCoin(inv).imagePaths).toEqual([OBVERSE, REVERSE]);
  });

  it('asks the server once per coin, however many screens want the photos', async () => {
    const { inv, getCoinImages } = createHarness();

    await inv.loadCoinImages('coin-1');
    await inv.loadCoinImages('coin-1');
    inv.ensureCoinImages('coin-1');
    inv.ensureCoinImages('coin-1');

    expect(getCoinImages).toHaveBeenCalledTimes(1);
  });

  it('makes NO request for a coin the list said has no photographs', async () => {
     /*
      * Coins with `imageCount: 0` must not trigger a fetch when selected.
      */
    const { inv, getCoinImages } = createHarness({ imageCount: 0 });

    const images = await inv.loadCoinImages('coin-1');

    expect(images).toEqual([]);
    expect(getCoinImages).not.toHaveBeenCalled();
    // Hydrated with a genuine empty array, so the gallery shows its empty state.
    expect(liveCoin(inv).imagePaths).toEqual([]);
  });

  it('does NOT send a PUT — hydration is the server talking, not the user', async () => {
    const { inv, mockApiService } = createHarness();

    await inv.loadCoinImages('coin-1');
    vi.advanceTimersByTime(5000);

    expect((mockApiService as unknown as { updateCoin: ReturnType<typeof vi.fn> }).updateCoin)
      .not.toHaveBeenCalled();
  });

  it('does not make the coin look like an unsaved draft', async () => {
    const { inv } = createHarness();

    await inv.loadCoinImages('coin-1');

    // Viewing a coin's pictures must not make it look unsaved.
    expect(inv.isDraftCoin('coin-1')).toBe(false);
  });

  it('leaves a later, unrelated edit free of imagePaths', async () => {
    const { inv, mockApiService } = createHarness();

    await inv.loadCoinImages('coin-1');
    inv.updateCoin('coin-1', { notes: 'typed after the photos arrived' });
    vi.advanceTimersByTime(1500);

    const updateCoin = (mockApiService as unknown as { updateCoin: ReturnType<typeof vi.fn> }).updateCoin;
    expect(updateCoin).toHaveBeenCalledTimes(1);
    const payload = updateCoin.mock.calls[0]![1] as Record<string, unknown>;
    expect('imagePaths' in payload).toBe(false);
  });

  it('records each photograph\'s original file location on the way through', async () => {
    const { inv } = createHarness();

    await inv.loadCoinImages('coin-1');

    // Needed for "open the original photo" links and outgoing PUTs (see image-source-paths.ts).
    expect(imageSourcePaths.pathFor(OBVERSE)).toBe('D:\\pics\\obv.jpg');
    expect(imageSourcePaths.pathFor(REVERSE)).toBeNull();
  });

  it('does not clobber photographs the user has already changed on screen', async () => {
    const { inv, getCoinImages } = createHarness();

    // A photo was just attached; re-reading the server would discard it.
    inv.inventory.set([{ ...listLoadedCoin(), imagePaths: ['data:image/jpeg;base64,JUST-ADDED'] }]);

    const images = await inv.loadCoinImages('coin-1');

    expect(images).toEqual(['data:image/jpeg;base64,JUST-ADDED']);
    expect(getCoinImages).not.toHaveBeenCalled();
  });

  it('rejects on a failed fetch instead of claiming the coin has none', async () => {
     /*
      * A network failure must not become `imagePaths: []`, which the batch import's
      * append path would PUT, deleting every photo.
      */
    const { inv } = createHarness({ images: throwError(() => new Error('offline')) });

    await expect(inv.loadCoinImages('coin-1')).rejects.toThrow();
    expect('imagePaths' in liveCoin(inv)).toBe(false);
  });

  it('retries after a failure rather than caching the error forever', async () => {
    const { inv, getCoinImages } = createHarness({ images: throwError(() => new Error('offline')) });

    await expect(inv.loadCoinImages('coin-1')).rejects.toThrow();

    getCoinImages.mockReturnValue(of(serverImages()) as never);
    expect(await inv.loadCoinImages('coin-1')).toEqual([OBVERSE, REVERSE]);
    expect(getCoinImages).toHaveBeenCalledTimes(2);
  });

  it('ensureCoinImages swallows the failure so a template can call it', async () => {
    const { inv } = createHarness({ images: throwError(() => new Error('offline')) });

    // No try/catch at the call site and no unhandled rejection.
    expect(() => inv.ensureCoinImages('coin-1')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('loads again after the whole inventory is replaced', async () => {
     /*
      * A reconnect, JSON import or retry replaces every record, and the new ones
      * have no `imagePaths` again. The record is the cache, so there is nothing to
      * invalidate.
      */
    const { inv, getCoinImages } = createHarness();

    await inv.loadCoinImages('coin-1');
    expect(getCoinImages).toHaveBeenCalledTimes(1);

    inv.inventory.set([listLoadedCoin()]);

    await inv.loadCoinImages('coin-1');
    expect(getCoinImages).toHaveBeenCalledTimes(2);
  });
});

describe('selecting a coin', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts loading that coin\'s photographs, and only that coin\'s', async () => {
    const harness = createTestInventoryService();
    const getCoinImages = vi.fn(() => of(serverImages()) as never);
    (harness.mockApiService as unknown as Record<string, unknown>)['getCoinImages'] = getCoinImages;
    harness.inv.inventory.set([listLoadedCoin(2, 'coin-1'), listLoadedCoin(2, 'coin-2')]);

    harness.inv.selectCoin('coin-1');

    expect(getCoinImages).toHaveBeenCalledTimes(1);
    expect(getCoinImages).toHaveBeenCalledWith('coin-1');
    // Other coins are not fetched.
    expect(getCoinImages).not.toHaveBeenCalledWith('coin-2');
  });
});
