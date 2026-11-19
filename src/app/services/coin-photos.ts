 /**
  * Shared helpers for a coin's photographs.
  *
  * `GET /api/coins` omits photo data (it is too large to serialise for a whole
  * collection) and sends `imageCount` instead. So `CoinRecord.imagePaths` has
  * three states:
  *   ['data:...']  loaded photos
  *   []            loaded; the coin has none
  *   absent        not loaded
  * Treating "absent" as `[]` is dangerous: saving that value deletes the photos.
  */

import { CoinRecord } from '../types/coin.model';

/**
 * Number of photos: the loaded array if present (it reflects edits since load),
 * else `imageCount`, else 0.
 */
export function coinPhotoCount(coin: CoinRecord | null | undefined): number {
  if (!coin) return 0;

  const paths = coin.imagePaths;
  if (Array.isArray(paths)) return paths.length;

  return typeof coin.imageCount === 'number' ? coin.imageCount : 0;
}

/** Does this coin have any photographs? Answered without fetching anything. */
export function coinHasPhotos(coin: CoinRecord | null | undefined): boolean {
  return coinPhotoCount(coin) > 0;
}

/**
 * The coin's photos if loaded, or null if not. Callers about to save an image
 * array must distinguish "none" from "unknown"; `?? []` would delete photos.
 */
export function coinImagesInMemory(coin: CoinRecord | null | undefined): string[] | null {
  return Array.isArray(coin?.imagePaths) ? coin.imagePaths : null;
}

/**
 * Builds a per-coin photo loader that fetches only when needed: it uses
 * photos already in memory, skips coins whose `imageCount` is 0, and caches
 * results (including in-flight requests) per coin.
 *
 * A failed fetch is rethrown, never turned into `[]`, because callers such as
 * the batch import's append mode save what this returns. Failed coins are
 * dropped from the cache so a retry refetches.
 *
 * @param fetchFromServer per-coin fetch, normally `GET /api/coins/:id/images`
 */
export function makeCoinImageLoader(
  coins: readonly CoinRecord[],
  fetchFromServer: (coinId: string) => Promise<string[]>
): (coinId: string) => Promise<string[]> {
  const known = new Map<string, CoinRecord>();
  for (const coin of coins) known.set(coin.id, coin);

  /** coinId -> photos, or the in-flight promise for them. */
  const cache = new Map<string, Promise<string[]>>();

  return (coinId: string): Promise<string[]> => {
    const cached = cache.get(coinId);
    if (cached) return cached;

    const coin = known.get(coinId);

    // 1. Already loaded (including a genuine empty array).
    const inMemory = coinImagesInMemory(coin);
    if (inMemory) return Promise.resolve(inMemory);

    // 2. The list said there are none. Only for known coins: an unknown id is "no information".
    if (coin && coinPhotoCount(coin) === 0) return Promise.resolve([]);

    // 3. Fetch, once.
    const pending = fetchFromServer(coinId).catch((error: unknown) => {
      cache.delete(coinId);
      throw error;
    });

    cache.set(coinId, pending);
    return pending;
  };
}
