/**
 * routes/coins/reads.ts — the read-only coin endpoints.
 *
 * Mounted (via routes/coins/index.ts) at /api/coins, so the paths below are
 * relative to that:
 *
 *   GET /      -> GET /api/coins       all coins, with tags joined, an
 *                                      `imageCount`, and (for now) the images
 *                                      inline unless ?includeImages=false
 *   GET /:id   -> GET /api/coins/:id   one coin, with its images and tags
 *
 * The list query itself — the SQL, the COUNT(*) aggregate behind `imageCount`,
 * and the `includeImages` flag — lives in routes/coins/list-query.ts, which
 * also documents WHY the list must be able to omit image payloads (the short
 * version: returning every base64 image on every app load is ~150 MB of JSON).
 *
 * Reads are separated from writes (routes/coins/writes.ts) because they are
 * completely different in shape: these two handlers are plain SELECTs plus a
 * shape conversion, while the write handlers are transactional and carry the
 * partial-update rules.
 *
 * As everywhere in this backend, database work goes through `withDb()`: it
 * hands us a healthy pool and retries exactly once if the *connection* dies
 * mid-call. It does NOT retry ordinary query errors, and there must be no
 * resetPool() call in this file — route code tearing down the shared pool was
 * the original crash (see db/index.ts).
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, rowToCoin, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { loadCoinList, shouldIncludeImages } from './list-query';

const router = Router();

// ============================================================
// GET /api/coins — all coins with tags, imageCount, and (for now) images
// ============================================================
//
// `?includeImages=false` drops the `imagePaths` array from every coin, which is
// what the app should use once the client fetches full images on demand from
// GET /api/coins/:id/images.
//
// NOTE ON THE DEFAULT: with the parameter absent, `imagePaths` is STILL
// populated, exactly as before. That is a deliberate, temporary compatibility
// shim while the Angular client is migrated — it is scheduled to flip to
// "omit by default" in a follow-up change. The full explanation is on
// shouldIncludeImages() in list-query.ts; please read it before relying on the
// current default.
router.get('/', async (req: Request, res: Response) => {
  const includeImages = shouldIncludeImages(req.query['includeImages']);

  try {
    logInfo(`Fetching all coins with tags and image counts (includeImages=${includeImages})`);

    const coins = await withDb((db) => loadCoinList(db, includeImages));

    logInfo(`Retrieved ${coins.length} coins`);
    res.json(coins);
  } catch (err) {
    sendDbError(res, 'GET /api/coins', err, 'Failed to retrieve coins');
  }
});

// ============================================================
// GET /api/coins/:id — single coin with images and tags
// ============================================================
router.get('/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Fetching coin ${id}`);

    const coin = await withDb(async (db) => {
      const coinResult = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT * FROM Coins WHERE CoinId = @id');

      // Returning null (rather than throwing) keeps the 404 out of the catch block.
      if (coinResult.recordset.length === 0) return null;

      // Explicit column lists rather than `SELECT *`. This endpoint is for ONE
      // coin, so returning its images inline is fine and intentional — but
      // there is still no reason to fetch columns we do not use.
      const imagesResult = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT ImageData FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder');

      const tagsResult = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT Tag FROM CoinTags WHERE CoinId = @id ORDER BY Tag');

      return {
        ...rowToCoin(coinResult.recordset[0]),
        imagePaths: imagesResult.recordset.map((r: Record<string, unknown>) => r['ImageData'] as string),
        tags: tagsResult.recordset.map((r: Record<string, unknown>) => r['Tag'] as string),
      };
    });

    if (!coin) {
      logWarn(`Coin not found: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    res.json(coin);
  } catch (err) {
    sendDbError(res, 'GET /api/coins/:id', err, 'Failed to retrieve coin');
  }
});

export default router;
