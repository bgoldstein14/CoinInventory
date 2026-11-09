 /*
 * coin-photos.ts — the two questions every screen asks about a coin's
 * photographs, answered in ONE place.
 * ---- WHY THIS FILE EXISTS ----
 * `GET /api/coins` does not carry photographs: on a ~100-coin collection the
 * response could not be serialised at all — `JSON.stringify` threw
 * `RangeError: Invalid string length` because every coin carried every
 * photograph as ~250 KB of base64 (see server/routes/coins/list-query.ts).
 *
 * So `CoinRecord.imagePaths` now has THREE states rather than two:
 *
 *   ['data:...']   loaded; these are the photographs
 *   []             loaded; the coin genuinely has none
 *   absent         NOT loaded; we do not know
 *
 * Nine different places in the app used to write `coin.imagePaths.length`.
 * Every one of them would now throw on a freshly loaded coin, and every one
 * of them that "fixed" it with `?? []` would be quietly claiming the coin
 * has no photographs — which, if that value ever reaches a PUT body, DELETES
 * them (see the header on CoinRecord.imagePaths). One shared pair of helpers
 * is the only way to be sure the rule is the same everywhere.
 *
 * ---- THE CHEAP HALF: `imageCount` ----
 * The list endpoint computes `imageCount` with a SQL `COUNT(*)`, which reads
 * no column values at all and is satisfied from an index. So "does this coin
 * have photographs, and how many" is ALREADY ANSWERED for every coin on
 * load, for free. Most of this file is about using that answer instead of
 * fetching anything.
  */

import { CoinRecord } from '../types/coin.model';

/**
 * How many photographs does this coin have?
 *
 * The loaded array wins when there is one, because it is current: the user
 * may have attached or deleted photographs since the page loaded, and
 * `imageCount` is a snapshot from then. `imageCount` is the fallback, and 0
 * is the answer when neither is available — a record with neither is a
 * hand-built or partially-imported one, and claiming it has photographs
 * would send the UI looking for something that is not there.
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
 * The photographs this coin already has IN MEMORY, or null if they were
 * never loaded.
 *
 * The null is the point. Callers that are about to SAVE an image array —
 * the batch import's append mode, above all — must be able to tell "this
 * coin has no photographs" from "I have not been told", because the first is
 * safe to write and the second deletes pictures. `?? []` is the bug.
 */
export function coinImagesInMemory(coin: CoinRecord | null | undefined): string[] | null {
  return Array.isArray(coin?.imagePaths) ? coin.imagePaths : null;
}

/**
 * Build a "give me this coin's photographs" function out of what the app
 * already has, fetching only what it genuinely has to.
 *
 * ---- THE THREE WAYS IT AVOIDS A REQUEST ----
 *  1. ALREADY IN MEMORY. A coin that has been opened (or just had photos
 *     attached) carries its real array, and that array is more current than
 *     anything the server would send back.
 *
 *  2. `imageCount` IS ZERO. The list already said this coin has nothing. A
 *     round trip cannot improve on that answer, and over a whole collection
 *     this is the difference between ~40 requests and ~105.
 *
 *  3. ASKED TWICE. The answer is cached per coin for the life of the loader,
 *     including the in-flight promise — so two screens asking at the same
 *     moment make one request between them.
 *
 * ---- A FAILURE STAYS A FAILURE ----
 * A rejected fetch is re-thrown, never converted into `[]`. Returning an
 * empty array would tell the caller "this coin has no photographs", and the
 * batch import builds the array it is about to SAVE out of exactly this
 * answer — so a network blip would delete the coin's pictures. Callers that
 * only want to DISPLAY something can catch and show nothing; callers that
 * are about to write must let it stop them.
 *
 * (The failed coin is also dropped from the cache, so a retry really retries
 * rather than replaying the error.)
 *
 * @param coins           the records to read in-memory payloads and counts from
 * @param fetchFromServer the per-coin fetch, normally
 *                        `GET /api/coins/:id/images` via ApiService
 */
export function makeCoinImageLoader(
  coins: readonly CoinRecord[],
  fetchFromServer: (coinId: string) => Promise<string[]>
): (coinId: string) => Promise<string[]> {
  const known = new Map<string, CoinRecord>();
  for (const coin of coins) known.set(coin.id, coin);

  /** coinId -> the answer, or the in-flight promise for it. */
  const cache = new Map<string, Promise<string[]>>();

  return (coinId: string): Promise<string[]> => {
    const cached = cache.get(coinId);
    if (cached) return cached;

    const coin = known.get(coinId);

    // 1. Loaded already — including a genuine empty array.
    const inMemory = coinImagesInMemory(coin);
    if (inMemory) return Promise.resolve(inMemory);

    // 2. The server already told us there is nothing to fetch.
    //    Note this only applies to a coin we actually HAVE a record for: an
    //    unknown id means "no information", not "no photographs".
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
