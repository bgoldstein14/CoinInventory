/**
 * Express server entry point — sets up middleware and mounts route modules.
 *
 * Route modules:
 *   routes/coins.ts   — Coin CRUD + image management (mounted at /api/coins)
 *   routes/lookups.ts  — Categories, Coin Sets, Denominations, Mint Marks (mounted at /api)
 *   routes/data.ts     — Transactions, Spot Prices, Settings, Frontend Log (mounted at /api)
 *
 * Database helpers live in db.ts (getPool, rowToCoin, formatDate).
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { logInfo } from './logger';

import coinsRouter from './routes/coins';
import lookupsRouter from './routes/lookups';
import dataRouter from './routes/data';

// Re-export getPool so tests and other consumers can still import from './server'
export { getPool } from './db';

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
app.use('/api/coins', coinsRouter);
app.use('/api', lookupsRouter);
app.use('/api', dataRouter);

// ============================================================
// Angular SPA fallback — must be LAST route
// ============================================================
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(angularDistPath, 'index.html'));
});

// ============================================================
// Global error handler
// ============================================================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const { logError } = require('./logger');
  logError('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

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
