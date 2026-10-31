/**
 * routes/coins/list-query.ts — the SQL and row-assembly behind GET /api/coins.
 *
 * ------------------------------------------------------------------
 * WHY THIS MODULE EXISTS (the "hundreds of megabytes" problem)
 * ------------------------------------------------------------------
 * Coin photos are stored as base64 text in CoinImages.ImageData, which is an
 * NVARCHAR(MAX) column. After the batch photo import each image is roughly
 * 250 KB of text, and many coins have several images.
 *
 * GET /api/coins originally did `SELECT * FROM CoinImages` and stuffed EVERY
 * image of EVERY coin into the response, on every single app load. Do the
 * arithmetic: 300 coins x 2 images x 250 KB is about 150 MB of JSON — per page
 * load. That makes the app unusable.
 *
 * So the list endpoint now has two jobs kept deliberately separate:
 *
 *   1. ALWAYS report how many images a coin has, as `imageCount`. This is done
 *      with a COUNT(*) aggregate in SQL Server, so the image *text* never
 *      leaves the database. Counting rows in JavaScript would mean fetching
 *      them first, which is the exact thing we are trying to avoid.
 *
 *   2. OPTIONALLY omit the image payloads entirely, via
 *      `GET /api/coins?includeImages=false`. The detail panel and gallery then
 *      fetch the full images for one coin on demand from
 *      `GET /api/coins/:id/images` (see routes/coins/images.ts).
 *
 * All database work is done through the `db` handle that `withDb()` hands the
 * caller — this module never touches the pool directly and never calls
 * resetPool(). See db/index.ts for why that matters.
 */

import sql from 'mssql';
import { rowToCoin } from '../../db';

// ============================================================
// The `includeImages` query parameter
// ============================================================

/**
 * Decides whether a GET /api/coins request wants the image payloads inline.
 *
 * *******************************************************************
 * *** TEMPORARY DEFAULT — THIS IS NOT THE FINAL BEHAVIOUR ***
 *
 * When the parameter is ABSENT we currently return `true`, i.e. `imagePaths`
 * is still fully populated exactly as it always was. That is deliberate and
 * TEMPORARY: the Angular client has not been switched over to the new
 * `GET /api/coins/:id/images` endpoint yet, and silently dropping `imagePaths`
 * from the default response would break it.
 *
 * The plan is to FLIP THIS DEFAULT TO `false` in a follow-up change, once the
 * client fetches full images on demand. Do not read the current default as a
 * settled decision — it is a compatibility shim with a known expiry date.
 * When it flips, the only line that needs to change is the `return true` below.
 * *******************************************************************
 *
 * Accepted "no" spellings are 'false', '0' and 'no' (case-insensitive), because
 * query strings are just text and different HTTP clients spell booleans
 * differently. Anything else — including a missing parameter, or a repeated one
 * where we take the first value — means "yes, include them".
 *
 * @param rawParam - `req.query['includeImages']`, whatever shape Express gives
 *                   it (string, array of strings, parsed object, or undefined).
 */
export function shouldIncludeImages(rawParam: unknown): boolean {
  // Express types a query parameter as possibly repeated (?a=1&a=2). Ours is
  // never repeated in practice, so collapse an array down to its first value.
  const value = Array.isArray(rawParam) ? rawParam[0] : rawParam;

  // Absent, or something exotic that is not a plain string -> use the default.
  if (typeof value !== 'string') return true;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  // <-- the temporary default described above lives here
  return true;
}

// ============================================================
// Loading the list
// ============================================================

/**
 * Runs the queries behind GET /api/coins and assembles the JSON array.
 *
 * QUERY ORDER IS PART OF THE CONTRACT of this function — the spec files drive
 * the mssql mock by queueing one response per `query()` call, in order:
 *
 *   includeImages = true   ->  1. coins   2. images   3. image counts
 *   includeImages = false  ->  1. coins   2. image counts
 *
 * (There used to be a tags query sitting between the images and the counts.
 * The tag feature was removed, so the sequence is one query shorter than it was
 * and everything after the images step shifted down a number. If you are
 * cross-referencing an older commit or comment, that is why the numbers differ.)
 *
 * (The images query is genuinely skipped when it is not needed; that skip is
 * the whole point of the flag.)
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
  // Note the explicit column list instead of `SELECT *`: there is no reason to
  // drag ImageId and SortOrder across the wire when all we do is group by coin.
  // ORDER BY CoinId, SortOrder gives each coin's images in display order (the
  // grouping loop below preserves the order rows arrive in).
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
  // This is the cheap half of the fix, and it is cheap precisely BECAUSE the
  // work happens inside SQL Server:
  //
  //   SELECT CoinId, COUNT(*) AS ImageCount FROM CoinImages GROUP BY CoinId
  //
  // COUNT(*) counts rows without reading any column values, so SQL Server can
  // satisfy the whole query from the IX_CoinImages_CoinId_SortOrder index (see
  // setup-database.sql) and never touches the multi-megabyte ImageData blobs.
  // The result set is one small row per coin that HAS images — a few kilobytes
  // in total, no matter how large the photo library grows.
  //
  // The tempting alternative — fetch the image rows and do
  // `rows.filter(r => r.CoinId === id).length` in JavaScript — would defeat the
  // entire purpose, because fetching the rows is the expensive part. Do not
  // "simplify" this into that.
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

    // Only add the key when images were requested. Assigning `undefined` would
    // still create an `imagePaths` property, and JSON.stringify would drop it
    // anyway, so branch explicitly to keep the intent obvious.
    if (includeImages) {
      coin['imagePaths'] = imagesByCoinId.get(coinId) ?? [];
    }

    return coin;
  });
}
