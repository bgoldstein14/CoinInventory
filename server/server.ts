/**
 * Express server entry point — sets up middleware and mounts route modules.
 *
 * This file is deliberately kept short: its job is wiring, not logic. Anything
 * that does real work lives in one of the folders below.
 *
 * Route modules:
 *   routes/health.ts   — GET /api/health, the launcher's readiness probe
 *   routes/app-info.ts — GET /api/app-info, where the app itself is installed
 *   routes/coins/      — Coin CRUD + image management (mounted at /api/coins)
 *   routes/lookups/    — Categories, Metal Contents, Coin Sets, Denominations,
 *                        Mint Marks (mounted at /api)
 *   routes/data/       — Transactions, Spot Prices, Settings, Frontend Log
 *                        (mounted at /api)
 *   routes/images/     — Serving / existence-checking the ORIGINAL image files
 *                        on the host's disk (mounted at /api/images)
 *   routes/error-handler.ts — the app-wide Express error handler
 *
 * Database helpers live in the db/ folder (getPool, withDb, rowToCoin,
 * formatDate, COIN_FIELDS, DB_BINDINGS...). Start with db/index.ts — its
 * header explains the production crash that shaped the whole database layer.
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { logInfo } from './logger';
import { installProcessSafetyNet } from './process-safety';

import healthRouter from './routes/health';
import appInfoRouter from './routes/app-info';
import coinsRouter from './routes/coins';
import lookupsRouter from './routes/lookups';
import dataRouter from './routes/data';
import imagesRouter from './routes/images';
import { globalErrorHandler } from './routes/error-handler';

// Re-export getPool so tests and other consumers can still import from './server'
export { getPool } from './db';

// ============================================================
// Process-level safety net
// ============================================================
//
// Installs the 'unhandledRejection' / 'uncaughtException' handlers that make
// a fatal error show up in app.log instead of silently ending the process.
// See process-safety.ts for the full story. Done here at module load so the
// handlers are active for the whole lifetime of the process (including during
// tests).
installProcessSafetyNet();

// ============================================================
// Express app
// ============================================================

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const angularDistPath = path.resolve(__dirname, '..', 'dist', 'coin-inventory-app');
app.use(express.static(angularDistPath));

// Request logging middleware — logs every API request
app.use('/api', (req, _res, next) => {
  logInfo(`${req.method} ${req.path}`);
  next();
});

// ============================================================
// Mount route modules
// ============================================================
// Health first, so the launcher's readiness probe is registered before
// anything else — same order as when it was declared inline here.
app.use('/api', healthRouter);
// /api/app-info tells the browser where the app is installed on THIS machine.
// Like /api/images below it never touches the database — it answers a question
// about the filesystem — so it keeps working when SQL Server does not. See
// routes/app-info.ts for why the image-import screen needs it.
app.use('/api', appInfoRouter);
app.use('/api/coins', coinsRouter);
app.use('/api', lookupsRouter);
app.use('/api', dataRouter);
// /api/images serves the ORIGINAL full-resolution files off the host's disk.
// It is the only router that never touches the database — see
// routes/images/index.ts, and routes/images/file.ts for why the browser cannot
// just open a file:// link itself.
app.use('/api/images', imagesRouter);

// ============================================================
// Angular SPA fallback — must be LAST route
// ============================================================
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(angularDistPath, 'index.html'));
});

// ============================================================
// Global error handler
// ============================================================
// Lives in routes/error-handler.ts. It honours the `status` a middleware error
// already carries instead of flattening everything to 500 — most importantly
// body-parser's 413 "payload too large", which used to be reported as a generic
// server error during batch image imports.
app.use(globalErrorHandler);

// ============================================================
// Export for testing
// ============================================================
export { app };

// ============================================================
// Start (only when run directly)
// ============================================================
const isMainModule = require.main === module || process.argv[1]?.endsWith('server.ts');
if (isMainModule) {
  app.listen(PORT, () => {
    logInfo(`Coin Inventory server listening on http://localhost:${PORT}`);
    logInfo(`Database: ${process.env['DB_SERVER'] ?? 'BRUCE_PC\\SQLEXPRESS'} / ${process.env['DB_NAME'] ?? 'CoinInventory'}`);
  });
}
