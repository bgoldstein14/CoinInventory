/**
 * routes/coins/reads.ts — the read-only coin endpoints.
 *
 * Mounted (via routes/coins/index.ts) at /api/coins, so the paths below are
 * relative to that:
 *
 *   GET /      -> GET /api/coins       all coins, with images and tags joined
 *   GET /:id   -> GET /api/coins/:id   one coin, with its images and tags
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

const router = Router();

// ============================================================
// GET /api/coins — all coins with images and tags joined
// ============================================================
router.get('/', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching all coins with images and tags');

    const coins = await withDb(async (db) => {
      const coinsResult = await db.request().query('SELECT * FROM Coins ORDER BY Denomination, Year');
      const imagesResult = await db.request().query('SELECT * FROM CoinImages ORDER BY SortOrder');
      const tagsResult = await db.request().query('SELECT * FROM CoinTags ORDER BY Tag');

      // Build lookup maps for images and tags by CoinId
      const imagesByCoinId = new Map<string, string[]>();
      for (const img of imagesResult.recordset) {
        const coinId = img['CoinId'] as string;
        if (!imagesByCoinId.has(coinId)) imagesByCoinId.set(coinId, []);
        imagesByCoinId.get(coinId)!.push(img['ImageData'] as string);
      }

      const tagsByCoinId = new Map<string, string[]>();
      for (const t of tagsResult.recordset) {
        const coinId = t['CoinId'] as string;
        if (!tagsByCoinId.has(coinId)) tagsByCoinId.set(coinId, []);
        tagsByCoinId.get(coinId)!.push(t['Tag'] as string);
      }

      return coinsResult.recordset.map((row: Record<string, unknown>) => ({
        ...rowToCoin(row),
        imagePaths: imagesByCoinId.get(row['CoinId'] as string) ?? [],
        tags: tagsByCoinId.get(row['CoinId'] as string) ?? [],
      }));
    });

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

      const imagesResult = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT * FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder');

      const tagsResult = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT * FROM CoinTags WHERE CoinId = @id ORDER BY Tag');

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
