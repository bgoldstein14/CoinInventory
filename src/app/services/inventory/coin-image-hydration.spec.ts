 /*
 * coin-image-hydration.spec.ts
 *
 * "The list gave us no photographs. Get this ONE coin's, on demand."
 *
 * `GET /api/coins` now returns `imageCount` and no `imagePaths`. The detail
 * panel, the gallery and the full-screen viewer all still bind to
 * `coin.imagePaths`, and all three only ever show the SELECTED coin — so the
 * migration is: when a coin is selected, fetch its photographs once and write
 * them onto the in-memory record.
 *
 * ---- WHY HYDRATE THE RECORD INSTEAD OF KEEPING A SEPARATE CACHE ----
 * Because the record is also what the WRITE path reads. "Set as main photo",
 * "delete this photo" and "add photos" all build a new array out of
 * `coin.imagePaths` and PUT it. A parallel cache would mean two copies of the
 * same list that can disagree, and the moment they disagree a save writes the
 * wrong set of photographs to the database.
 *
 * ---- THE RULE THAT MAKES THIS SAFE: HYDRATION IS NOT AN EDIT ----
 * Writing the server's own answer back onto the record must never look like
 * something the user typed. If it did, the debounced PUT would fire and send
 * `imagePaths` straight back — a pointless DELETE-and-reinsert of every image
 * row on a coin the user only LOOKED at, and a new chance to lose them.
 * Several tests below exist purely to pin "and no request was sent".
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

/** A coin as `GET /api/coins` hands it over: imageCount, no imagePaths key. */
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
    // In SortOrder, because that order IS the display order and position 0 is
    // the coin's main photo.
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
     * The 105-coin arithmetic again, from the other end. Selecting coins one
     * after another must not fire a request for every coin that obviously
     * has nothing to fetch — `imageCount: 0` is already the answer.
      */
    const { inv, getCoinImages } = createHarness({ imageCount: 0 });

    const images = await inv.loadCoinImages('coin-1');

    expect(images).toEqual([]);
    expect(getCoinImages).not.toHaveBeenCalled();
    // And the record is hydrated with a genuine empty array, so the gallery
    // can show its "add the first photo" empty state.
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

    // The grid's "Unsaved" chip must not appear just because somebody opened
    // a coin and looked at its pictures.
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

    // This is what makes the "open the original photo" link work, and what
    // lets an outgoing PUT carry the path back so the server does not have
    // to look it up. See services/image-source-paths.ts.
    expect(imageSourcePaths.pathFor(OBVERSE)).toBe('D:\\pics\\obv.jpg');
    expect(imageSourcePaths.pathFor(REVERSE)).toBeNull();
  });

  it('does not clobber photographs the user has already changed on screen', async () => {
    const { inv, getCoinImages } = createHarness();

    // The user attached a photo a moment ago; the record now holds the real
    // array. Re-reading the server would throw that unsaved work away.
    inv.inventory.set([{ ...listLoadedCoin(), imagePaths: ['data:image/jpeg;base64,JUST-ADDED'] }]);

    const images = await inv.loadCoinImages('coin-1');

    expect(images).toEqual(['data:image/jpeg;base64,JUST-ADDED']);
    expect(getCoinImages).not.toHaveBeenCalled();
  });

  it('rejects on a failed fetch instead of claiming the coin has none', async () => {
     /*
     * A network failure must NOT become `imagePaths: []`. That value means
     * "this coin has no photographs", and the batch import's append path
     * would then PUT it — deleting every picture on the coin because the
     * server was briefly unreachable.
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

    // No try/catch at the call site, and no unhandled rejection.
    expect(() => inv.ensureCoinImages('coin-1')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('loads again after the whole inventory is replaced', async () => {
     /*
     * A reconnect, a JSON import or "Retry connection" replaces every
     * record, and the fresh ones have no `imagePaths` key again. There is
     * deliberately no "already fetched" set to invalidate here — the record
     * IS the cache — so this works with nobody having to remember to clear
     * anything. This test is what pins that.
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
    // The other 104 coins in the collection are not touched. That is the
    // entire difference between this and the response that could not be
    // serialised.
    expect(getCoinImages).not.toHaveBeenCalledWith('coin-2');
  });
});
