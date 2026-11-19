/**
 * The queries and row assembly behind GET /api/coins.
 *
 * Photos are base64 text (~250 KB each). Returning every image of every coin
 * makes res.json() throw `RangeError: Invalid string length` past roughly a
 * hundred coins (V8's maximum string length), which shows up as an
 * unexplained 500. So the list:
 *
 *   1. always reports `imageCount` via a SQL COUNT(*), so image text never
 *      leaves the database;
 *   2. omits image payloads unless `?includeImages=true`, which the app never
 *      sends. Photos come from GET /api/coins/:id/images and thumbnails from
 *      GET /api/coins/:id/thumbnail.
 *
 * The response size therefore depends only on the number of coins.
 */

import { rowToCoin, type DbConnection } from '../../db';
import { loadAllCatalogRefs } from './catalog-refs';

/**
 * Whether a GET /api/coins request wants image payloads inline. Defaults to
 * no; only 'true', '1' or 'yes' (case-insensitive) opt in, so any parsing
 * mistake omits rather than risking the RangeError above.
 *
 * @param rawParam - `req.query['includeImages']` in whatever shape Express gives it.
 */
export function shouldIncludeImages(rawParam: unknown): boolean {
  // A query parameter may be repeated (?a=1&a=2).
  const value = Array.isArray(rawParam) ? rawParam[0] : rawParam;

  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Runs the queries behind GET /api/coins and assembles the JSON array.
 * Queries run in order: coins, images (only if includeImages), image counts,
 * catalogue references.
 *
 * @param db            - The connection from withDb().
 * @param includeImages - When false, objects have no `imagePaths` key at all,
 *                        so a client can tell "not loaded" from "no images".
 */
export async function loadCoinList(
  db: DbConnection,
  includeImages: boolean
): Promise<Record<string, unknown>[]> {
  // 1. The coins.
  const coinsResult = await db.request().query(
    'SELECT * FROM Coins ORDER BY Denomination, Year'
  );

  // 2. Image payloads, only if requested; ordered for display.
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

  // 3. imageCount. COUNT(*) is served from IX_CoinImages_CoinId_SortOrder
  // without reading ImageData. Don't replace it with fetching rows and
  // counting in JavaScript.
  const countsResult = await db.request().query(
    'SELECT CoinId, COUNT(*) AS ImageCount FROM CoinImages GROUP BY CoinId'
  );
  const imageCountByCoinId = new Map<string, number>();
  for (const row of countsResult.recordset) {
    imageCountByCoinId.set(row['CoinId'] as string, Number(row['ImageCount'] ?? 0));
  }

  // 4. Catalogue references (small rows, always included).
  const refsByCoinId = await loadAllCatalogRefs(db);

  // 5. Combine.
  return coinsResult.recordset.map((row: Record<string, unknown>) => {
    const coinId = row['CoinId'] as string;

    const coin: Record<string, unknown> = {
      ...rowToCoin(row),
      catalogRefs: refsByCoinId.get(coinId) ?? [],
      // Coins without images are absent from the GROUP BY; default to 0.
      imageCount: imageCountByCoinId.get(coinId) ?? 0,
    };

    // Omit the key entirely; never `[]` or `undefined`. PUT with `imagePaths`
    // replaces the image set, so echoing back `[]` would delete the photos,
    // and an undefined property still passes the server's hasOwnProperty check.
    if (includeImages) {
      coin['imagePaths'] = imagesByCoinId.get(coinId) ?? [];
    }

    return coin;
  });
}
