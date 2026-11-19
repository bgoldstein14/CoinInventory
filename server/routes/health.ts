/**
 * GET /api/health: the launcher (start-coin-inventory.ps1 in the project root)
 * polls this to know the API and database are ready before opening the
 * browser. It checks the body, so the response shape must not change.
 *
 * 200 => { status: 'ok',    database: 'connected' }
 * 503 => { status: 'error', database: 'disconnected', message: '...' }
 */

import { Router, Request, Response } from 'express';
import { logError } from '../logger';
import { withDb } from '../db';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    await withDb(async (db) => db.request().query('SELECT 1'));
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError('Health check failed — database is not reachable', err);
    res.status(503).json({ status: 'error', database: 'disconnected', message });
  }
});

export default router;
