/**
 * POST /api/coins/image-source-paths: which original files are already
 * attached to these coins, for a whole import review screen in one request.
 *
 *   Request:  { "coinIds": ["morgan", "peace"] }
 *   Response: { "results": { "morgan": ["D:\pics\morgan obverse.jpg",
 *                                       "D:\pics\morgan reverse.jpg"],
 *                            "peace":  [] } }
 *
 * Lets the batch import skip files already attached instead of duplicating
 * them (the client's imagePaths hold only data URLs, not source paths).
 * Batched like POST /api/images/exists. ImageData must never be selected:
 * those blobs are the bulk of the database, and the spec checks the column
 * list. POST because the id list is unbounded.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';

const router = Router();

/**
 * Max coins per request. Each id is a bound parameter; 500 is well under
 * engine parameter limits. Matches MAX_PATHS_PER_REQUEST in
 * routes/images/exists.ts.
 */
export const MAX_COIN_IDS_PER_REQUEST = 500;

// Mounted first in routes/coins/index.ts so `POST /` (create a coin) can never
// capture this path.
router.post('/image-source-paths', async (req: Request, res: Response) => {
  const rawIds = (req.body as { coinIds?: unknown } | undefined)?.coinIds;

  // 400: wrong body shape.
  if (!Array.isArray(rawIds)) {
    logWarn('POST /api/coins/image-source-paths called without a "coinIds" array');
    res.status(400).json({ error: 'Body must be { "coinIds": string[] }.' });
    return;
  }

  // 400: too many ids.
  if (rawIds.length > MAX_COIN_IDS_PER_REQUEST) {
    logWarn(
      `POST /api/coins/image-source-paths rejected ${rawIds.length} ids (limit ${MAX_COIN_IDS_PER_REQUEST})`
    );
    res.status(400).json({
      error: `Too many coin ids: ${rawIds.length}. A maximum of ${MAX_COIN_IDS_PER_REQUEST} coins may be asked about per request.`,
    });
    return;
  }

  // Keep strings only, de-duplicated (as /api/images/exists does).
  const coinIds = [...new Set(rawIds.filter((id): id is string => typeof id === 'string'))];

  /**
   * Every requested id gets an entry, even if empty, so "nothing attached"
   * is distinguishable from "not answered".
   */
  const results: Record<string, string[]> = {};
  for (const id of coinIds) results[id] = [];

  // Nothing to look up: answer without a query.
  if (coinIds.length === 0) {
    res.json({ results });
    return;
  }

  try {
    const rows = await withDb(async (db) => {
      const request = db.request();

      // Bound parameters (the spec tries an injection string); names are generated.
      const placeholders = coinIds.map((id, index) => {
        const name = `coinId${index}`;
        request.input(name, DB_BINDINGS.coinId, id);
        return `@${name}`;
      });

      // No ORDER BY: the client builds a set.
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

      // Whitespace-only paths are as useless as NULL.
      if (!coinId || !sourcePath || sourcePath.trim().length === 0) continue;

      // Keyed strictly by what was requested.
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
