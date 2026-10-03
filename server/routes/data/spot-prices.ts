/**
 * routes/data/spot-prices.ts — precious-metal spot prices.
 *
 * Two different things share this prefix, which is worth being clear about:
 *
 *   GET  /spot-prices/latest  reads the most recent row we SAVED in SQL Server
 *   GET  /spot-prices/fetch   calls out to COMEX/NYMEX futures for LIVE
 *                             prices — it touches no database at all
 *   POST /spot-prices         saves a set of prices as a new history row
 *
 * Mounted (via routes/data/index.ts) at /api, so those become
 * /api/spot-prices/latest and so on.
 *
 * The /fetch handler is the only outbound HTTP call in the whole backend; the
 * call itself lives in ./spot-price-source. It deliberately answers 200 with
 * zeroed prices and an `error` field when the upstream call fails, rather than
 * erroring the request — the frontend treats missing spot prices as "unknown",
 * and a dead third-party API should not make the app look broken.
 *
 * Database calls go through `withDb()`; parameter types come from DB_BINDINGS.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn, logError } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { fetchSpotPrices } from './spot-price-source';

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

/**
 * Fetches live prices from COMEX/NYMEX futures. Touches no database.
 *
 * The actual outbound call lives in ./spot-price-source so this route stays
 * about HTTP shape, and so the upstream can be swapped without touching
 * routing code. See that file for why metals.live was replaced.
 *
 * Still answers 200 on failure, with zeroed prices and an `error` field: the
 * frontend treats missing prices as "unknown", and a dead third-party API
 * should not make the app look broken. But it now also reports *which* metals
 * failed, so a zero is never silently presented as a real price -- that is
 * exactly how the dead metals.live endpoint went unnoticed.
 */
router.get('/spot-prices/fetch', async (_req: Request, res: Response) => {
  try {
    const { prices, source, failed } = await fetchSpotPrices();

    res.json({
      prices,
      source,
      timestamp: new Date().toISOString(),
      // Only present when something went wrong, so existing callers that just
      // check for `error` keep working unchanged.
      ...(failed.length
        ? { error: `No price available for: ${failed.join(', ')}`, failed }
        : {}),
    });
  } catch (err) {
    // fetchSpotPrices() is written not to throw, so reaching here means
    // something unexpected broke. Keep the same graceful-degradation shape.
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
 * Is every metal in this set zero (or missing)?
 *
 * A PRECIOUS METAL NEVER TRADES AT ZERO, so a zero is not a cheap price — it
 * is the absence of a price, and storing it is storing nothing while looking
 * like something. That matters more here than anywhere else in the app:
 * `GET /spot-prices/latest` reads the most recent row back, and the client
 * applies it at start-up. One all-zero row therefore poisons every melt value
 * on every subsequent launch until another save displaces it.
 *
 * Deliberately ALL and not ANY. Partial data is legitimate and common: the
 * four metals are fetched as independent symbols, so silver can succeed while
 * platinum fails, and a user may only care about gold. One real price among
 * three zeros is a good row — the zeros just mean "no price for that metal",
 * which is exactly how computeMeltValue reads them on the client.
 */
function isAllZero(prices: { gold?: unknown; silver?: unknown; platinum?: unknown; copper?: unknown }): boolean {
  // Non-numeric and missing values count as zero: they are no more a price
  // than 0 is, and Number(undefined) is NaN rather than 0, so this has to be
  // explicit rather than relying on arithmetic.
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

    // Refuse an all-zero set outright. The Angular client already guards
    // against this, but a client-side guard is advice, not a rule: anything
    // else that can reach this port (a retry, a script, a stale build) could
    // otherwise write a row that silently breaks melt values for good. The
    // invariant belongs at the boundary that does the writing.
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
