 /*
 * coin-photos.spec.ts — the two questions every screen asks about a coin's
 * photographs, now that the list endpoint no longer carries them.
 *
 *   "How many photographs does this coin have?"  -> coinPhotoCount
 *   "Give me the photographs themselves"         -> makeCoinImageLoader
 *
 * Both have to work across the ONE distinction that matters:
 *
 *   imagePaths is an ARRAY   -> loaded. Its length is the truth, and the
 *                               strings are the photographs.
 *   imagePaths is ABSENT     -> NOT loaded. `imageCount` answers the first
 *                               question for free; the second needs a fetch.
 *
 * Note what is NOT in that list: there is no "empty array means unknown"
 * case. An empty array means the coin genuinely has no photographs, and
 * conflating the two is how a save deletes somebody's pictures — see
 * services/inventory/photo-safety.spec.ts.
  */
import { describe, expect, it, vi } from 'vitest';
import { coinHasPhotos, coinPhotoCount, makeCoinImageLoader } from './coin-photos';
import { CoinRecord } from '../types/coin.model';

/** A coin whose photographs HAVE been loaded. */
function loaded(imagePaths: string[], imageCount?: number): CoinRecord {
  return { id: 'c1', imagePaths, ...(imageCount === undefined ? {} : { imageCount }) } as CoinRecord;
}

/** A coin straight off `GET /api/coins`: an imageCount and no imagePaths key. */
function notLoaded(imageCount: number, id = 'c1'): CoinRecord {
  return { id, imageCount } as unknown as CoinRecord;
}

describe('coinPhotoCount', () => {
  it('counts a loaded array', () => {
    expect(coinPhotoCount(loaded(['a', 'b', 'c']))).toBe(3);
  });

  it('reports 0 for a loaded but empty array — that coin really has none', () => {
    expect(coinPhotoCount(loaded([]))).toBe(0);
  });

  it('falls back to the server imageCount when imagePaths was never loaded', () => {
    expect(coinPhotoCount(notLoaded(7))).toBe(7);
  });

  it('prefers the loaded array over a stale imageCount', () => {
    // The user just deleted two photographs. The array is what is true now;
    // `imageCount` is what the server said when the page loaded.
    expect(coinPhotoCount(loaded(['a'], 3))).toBe(1);
  });

  it('reports 0 when neither is available, rather than throwing', () => {
    expect(coinPhotoCount({ id: 'c1' } as unknown as CoinRecord)).toBe(0);
  });
});

describe('coinHasPhotos', () => {
  it('is true for a coin the server says has photographs, with none loaded', () => {
    // This is the grid's case: it must answer without fetching anything.
    expect(coinHasPhotos(notLoaded(2))).toBe(true);
  });

  it('is false for a coin with an imageCount of 0', () => {
    expect(coinHasPhotos(notLoaded(0))).toBe(false);
  });

  it('is false for a loaded, empty array', () => {
    expect(coinHasPhotos(loaded([]))).toBe(false);
  });
});

describe('makeCoinImageLoader', () => {
  it('uses the in-memory array and never calls the server', async () => {
    const fetchFromServer = vi.fn(async () => ['FROM-SERVER']);
    const load = makeCoinImageLoader([loaded(['IN-MEMORY'])], fetchFromServer);

    expect(await load('c1')).toEqual(['IN-MEMORY']);
    expect(fetchFromServer).not.toHaveBeenCalled();
  });

  it('fetches per coin when imagePaths was never loaded', async () => {
    const fetchFromServer = vi.fn(async (id: string) => [`SERVER-${id}`]);
    const load = makeCoinImageLoader([notLoaded(2)], fetchFromServer);

    expect(await load('c1')).toEqual(['SERVER-c1']);
    expect(fetchFromServer).toHaveBeenCalledWith('c1');
  });

  it('does NOT fetch for a coin the server says has no photographs', async () => {
    /* ---------------------------------------------------------------------
     * The whole-collection saving. A printed report over 105 coins where 60
     * have no pictures must not make 60 round trips to be told so: the list
     * already said `imageCount: 0`, and that answer cannot be improved on.
     * ------------------------------------------------------------------- */
    const fetchFromServer = vi.fn(async () => ['NEVER']);
    const load = makeCoinImageLoader([notLoaded(0)], fetchFromServer);

    expect(await load('c1')).toEqual([]);
    expect(fetchFromServer).not.toHaveBeenCalled();
  });

  it('fetches only once per coin, however often it is asked', async () => {
    const fetchFromServer = vi.fn(async () => ['SERVER']);
    const load = makeCoinImageLoader([notLoaded(1)], fetchFromServer);

    await load('c1');
    await load('c1');
    await load('c1');

    expect(fetchFromServer).toHaveBeenCalledTimes(1);
  });

  it('fetches for a coin it has never heard of, rather than answering empty', async () => {
    // "I have no record of this coin" must not be reported as "this coin has
    // no photographs" — the second is a claim we have no basis for.
    const fetchFromServer = vi.fn(async () => ['SERVER']);
    const load = makeCoinImageLoader([], fetchFromServer);

    expect(await load('unknown')).toEqual(['SERVER']);
    expect(fetchFromServer).toHaveBeenCalledWith('unknown');
  });

  it('lets a fetch failure propagate instead of reporting "no photographs"', async () => {
    /* ---------------------------------------------------------------------
     * A rejection has to stay a rejection. A loader that swallowed the error
     * and returned `[]` would tell its caller the coin has no pictures — and
     * the batch import's "append" path builds the array it is about to SAVE
     * out of exactly this answer. Turning a network blip into an empty array
     * there deletes photographs.
     * ------------------------------------------------------------------- */
    const fetchFromServer = vi.fn(async () => { throw new Error('offline'); });
    const load = makeCoinImageLoader([notLoaded(4)], fetchFromServer);

    await expect(load('c1')).rejects.toThrow('offline');
  });
});
