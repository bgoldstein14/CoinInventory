/**
 * Express server entry point: middleware and route mounting only.
 *
 * Route modules:
 *   routes/health.ts        GET /api/health, the launcher's readiness probe
 *   routes/app-info.ts      GET /api/app-info, where the app is installed
 *   routes/coins/           coin CRUD and images (/api/coins)
 *   routes/lookups/         categories, metal contents, coin sets,
 *                           denominations, mint marks, issuers, catalogs (/api)
 *   routes/data/            spot prices, settings, frontend log (/api)
 *   routes/images/          original image files on the host's disk (/api/images)
 *   routes/support/         problem reports (/api/support)
 *   routes/backup/          backup and restore (/api)
 *   routes/error-handler.ts the app-wide error handler
 *
 * The database layer is in db/; start with db/index.ts.
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { logInfo } from './logger';
import { buildDbConfig } from './db';
import { installProcessSafetyNet } from './process-safety';

import healthRouter from './routes/health';
import appInfoRouter from './routes/app-info';
import coinsRouter from './routes/coins';
import lookupsRouter from './routes/lookups';
import dataRouter from './routes/data';
import imagesRouter from './routes/images';
import supportRouter from './routes/support';
import backupRouter from './routes/backup';
import { globalErrorHandler } from './routes/error-handler';

// Re-exported so tests and other consumers can import it from './server'.
export { getPool } from './db';

// Logs unhandled rejections and uncaught exceptions to app.log (see process-safety.ts).
installProcessSafetyNet();

// Express app

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// The Angular application builder writes the bundle to `<outputPath>/browser/`.
// If this points one level too high the server still starts but serves an
// empty page. dist-path.spec.ts checks it against angular.json.
export const angularDistPath = path.resolve(
  __dirname,
  '..',
  'dist',
  'coin-inventory-app',
  'browser',
);
app.use(express.static(angularDistPath));

app.use('/api', (req, _res, next) => {
  logInfo(`${req.method} ${req.path}`);
  next();
});

// Health first, so the readiness probe is registered before anything else.
app.use('/api', healthRouter);
// app-info, images and support don't touch the database (support reads only
// counts), so they keep working when it's unavailable.
app.use('/api', appInfoRouter);
app.use('/api/coins', coinsRouter);
app.use('/api', lookupsRouter);
app.use('/api', dataRouter);
app.use('/api/images', imagesRouter);
app.use('/api', supportRouter);
// Backup/restore last: restore closes the shared database handle and replaces
// the file (see routes/backup/index.ts and withDatabaseOffline()).
app.use('/api', backupRouter);

// Angular SPA fallback; must be the last route. Express 5 requires a named
// wildcard (`/*splat`); a bare `*` throws at startup.
app.get('/*splat', (_req: Request, res: Response) => {
  res.sendFile(path.join(angularDistPath, 'index.html'));
});

// Honours an error's existing `status` (e.g. body-parser's 413) instead of always 500.
app.use(globalErrorHandler);

export { app };

// Start (only when run directly)
const isMainModule = require.main === module || process.argv[1]?.endsWith('server.ts');
if (isMainModule) {
  app.listen(PORT, () => {
    logInfo(`Coin Inventory server listening on http://localhost:${PORT}`);
    // Logged so it's easy to find the collection file (under %LOCALAPPDATA%).
    logInfo(`Database file: ${buildDbConfig().file}`);
  });
}
