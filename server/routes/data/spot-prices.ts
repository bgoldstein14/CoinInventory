/**
 * routes/data/spot-prices.ts — precious-metal spot prices.
 *
 * Two different things share this prefix, which is worth being clear about:
 *
 *   GET  /spot-prices/latest  reads the most recent row we SAVED in SQL Server
 *   GET  /spot-prices/fetch   calls out to the metals.live web API for LIVE
 *                             prices — it touches no database at all
 *   POST /spot-prices         saves a set of prices as a new history row
 *
 * Mounted (via routes/data/index.ts) at /api, so those become
 * /api/spot-prices/latest and so on.
 *
 * The /fetch handler is the only outbound HTTP call in the whole backend. It
 * deliberately answers 200 with zeroed prices and an `error` field when the
 * upstream call fails, rather than erroring the request — the frontend treats
 * missing spot prices as "unknown", and a dead third-party API should not make
 * the app look broken.
 *
 * Database calls go through `withDb()`; parameter types come from DB_BINDINGS.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logError } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';

const router = Router();

router.get('/spot-prices/latest', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching latest spot prices from database');

    const prices = await withDb(async (db) => {
      const result = await db.request()
        .query('SELECT TOP 1 * FROM SpotPrices ORDER BY FetchedAt DESC');

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

    res.json(prices);
  } catch (err) {
    sendDbError(res, 'GET /api/spot-prices/latest', err, 'Failed to retrieve spot prices');
  }
});

// Fetches live spot prices from metals.live (COMEX proxy)
router.get('/spot-prices/fetch', async (_req: Request, res: Response) => {
  logInfo('Fetching spot prices from metals.live...');
  try {
    const response = await fetch('https://api.metals.live/v1/spot');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as Array<Record<string, number>>;

    const prices = { gold: 0, silver: 0, platinum: 0, copper: 0 };
    for (const entry of data) {
      if (entry['gold'] !== undefined) prices.gold = entry['gold'];
      if (entry['silver'] !== undefined) prices.silver = entry['silver'];
      if (entry['platinum'] !== undefined) prices.platinum = entry['platinum'];
      if (entry['copper'] !== undefined) prices.copper = entry['copper'];
    }

    logInfo(`Spot prices fetched: Au=$${prices.gold} Ag=$${prices.silver}`);
    res.json({ prices, source: 'COMEX via metals.live', timestamp: new Date().toISOString() });
  } catch (err) {
    logError('Spot price fetch failed', err);
    res.json({
      prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
      source: 'COMEX via metals.live',
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

router.post('/spot-prices', async (req: Request, res: Response) => {
  try {
    const { gold, silver, platinum, copper, source } = req.body ?? {};
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
          OUTPUT INSERTED.SpotPriceId, INSERTED.FetchedAt
          VALUES (@gold, @silver, @platinum, @copper, @source)
        `);

      // The OUTPUT clause should always give us exactly one row, but if the
      // driver hands back an empty recordset (it does happen when a trigger or
      // a driver quirk swallows the OUTPUT) then reading [0]['SpotPriceId']
      // throws "Cannot read properties of undefined". That used to bubble up as
      // an unhandled failure and spam the log. Return null and handle it below.
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
