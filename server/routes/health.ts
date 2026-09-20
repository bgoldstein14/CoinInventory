/**
 * routes/health.ts — GET /api/health
 *
 * Used by setup/start-coin-inventory.ps1 to decide when the API is *truly*
 * ready. Serving HTTP is not enough: the launcher needs to know the database
 * is reachable too, otherwise it opens the browser to an app that immediately
 * errors out.
 *
 * 200 => { status: 'ok',    database: 'connected' }
 * 503 => { status: 'error', database: 'disconnected', message: '...' }
 *
 * Mounted at /api and registered BEFORE the other API routers, exactly as it
 * was when it lived inline in server.ts. The launcher polls this URL in a
 * loop, so the response shape must not change.
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
