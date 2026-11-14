/**
 * routes/lookups/reference-usage.ts — "how many coins use this?"
 *
 *   GET /reference-usage -> one key -> count index per reference type
 *
 * WHY THIS EXISTS
 * A visible in-use count beside every entry on the maintenance screen, so
 * the consequence of deleting one is known before the dialog appears.
 * Without it, Remove on a denomination nine coins are using looks identical
 * to Remove on one nobody has ever picked.
 *
 * WHY THE SERVER COUNTS, WHEN THE BROWSER ALREADY HOLDS EVERY COIN
 * Counting client-side is possible and still wrong, for one reason:
 *
 *     *** THE NUMBER SHOWN MUST BE THE NUMBER THE DELETE TOUCHES. ***
 *
 * `DELETE /api/denominations/:id` runs `UPDATE Coins SET DenominationId =
 * NULL WHERE DenominationId = @id`. A count derived from the snapshot the
 * browser loaded at startup can disagree with that statement — a coin
 * edited in another tab, an import that has run since, a failed write that
 * left the in-memory copy ahead of the row. Counting in the same place the
 * UPDATE runs makes that disagreement impossible rather than unlikely, and
 * being trusted about the number is this screen's whole job.
 *
 * Having settled that for denominations, the other five follow it rather
 * than splitting one screen across two sources with different staleness.
 *
 * WHY SIX QUERIES AND NOT ONE BATCH
 * A single batch returning six recordsets is one round trip instead of
 * six, and `recordsets[3]` is a positional dependency that no longer type-
 * checks and no longer reads. This endpoint is hit once, when the user opens
 * a dialog they open rarely, against a local database. Legibility wins;
 * if that ever stops being true the batch is a contained change.
 *
 * WHY TWO OF THESE ARE KEYED BY ID AND FOUR BY TEXT
 * Because that is how a coin references them, and the count must be keyed
 * the way the screen will look it up:
 *
 *     Coins.DenominationId  INT   -> keyed by id
 *     Coins.CatalogId       INT   -> keyed by id
 *     Coins.Category        text  -> keyed by text
 *     Coins.CoinSet         text  -> keyed by text
 *     Coins.MintMark        text  -> keyed by text   (NOT by MintMarkId —
 *                                    the coin stores the LABEL)
 *     Coins.MetalContent    text  -> keyed by text   (NOT by MetalContentId;
 *                                    there is no such column on Coins)
 *
 * Keying either group the other way produces an index that matches nothing
 * and therefore reports zero everywhere, which on this screen reads as "it
 * is safe to delete all of these".
 */

import { Router, Request, Response } from 'express';
import { logInfo } from '../../logger';
import { withDb } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';

const router = Router();

/**
 * A text-keyed count.
 *
 * The blank filter is not decoration: `Coins.Category` is nullable and years
 * of QIF and spreadsheet imports have left '' and '   ' in these columns. An
 * empty bucket would show on the screen as a nameless row with a number
 * beside it, matching no entry in any list.
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

/**
 * Collapse a recordset into a plain object.
 *
 * Keys are stringified here and read back as strings on the client (see
 * category-modal/reference-usage.ts). THE BUG THIS PREVENTS: a count stored
 * under the number 103 and looked up with the string '103' reads as 0, and
 * the screen then offers to delete a denomination three coins are using
 * while promising that none are.
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
      // Sequential and in this fixed order, because the specs drive the mock
      // one `mockResolvedValueOnce` at a time. Six small GROUP BYs over a
      // table of a few hundred rows; the order costs nothing real.
      const categories = await db.request().query(textUsageQuery('Category'));
      const coinSets = await db.request().query(textUsageQuery('CoinSet'));
      const denominations = await db.request().query(idUsageQuery('DenominationId'));
      const mintMarks = await db.request().query(textUsageQuery('MintMark'));
      const catalogs = await db.request().query(idUsageQuery('CatalogId'));
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
