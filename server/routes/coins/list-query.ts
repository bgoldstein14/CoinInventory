/**
 * routes/coins/list-query.ts — the SQL and row-assembly behind GET /api/coins.
 *
 * Coin photos are stored as base64 text in CoinImages.ImageData (NVARCHAR(MAX)),
 * roughly 250 KB per image, several images per coin. Returning every image of
 * every coin from this endpoint does not merely make the response large: past
 * about a hundred coins `res.json()` throws `RangeError: Invalid string length`
 * from JSON.stringify, because the concatenated base64 exceeds V8's maximum
 * string length. That is a hard wall, not a budget — the response works at 104
 * coins and cannot be serialised at 105. No server setting, memory limit or
 * payload cap is involved, and the client sees only a 500, so it is easy to
 * misdiagnose as a database fault.
 *
 * So the list endpoint has two jobs kept deliberately separate:
 *
 *   1. ALWAYS report how many images a coin has, as `imageCount`, via a
 *      COUNT(*) aggregate in SQL Server so the image *text* never leaves the
 *      database. Counting rows in JavaScript would mean fetching them first,
 *      which is the exact thing being avoided.
 *
 *   2. OMIT THE IMAGE PAYLOADS by default, always. The base64 set is opt-in via
 *      `?includeImages=true` and nothing in the shipped app asks for it. Screens
 *      that need photographs fetch them one coin at a time from
 *      `GET /api/coins/:id/images`, and grid thumbnails come one binary response
 *      at a time from `GET /api/coins/:id/thumbnail`.
 *
 * The size of this response is therefore bounded by the number of coins and
 * nothing else; it cannot grow with the photo library.
 *
 * All database work goes through the `db` handle `withDb()` hands the caller —
 * this module never touches the pool directly and never calls resetPool(). See
 * db/index.ts for why that matters.
 */

import sql from 'mssql';
import { rowToCoin } from '../../db';

/**
 * Decides whether a GET /api/coins request wants the image payloads inline.
 *
 * THE DEFAULT IS "OMIT". An absent parameter means `false`: no `imagePaths`
 * key on any coin in the response. Flipping that back re-creates the
 * `RangeError: Invalid string length` outage described in the file header, and
 * it fails all at once rather than gradually. Nothing in the shipped app
 * passes this parameter; it survives for ad-hoc use and for the tests that pin
 * both behaviours.
 *
 * Parsing fails TOWARDS omitting. Accepted "yes" spellings are 'true', '1' and
 * 'yes' (case-insensitive), because different HTTP clients spell booleans
 * differently; anything else — absent, empty, a typo like 'ture', an array, an
 * object — means omit. Of the two ways to misread this parameter, one produces
 * a slightly disappointing response a caller notices and fixes, and the other
 * produces an exception that takes the application down.
 *
 * @param rawParam - `req.query['includeImages']`, whatever shape Express gives
 *                   it (string, array of strings, parsed object, or undefined).
 */
export function shouldIncludeImages(rawParam: unknown): boolean {
  // Express types a query parameter as possibly repeated (?a=1&a=2).
  const value = Array.isArray(rawParam) ? rawParam[0] : rawParam;

  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Runs the queries behind GET /api/coins and assembles the JSON array.
 *
 * QUERY ORDER IS PART OF THE CONTRACT of this function — the spec files drive
 * the mssql mock by queueing one response per `query()` call, in order:
 *
 *   includeImages = true   ->  1. coins   2. images   3. image counts
 *   includeImages = false  ->  1. coins   2. image counts   <- THE DEFAULT
 *
 * The images query is genuinely skipped when it is not needed; that skip is
 * the whole point of the flag.
 *
 * @param db            - The healthy pool handed over by `withDb()`.
 * @param includeImages - When false, the returned objects have no `imagePaths`
 *                        key at all (not an empty array — the key is absent, so
 *                        a client can tell "not loaded" from "no images").
 */
export async function loadCoinList(
  db: sql.ConnectionPool,
  includeImages: boolean
): Promise<Record<string, unknown>[]> {
  // ----- 1. The coins themselves ---------------------------------------
  const coinsResult = await db.request().query(
    'SELECT * FROM Coins ORDER BY Denomination, Year'
  );

  // ----- 2. Image payloads, only if the caller actually wants them ------
  // ORDER BY CoinId, SortOrder gives each coin's images in display order; the
  // grouping loop below preserves the order rows arrive in.
  const imagesByCoinId = new Map<string, string[]>();
  if (includeImages) {
    const imagesResult = await db.request().query(
      'SELECT CoinId, ImageData FROM CoinImages ORDER BY CoinId, SortOrder'
    );
    for (const img of imagesResult.recordset) {
      const coinId = img['CoinId'] as string;
      if (!imagesByCoinId.has(coinId)) imagesByCoinId.set(coinId, []);
      imagesByCoinId.get(coinId)!.push(img['ImageData'] as string);
    }
  }

  // ----- 3. imageCount: the COUNT(*) aggregate -------------------------
  //
  // COUNT(*) counts rows without reading any column values, so SQL Server
  // satisfies this from the IX_CoinImages_CoinId_SortOrder index (see
  // setup-database.sql) and never touches the ImageData blobs. The result is a
  // few kilobytes however large the photo library grows.
  //
  // Do NOT "simplify" this into fetching the image rows and counting them in
  // JavaScript: fetching the rows is the expensive part this avoids.
  const countsResult = await db.request().query(
    'SELECT CoinId, COUNT(*) AS ImageCount FROM CoinImages GROUP BY CoinId'
  );
  const imageCountByCoinId = new Map<string, number>();
  for (const row of countsResult.recordset) {
    imageCountByCoinId.set(row['CoinId'] as string, Number(row['ImageCount'] ?? 0));
  }

  // ----- 4. Stitch it all together -------------------------------------
  return coinsResult.recordset.map((row: Record<string, unknown>) => {
    const coinId = row['CoinId'] as string;

    const coin: Record<string, unknown> = {
      ...rowToCoin(row),
      // A coin with no image rows is simply absent from the GROUP BY result,
      // so default to 0 rather than undefined — the frontend wants a number.
      imageCount: imageCountByCoinId.get(coinId) ?? 0,
    };

    /*
     * OMIT THE KEY. DO NOT SET IT TO `undefined`, AND NEVER TO `[]`.
     *
     * `PUT /api/coins/:id` carrying an `imagePaths` key REPLACES the coin's
     * whole image set (write-helpers.ts, replaceImages), so an EMPTY array is
     * a destructive instruction: "this coin has no photographs, delete the
     * ones it has". Returning `imagePaths: []` for a coin whose photos were
     * merely not loaded would let any round trip that echoes the field back
     * destroy the user's photographs silently. An ABSENT key cannot be
     * mistaken that way, and the client distinguishes the two (see
     * CoinRecord.imagePaths in src/app/types/coin.model.ts).
     *
     * `undefined` is wrong too, even though JSON.stringify drops it: the
     * property would still exist, so `'imagePaths' in coin` and
     * `Object.keys()` would report it — and the server's own update guard is
     * written as `hasOwnProperty('imagePaths')`.
     */
    if (includeImages) {
      coin['imagePaths'] = imagesByCoinId.get(coinId) ?? [];
    }

    return coin;
  });
}
