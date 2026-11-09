/**
 * routes/coins/reads.ts — the read-only coin endpoints.
 *
 * Mounted (via routes/coins/index.ts) at /api/coins, so the paths below are
 * relative to that:
 *
 *   GET /      -> GET /api/coins       all coins, with an `imageCount` and
 *                                      NO image payloads, unless the caller
 *                                      explicitly asks ?includeImages=true
 *   GET /:id   -> GET /api/coins/:id   one coin, with its images
 *
 * Note the asymmetry between those two, which is deliberate: the LIST never
 * carries photographs and the SINGLE coin always does. One coin's images are
 * a few megabytes at worst and are what the user is actually looking at; a
 * whole collection's are a response that cannot be built at all.
 *
 * The list query itself — the SQL, the COUNT(*) aggregate behind `imageCount`,
 * and the `includeImages` flag — lives in routes/coins/list-query.ts, which
 * also documents WHY the list must omit image payloads (short version: past
 * ~100 coins `res.json()` throws `RangeError: Invalid string length`).
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
import { sendDbError, sendJson } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { loadCoinList, shouldIncludeImages } from './list-query';

const router = Router();

// GET /api/coins — all coins, with imageCount and WITHOUT the images
//
// THE DEFAULT IS "NO IMAGE PAYLOADS". With the parameter absent there is no
// `imagePaths` key on any coin — not an empty array, no key at all, so a
// client can tell "not loaded" from "this coin has no photographs". Every
// coin still carries `imageCount`, which answers "does this coin have photos,
// and how many" without moving a single byte of base64.
//
// `?includeImages=true` inlines the payloads for an ad-hoc caller. Nothing in
// the shipped app passes it, and it is the shape that cannot be serialised on
// a real collection — see shouldIncludeImages() in list-query.ts.
//
// The client gets its photographs from the per-coin endpoints instead:
// GET /api/coins/:id/images for the real thing, and
// GET /api/coins/:id/thumbnail for one binary row thumbnail at a time.
router.get('/', async (req: Request, res: Response) => {
  const includeImages = shouldIncludeImages(req.query['includeImages']);

  try {
    logInfo(`Fetching all coins with image counts (includeImages=${includeImages})`);

    const coins = await withDb((db) => loadCoinList(db, includeImages));

    logInfo(`Retrieved ${coins.length} coins`);

    /*
     * SENDING IS ITS OWN STEP, AND THAT IS THE WHOLE POINT. `res.json(coins)`
     * can throw `RangeError: Invalid string length` with every row already in
     * hand, and a single catch block around both the read and the send cannot
     * tell those apart — so it blames the database. sendJson() wraps nothing
     * but the send, which earns the user the honest answer: the coin list
     * could not be drawn, and the data is safe. See db-error-response.ts.
     */
    sendJson(res, 'GET /api/coins', coins, 'coin list');
  } catch (err) {
    // Reached ONLY when the read failed: the connection, or the query.
    sendDbError(res, 'GET /api/coins', err, 'Failed to retrieve coins', 'coin list');
  }
});

// GET /api/coins/:id — single coin with its images
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

      return {
        ...rowToCoin(coinResult.recordset[0]),
        imagePaths: imagesResult.recordset.map((r: Record<string, unknown>) => r['ImageData'] as string),
      };
    });

    if (!coin) {
      logWarn(`Coin not found: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    // This endpoint DOES inline the coin's photographs, so it is the second
    // most likely response in the API to be unbuildable. Same split.
    sendJson(res, 'GET /api/coins/:id', coin, 'coin');
  } catch (err) {
    sendDbError(res, 'GET /api/coins/:id', err, 'Failed to retrieve coin', 'coin');
  }
});

export default router;
