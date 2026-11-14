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
 *   routes/data/       — Spot Prices, Settings, Frontend Log
 *                        (mounted at /api)
 *   routes/images/     — Serving / existence-checking the ORIGINAL image files
 *                        on the host's disk (mounted at /api/images)
 *   routes/backup/     — §16: back the collection up to a file the user
 *                        chooses, and restore from one (mounted at /api)
 *   routes/error-handler.ts — the app-wide Express error handler
 *
 * Database helpers live in the db/ folder (getPool, withDb, rowToCoin,
 * formatDate, COIN_FIELDS, DB_BINDINGS...). Start with db/index.ts — its
 * header explains why the layer is shaped the way it is, and db/driver.ts
 * explains why exactly one file is allowed to name the SQLite package.
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

// Installs the 'unhandledRejection' / 'uncaughtException' handlers that make
// a fatal error show up in app.log instead of silently ending the process.
// At module load, so they are active for the whole lifetime of the process
// (including during tests). See process-safety.ts.
installProcessSafetyNet();

// Express app

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Where the built Angular app lives. The trailing 'browser' is not optional:
// the application builder (@angular/build:application, angular.json ->
// architect.build) writes the browser bundle to
// `<outputPath>/browser/`, not to `<outputPath>/` as the old webpack
// `browser` builder did. Point this one directory too high and nothing
// breaks loudly — the build still succeeds, express.static serves nothing,
// and the SPA fallback sends an index.html that is not there, so the user
// gets an empty page from a server that reports itself healthy. The path is
// exported, and dist-path.spec.ts asserts the real build lands on it.
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

// Health first, so the launcher's readiness probe is registered before
// anything else.
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
// /api/support/* — "Help > Report a problem". Like /api/app-info it must keep
// working when the database does not, because "the database is not working"
// is one of the likeliest reasons somebody is filing a report. It reads the
// collection as COUNTS ONLY and writes nothing until the user has seen and
// approved the text. See routes/support/index.ts.
app.use('/api', supportRouter);
// /api/backup/* and /api/restore/* — §16, "make the collection portable".
// Mounted LAST of the API routers and deliberately so: /api/restore closes
// the shared database handle and renames the file underneath it, which is
// the one thing no other router is allowed to do, and keeping it visibly
// apart from the CRUD routers above is part of how that stays true. See
// routes/backup/index.ts, and db/pool.ts's withDatabaseOffline().
app.use('/api', backupRouter);

// Angular SPA fallback — must be LAST route.
//
// `'/*splat'`, not `'*'`. Express 5 replaced path-to-regexp, and a bare `*`
// is no longer a valid pattern — it throws at startup with
// "Missing parameter name at index 1", which takes the whole server down
// rather than failing one route. A wildcard must now be NAMED; `splat` is
// the conventional name and the segment it captures is unused here.
app.get('/*splat', (_req: Request, res: Response) => {
  res.sendFile(path.join(angularDistPath, 'index.html'));
});

// Honours the `status` a middleware error already carries instead of
// flattening everything to 500 — most importantly body-parser's 413 "payload
// too large", which a batch image import can hit. See routes/error-handler.ts.
app.use(globalErrorHandler);

export { app };

// Start (only when run directly)
const isMainModule = require.main === module || process.argv[1]?.endsWith('server.ts');
if (isMainModule) {
  app.listen(PORT, () => {
    logInfo(`Coin Inventory server listening on http://localhost:${PORT}`);
    // The SQLite file, not a server and a database name. It lives under
    // %LOCALAPPDATA% rather than the install directory (design §4.10a), so
    // logging the resolved path is the quickest answer both to "where is my
    // collection?" and to "why is this one empty?".
    logInfo(`Database file: ${buildDbConfig().file}`);
  });
}
