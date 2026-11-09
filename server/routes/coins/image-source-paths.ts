/**
 * routes/coins/image-source-paths.ts — POST /api/coins/image-source-paths
 *
 * Answers "which ORIGINAL files are already attached to these coins?" for a
 * whole review screen in one round trip.
 *
 *   Request:  { "coinIds": ["morgan", "peace"] }
 *   Response: { "results": { "morgan": ["D:\\pics\\morgan obverse.jpg",
 *                                       "D:\\pics\\morgan reverse.jpg"],
 *                            "peace":  [] } }
 *
 * THE BUG THIS EXISTS TO PREVENT. The batch import is append-only and has no
 * way of knowing what is already attached: the only thing that identifies a
 * source FILE is `CoinImages.SourcePath`, and that value does not otherwise
 * reach the browser. `CoinRecord.imagePaths` — the array the whole front end
 * works from — holds the downscaled `data:` URLs and nothing else, by
 * deliberate design (see services/image-source-paths.ts). Without this
 * endpoint, re-importing a folder of 300 photos of which 290 were already
 * attached re-saves all 300, duplicating 290 of them.
 *
 * A BATCHED endpoint rather than GET /api/coins/:id/images, which already
 * returns `sourcePath` for ONE coin: a review screen covers a hundred-odd
 * coins, and that many requests to decide what to skip would cost more than
 * the duplicate import. Shape and limits deliberately mirror
 * POST /api/images/exists — one POST, an array in, a keyed object out, a hard
 * cap on the batch size.
 *
 * ImageData IS NOT IN THE SELECT LIST, AND MUST NEVER BE. Those NVARCHAR(MAX)
 * base64 blobs ARE the database; everything else is a few kilobytes of text.
 * Selecting them for a hundred coins to answer a question about file names
 * moves tens of megabytes to decide something a few hundred short strings can
 * decide. The column list below is part of this endpoint's contract and its
 * spec asserts on it.
 *
 * POST for a read, same reason as /api/images/exists: the payload is an
 * unbounded list, and a query string has both a length limit and a pile of
 * encoding traps.
 *
 * Every database call goes through `withDb()`; there are no `resetPool()`
 * calls. See db/index.ts for why that matters.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';

const router = Router();

/**
 * The most coins we will answer for in one request.
 *
 * Each id becomes one bound parameter in an IN list, and SQL Server refuses a
 * statement with more than 2,100 parameters outright. 500 stays an order of
 * magnitude clear of that ceiling while covering any review screen a real
 * photo folder produces. A caller with more than 500 should page; hitting
 * this limit means something unintended.
 *
 * Matches MAX_PATHS_PER_REQUEST in routes/images/exists.ts on purpose — two
 * batched endpoints with two different limits is a trap for the next reader.
 */
export const MAX_COIN_IDS_PER_REQUEST = 500;

// MOUNT ORDER NOTE: this router is mounted FIRST in routes/coins/index.ts.
// The only other POST under /api/coins is `POST /` (create a coin), which is
// an exact-root match and cannot capture `/image-source-paths` — but "cannot
// today" is a weaker guarantee than "is matched first", and a 201 Created
// here would silently insert a junk coin on every import.
router.post('/image-source-paths', async (req: Request, res: Response) => {
  const rawIds = (req.body as { coinIds?: unknown } | undefined)?.coinIds;

  // ----- 400: the body is not the shape we documented ---------------------
  if (!Array.isArray(rawIds)) {
    logWarn('POST /api/coins/image-source-paths called without a "coinIds" array');
    res.status(400).json({ error: 'Body must be { "coinIds": string[] }.' });
    return;
  }

  // ----- 400: too many coins for one statement ----------------------------
  if (rawIds.length > MAX_COIN_IDS_PER_REQUEST) {
    logWarn(
      `POST /api/coins/image-source-paths rejected ${rawIds.length} ids (limit ${MAX_COIN_IDS_PER_REQUEST})`
    );
    res.status(400).json({
      error: `Too many coin ids: ${rawIds.length}. A maximum of ${MAX_COIN_IDS_PER_REQUEST} coins may be asked about per request.`,
    });
    return;
  }

  // Keep only strings, and de-duplicate. Non-string entries are dropped rather
  // than reported, exactly as /api/images/exists drops non-string paths: there
  // is no sensible key to return them under, and the caller finding no entry
  // means the same thing as an empty one.
  const coinIds = [...new Set(rawIds.filter((id): id is string => typeof id === 'string'))];

  /**
   * EVERY REQUESTED ID GETS AN ENTRY, even when the coin has no photos or does
   * not exist at all.
   *
   * The alternative — omitting empty coins — makes "this coin has nothing
   * attached" and "the server did not answer about this coin" the same value
   * on the client, and the client's reaction to those two has to differ: the
   * first means "attach everything", the second means "do not guess". A
   * present-but-empty array says the question was asked and answered.
   */
  const results: Record<string, string[]> = {};
  for (const id of coinIds) results[id] = [];

  // Nothing to ask about. Answer without opening a connection — an import of a
  // folder whose coins all turn out to be new hits this every time.
  if (coinIds.length === 0) {
    res.json({ results });
    return;
  }

  try {
    const rows = await withDb(async (db) => {
      const request = db.request();

      // A parameterised IN list. The ids are user data (they arrive in a
      // request body), so they are BOUND, never interpolated — the spec sends
      // a `'; DROP TABLE Coins; --` id to keep that honest. Parameter names are
      // positional and generated here, so they cannot collide.
      const placeholders = coinIds.map((id, index) => {
        const name = `coinId${index}`;
        request.input(name, DB_BINDINGS.coinId, id);
        return `@${name}`;
      });

      // No ORDER BY: the client builds a set out of this and compares by
      // normalised path, so ordering would be work nobody reads.
      const result = await request.query(
        `SELECT CoinId, SourcePath FROM CoinImages ` +
          `WHERE SourcePath IS NOT NULL AND CoinId IN (${placeholders.join(', ')})`
      );

      return result.recordset as Record<string, unknown>[];
    });

    let pathCount = 0;
    for (const row of rows) {
      const coinId = row['CoinId'] as string | null | undefined;
      const sourcePath = row['SourcePath'] as string | null | undefined;

      // The WHERE clause already excludes SQL NULL, but a whitespace-only
      // SourcePath is just as useless and has to be filtered in code. Both are
      // "no path recorded", which is how every image imported before the
      // column existed looks.
      if (!coinId || !sourcePath || sourcePath.trim().length === 0) continue;

      // Keeps the response keyed strictly by what was requested.
      const bucket = results[coinId];
      if (!bucket) continue;

      bucket.push(sourcePath);
      pathCount += 1;
    }

    logInfo(
      `Returned ${pathCount} recorded source path(s) for ${coinIds.length} coin(s)`
    );
    res.json({ results });
  } catch (err) {
    sendDbError(
      res,
      'POST /api/coins/image-source-paths',
      err,
      'Failed to retrieve image source paths'
    );
  }
});

export default router;
