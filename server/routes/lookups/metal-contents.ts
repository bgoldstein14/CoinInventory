/**
 * The MetalContents reference table: the metal-content options ("90% Silver",
 * "Copper-Nickel", ...) for the coin form. Read-only; the list is seeded.
 *
 *   GET /metalcontents  names, in curated SortOrder
 */

import { Router, Request, Response } from 'express';
import { logInfo } from '../../logger';
import { withDb } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';

const router = Router();

router.get('/metalcontents', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching metal contents');

    const names = await withDb(async (db) => {
      const result = await db.request()
        .query('SELECT MetalContentName FROM MetalContents ORDER BY SortOrder, MetalContentName');
      return result.recordset.map((r: Record<string, unknown>) => r['MetalContentName'] as string);
    });

    sendJson(res, 'GET /api/metalcontents', names, 'metal content list');
  } catch (err) {
    sendDbError(res, 'GET /api/metalcontents', err, 'Failed to retrieve metal contents', 'metal content list');
  }
});

export default router;
