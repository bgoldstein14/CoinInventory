/**
 * routes/lookups/metal-contents.ts — the MetalContents reference table.
 *
 * This is the canonical list of metal-content descriptions ("90% Silver",
 * "Copper-Nickel", ...) that the coin edit form offers in its dropdown. It is
 * read-only over HTTP: the list is seeded by setup-database.sql, so there is
 * no POST/PUT/DELETE here.
 *
 * Mounted (via routes/lookups/index.ts) at /api:
 *
 *   GET /metalcontents  -> the names, in the curated SortOrder
 *
 * It used to sit inside the Categories section of the old lookups.ts purely
 * because that is where it was first added; it is its own table and now has
 * its own file.
 */

import { Router, Request, Response } from 'express';
import { logInfo } from '../../logger';
import { withDb } from '../../db';
import { sendDbError } from '../db-error-response';

const router = Router();

router.get('/metalcontents', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching metal contents');

    const names = await withDb(async (db) => {
      const result = await db.request()
        .query('SELECT MetalContentName FROM MetalContents ORDER BY SortOrder, MetalContentName');
      return result.recordset.map((r: Record<string, unknown>) => r['MetalContentName'] as string);
    });

    res.json(names);
  } catch (err) {
    sendDbError(res, 'GET /api/metalcontents', err, 'Failed to retrieve metal contents');
  }
});

export default router;
