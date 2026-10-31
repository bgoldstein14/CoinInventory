/**
 * Database layer — public entry point.
 *
 * Everything outside this folder imports from `'./db'` / `'../db'` / `'../../db'`
 * and gets what it needs from here. The folder is split up so each piece is
 * small enough to read in one sitting:
 *
 *   db/config.ts             builds the sql.config from server/.env
 *   db/pool.ts               the connection pool: getPool / resetPool / withDb
 *   db/errors.ts             isConnectionError / sqlErrorNumber
 *   db/coin-fields.ts        the Coins table column map (COIN_FIELDS)
 *   db/bindings.ts           parameter types for all the other tables
 *   db/value-normalizers.ts  JSON value -> SQL parameter value helpers
 *   db/row-mappers.ts        SQL row -> JSON for the Angular app
 *
 * ------------------------------------------------------------------
 * WHY THIS LAYER LOOKS THE WAY IT DOES (read this before changing it)
 * ------------------------------------------------------------------
 * The original version of this code created the pool with the *global*
 * `sql.connect(config)` helper and never attached an `'error'` listener to the
 * resulting pool. That was a process-killing bug:
 *
 *   1. `mssql`'s ConnectionPool is a Node `EventEmitter`.
 *   2. When SQL Server drops or errors an idle pooled connection, mssql calls
 *      `pool.emit('error', err)`.
 *   3. A Node EventEmitter with **zero** `'error'` listeners *throws* when you
 *      emit `'error'` on it. That throw happens on an internal socket callback,
 *      so nothing catches it — it becomes an uncaught exception and the whole
 *      Express process dies.
 *
 * The visible symptom was: the user pauses for a while, edits a coin, gets a
 * "Failed to update coin" toast, and refreshing the browser does not help
 * because the *server* is gone. Nothing appeared in app.log because the process
 * died before any logging ran.
 *
 * The fix is the `pool.on('error', ...)` listener registered in
 * `createPooledConnection()` in db/pool.ts. Everything else in this layer
 * exists to make recovery from a dropped connection cheap and safe:
 *
 *   - single-flight connect  -> concurrent requests share one connect attempt
 *   - generation counter     -> a late failure can't tear down a fresh pool
 *   - no per-request SELECT 1 -> halves round trips and removes a race where
 *                                the health check closed a pool other requests
 *                                were still using
 *   - withDb() retry         -> one automatic retry, but ONLY for
 *                                connection-class errors
 */

// ----- Configuration --------------------------------------------------
export { buildDbConfig } from './config';

// ----- Connection error classification --------------------------------
export { isConnectionError, sqlErrorNumber } from './errors';

// ----- Connection pool (single-flight, generation-guarded singleton) ---
export { getPool, resetPool, withDb } from './pool';

// ----- Column bindings — the SINGLE source of truth for parameter types
export type { CoinColumnBinding } from './coin-fields';
export { COIN_FIELDS, normalizeCoinValue } from './coin-fields';
export { DB_BINDINGS } from './bindings';
export { normalizeTextDate, normalizeNullable } from './value-normalizers';

// ----- Helpers shared across route modules ----------------------------
export { rowToCoin, formatDate } from './row-mappers';
