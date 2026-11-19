/**
 * Read-only coin endpoints. Mounted at /api/coins:
 *
 *   GET /      all coins with `imageCount` and no image payloads
 *              (unless ?includeImages=true)
 *   GET /:id   one coin, with its images
 *
 * The list never carries photos (a whole collection's can't be serialized;
 * see list-query.ts); a single coin always does.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, rowToCoin, DB_BINDINGS } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { loadCoinList, shouldIncludeImages } from './list-query';
import { loadCatalogRefs } from './catalog-refs';

const router = Router();

// GET /api/coins: all coins with imageCount and without images. The
// `imagePaths` key is absent (not empty) so clients can tell "not loaded"
// from "no photos". Photos come from GET /api/coins/:id/images and
// /:id/thumbnail.
router.get('/', async (req: Request, res: Response) => {
  const includeImages = shouldIncludeImages(req.query['includeImages']);

  try {
    logInfo(`Fetching all coins with image counts (includeImages=${includeImages})`);

    const coins = await withDb((db) => loadCoinList(db, includeImages));

    logInfo(`Retrieved ${coins.length} coins`);

    // Sent separately: res.json() can fail after every row was read, and
    // sendJson() reports that as a delivery failure, not a database one.
    sendJson(res, 'GET /api/coins', coins, 'coin list');
  } catch (err) {
    // Only reached when the read itself failed.
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

      // Null keeps the 404 out of the catch block.
      if (coinResult.recordset.length === 0) return null;

      // Explicit columns rather than SELECT *.
      const imagesResult = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT ImageData FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder');

      return {
        ...rowToCoin(coinResult.recordset[0]),
        catalogRefs: await loadCatalogRefs(db, id),
        imagePaths: imagesResult.recordset.map((r: Record<string, unknown>) => r['ImageData'] as string),
      };
    });

    if (!coin) {
      logWarn(`Coin not found: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    // Includes the coin's photos, so send separately too.
    sendJson(res, 'GET /api/coins/:id', coin, 'coin');
  } catch (err) {
    sendDbError(res, 'GET /api/coins/:id', err, 'Failed to retrieve coin', 'coin');
  }
});

export default router;
