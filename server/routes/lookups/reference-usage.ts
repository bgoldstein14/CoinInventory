/**
 * GET /reference-usage: how many coins use each lookup entry, shown on the
 * maintenance screen before a delete.
 *
 * Counted on the server so the number matches what the delete will actually
 * touch, rather than the browser's possibly stale copy. Six simple queries
 * rather than one multi-recordset batch, for readability.
 *
 * Keys match how coins reference each lookup:
 *
 *     Coins.DenominationId  INT   -> keyed by id
 *     CoinCatalogRefs.CatalogId INT -> keyed by id, counting distinct coins
 *     Coins.Category        text  -> keyed by text
 *     Coins.CoinSet         text  -> keyed by text
 *     Coins.MintMark        text  -> keyed by text (the coin stores the label)
 *     Coins.MetalContent    text  -> keyed by text
 *
 * The wrong key type would report zero everywhere, which reads as "safe to delete".
 */

import { Router, Request, Response } from 'express';
import { logInfo } from '../../logger';
import { withDb } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';

const router = Router();

/**
 * A text-keyed count. Blank values (common after imports) are excluded so
 * they don't show as a nameless row.
 */
function textUsageQuery(column: string): string {
  return (
    `SELECT ${column} AS K, COUNT(*) AS C FROM Coins ` +
    `WHERE ${column} IS NOT NULL AND LTRIM(RTRIM(${column})) <> '' ` +
    `GROUP BY ${column}`
  );
}

/** An id-keyed count. NULL is the normal unresolved state, so it is excluded. */
function idUsageQuery(column: string): string {
  return `SELECT ${column} AS K, COUNT(*) AS C FROM Coins WHERE ${column} IS NOT NULL GROUP BY ${column}`;
}

/** Coins per catalogue; a coin with two references to one catalogue counts once. */
const CATALOG_USAGE_QUERY =
  'SELECT CatalogId AS K, COUNT(DISTINCT CoinId) AS C FROM CoinCatalogRefs ' +
  'WHERE CatalogId IS NOT NULL GROUP BY CatalogId';

/**
 * Collapses a recordset into a plain object with string keys (the client looks
 * them up as strings; a numeric key would read as 0).
 */
function toIndex(recordset: readonly Record<string, unknown>[]): Record<string, number> {
  const index: Record<string, number> = {};
  for (const row of recordset) {
    const key = row['K'];
    if (key === null || key === undefined) continue;
    const name = String(key);
    if (name.length === 0) continue;
    const count = Number(row['C']);
    index[name] = Number.isFinite(count) ? count : 0;
  }
  return index;
}

router.get('/reference-usage', async (_req: Request, res: Response) => {
  try {
    logInfo('Counting reference-data usage');

    const usage = await withDb(async (db) => {
      // Sequential, in a fixed order.
      const categories = await db.request().query(textUsageQuery('Category'));
      const coinSets = await db.request().query(textUsageQuery('CoinSet'));
      const denominations = await db.request().query(idUsageQuery('DenominationId'));
      const mintMarks = await db.request().query(textUsageQuery('MintMark'));
      const catalogs = await db.request().query(CATALOG_USAGE_QUERY);
      const metalContents = await db.request().query(textUsageQuery('MetalContent'));

      return {
        categories: toIndex(categories.recordset),
        coinSets: toIndex(coinSets.recordset),
        denominations: toIndex(denominations.recordset),
        mintMarks: toIndex(mintMarks.recordset),
        catalogs: toIndex(catalogs.recordset),
        metalContents: toIndex(metalContents.recordset),
      };
    });

    sendJson(res, 'GET /api/reference-usage', usage, 'reference data usage');
  } catch (err) {
    sendDbError(res, 'GET /api/reference-usage', err, 'Failed to count reference-data usage', 'reference data usage');
  }
});

export default router;
