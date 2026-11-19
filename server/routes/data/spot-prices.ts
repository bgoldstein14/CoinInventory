/**
 * Precious-metal spot prices. Mounted at /api:
 *
 *   GET  /spot-prices/latest  the most recently saved row
 *   GET  /spot-prices/fetch   live COMEX/NYMEX futures prices (no database;
 *                             the outbound call is in ./spot-price-source)
 *   POST /spot-prices         save a set of prices as a new history row
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn, logError } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';
import { fetchSpotPrices } from './spot-price-source';

const router = Router();

router.get('/spot-prices/latest', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching latest spot prices from database');

    const prices = await withDb(async (db) => {
      const result = await db.request()
        .query('SELECT * FROM SpotPrices ORDER BY FetchedAt DESC LIMIT 1');

      if (result.recordset.length === 0) return null;

      const row = result.recordset[0];
      return {
        gold: row['Gold'],
        silver: row['Silver'],
        platinum: row['Platinum'],
        copper: row['Copper'],
        source: row['Source'],
        fetchedAt: row['FetchedAt'],
      };
    });

    if (!prices) {
      res.json({ gold: 0, silver: 0, platinum: 0, copper: 0, source: null, fetchedAt: null });
      return;
    }

    sendJson(res, 'GET /api/spot-prices/latest', prices, 'spot prices');
  } catch (err) {
    sendDbError(res, 'GET /api/spot-prices/latest', err, 'Failed to retrieve spot prices', 'spot prices');
  }
});

/**
 * Fetches live prices from COMEX/NYMEX futures. On failure it still answers
 * 200, with zeroed prices and an `error` field (the frontend treats missing
 * prices as unknown), and lists which metals failed so a zero is never
 * presented as a real price.
 */
router.get('/spot-prices/fetch', async (_req: Request, res: Response) => {
  try {
    const { prices, source, failed } = await fetchSpotPrices();

    res.json({
      prices,
      source,
      timestamp: new Date().toISOString(),
      // Only present on failure, so callers checking `error` are unaffected.
      ...(failed.length
        ? { error: `No price available for: ${failed.join(', ')}`, failed }
        : {}),
    });
  } catch (err) {
    // fetchSpotPrices() shouldn't throw; keep the same degraded shape.
    logError('Spot price fetch failed unexpectedly', err);
    res.json({
      prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
      source: 'COMEX/NYMEX futures via Yahoo Finance',
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

/**
 * Is every metal zero or missing? A precious metal never trades at zero, so an
 * all-zero row is no data, and since the client applies the latest row at
 * start-up it would break melt values until replaced. All, not any: partial
 * sets are normal (metals are fetched independently).
 */
function isAllZero(prices: { gold?: unknown; silver?: unknown; platinum?: unknown; copper?: unknown }): boolean {
  // Missing or non-numeric counts as zero (Number(undefined) is NaN, so be explicit).
  const asNumber = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return asNumber(prices.gold) <= 0
    && asNumber(prices.silver) <= 0
    && asNumber(prices.platinum) <= 0
    && asNumber(prices.copper) <= 0;
}

router.post('/spot-prices', async (req: Request, res: Response) => {
  try {
    const { gold, silver, platinum, copper, source } = req.body ?? {};

    // Refuse all-zero sets here too; the client's guard can't cover every
    // caller (retries, scripts, stale builds).
    if (isAllZero({ gold, silver, platinum, copper })) {
      logWarn('POST /api/spot-prices — refused an all-zero price set (a metal never trades at zero, so this is missing data, not a price)');
      res.status(400).json({
        error: 'Refusing to save an all-zero price set. A zero means "no price", not a price of zero — at least one metal must have a value.'
      });
      return;
    }

    logInfo(`Saving spot prices: Au=$${gold} Ag=$${silver}`);

    const inserted = await withDb(async (db) => {
      const result = await db.request()
        .input('gold', DB_BINDINGS.spotPrice, gold ?? 0)
        .input('silver', DB_BINDINGS.spotPrice, silver ?? 0)
        .input('platinum', DB_BINDINGS.spotPrice, platinum ?? 0)
        .input('copper', DB_BINDINGS.spotCopper, copper ?? 0)
        .input('source', DB_BINDINGS.spotSource, source ?? null)
        .query(`
          INSERT INTO SpotPrices (Gold, Silver, Platinum, Copper, Source)
          VALUES (@gold, @silver, @platinum, @copper, @source)
          RETURNING SpotPriceId, FetchedAt
        `);

      // RETURNING should give one row; return null rather than throw if it doesn't.
      return result.recordset[0] ?? null;
    });

    if (!inserted) {
      logError('POST /api/spot-prices — INSERT returned no row from its OUTPUT clause');
      res.status(500).json({ error: 'Failed to save spot prices' });
      return;
    }

    res.status(201).json({
      id: inserted['SpotPriceId'],
      fetchedAt: inserted['FetchedAt'],
    });
  } catch (err) {
    sendDbError(res, 'POST /api/spot-prices', err, 'Failed to save spot prices');
  }
});

export default router;
