/**
 * Database layer — public entry point.
 *
 * Everything outside this folder imports from `'./db'` / `'../db'` / `'../../db'`
 * and gets what it needs from here. The folder is split up so each piece is
 * small enough to read in one sitting:
 *
 *   db/driver.ts             THE ONLY FILE THAT NAMES A SQLITE PACKAGE
 *   db/config.ts             where the database file lives (§4.10a)
 *   db/schema.sql            the 12 tables, post-migration, as SQLite DDL
 *   db/schema.ts             applies schema.sql; enables WAL
 *   db/seed.ts               idempotent reference data (§4.10b)
 *   db/pool.ts               the connection lifecycle: getPool / resetPool / withDb
 *   db/sql-api.ts            the .input(...).query(...) adapter over SQLite
 *   db/column-types.ts       the parameter type vocabulary (NVarChar, Decimal, ...)
 *   db/bind-values.ts        JSON value -> bound value, with the validation
 *   db/errors.ts             isConnectionError / sqlErrorNumber
 *   db/coin-fields.ts        the Coins table column map (COIN_FIELDS)
 *   db/bindings.ts           parameter types for all the other tables
 *   db/value-normalizers.ts  JSON value -> SQL parameter value helpers
 *   db/row-mappers.ts        SQL row -> JSON for the Angular app
 *
 *
 * WHY THIS LAYER LOOKS THE WAY IT DOES (read this before changing it)
 *
 * ===== 1. The engine is SQLite, and the driver is behind ONE file =====
 *
 * Design §4.1: SQL Server is deleted, not kept alongside. The driver is
 * `node:sqlite`, which is core in Node 22+ and therefore needs no native
 * module and no build toolchain — see db/driver.ts for why that matters and
 * for the Electron caveat that is the reason the import is isolated to that
 * one file. A spec fails the build if any other file imports it.
 *
 * ===== 2. The REQUEST-SHAPED API IS DELIBERATELY UNCHANGED =====
 *
 * Routes still write:
 *
 *   const rows = await withDb(async (db) => {
 *     const result = await db.request()
 *       .input('id', DB_BINDINGS.coinId, id)
 *       .query('SELECT * FROM Coins WHERE CoinId = @id');
 *     return result.recordset;
 *   });
 *
 * That is 82 bindings across 15 modules, every one of them annotated with
 * why it binds what it binds. db/sql-api.ts implements the same shape over
 * SQLite so a route changes ONLY where the SQL dialect genuinely differs.
 *
 * ===== 3. The type table survived, and it is load-bearing now =====
 *
 * SQLite is dynamically typed and enforces neither a column width nor a
 * decimal scale. COIN_FIELDS and DB_BINDINGS are therefore no longer a
 * DESCRIPTION of what the database will enforce — they are the only thing
 * that enforces it, through db/bind-values.ts. See db/column-types.ts.
 *
 * ===== 4. What the pool code is still here for =====
 *
 * The original crash this layer was built around was `mssql`-specific: a
 * ConnectionPool is an EventEmitter, an EventEmitter with no 'error' listener
 * THROWS when 'error' is emitted, and that throw happened on a socket
 * callback where nothing could catch it — so a dropped idle connection killed
 * the Express process, silently, with nothing in app.log. There is no socket,
 * no EventEmitter and no pool now, so that mechanism is gone and the guard
 * against it has been REMOVED rather than re-created in a fake form.
 *
 * What was kept, because the reasons survive the engine change:
 *
 *   - single-flight open      -> concurrent requests share one open attempt,
 *                                so the schema and the seed run once
 *   - generation counter      -> a late failure can't close a fresh handle
 *   - no per-request health check
 *   - withDb() retry          -> one automatic retry, but ONLY for
 *                                connection-class errors. Retrying a
 *                                constraint violation would run the
 *                                caller's writes twice.
 *
 * NO ROUTE HANDLER MAY CALL resetPool(). Route code tearing down the shared
 * connection on ordinary errors was a primary cause of the original crash and
 * is just as wrong now.
 */

// ----- Configuration --------------------------------------------------
export { buildDbConfig, resolveDataDirectory, DB_PATH_ENV_VAR, DB_DIR_ENV_VAR } from './config';
export type { DbConfig } from './config';

// ----- Connection error classification --------------------------------
export { isConnectionError, sqlErrorNumber } from './errors';

// ----- Connection lifecycle (single-flight, generation-guarded) -------
export { getPool, resetPool, withDb } from './pool';

// ----- The request-shaped API the routes speak ------------------------
export { DbConnection, DbRequest, DbTransaction, DbQueryError } from './sql-api';
export type { DbResult } from './sql-api';

// ----- Column bindings — the SINGLE source of truth for parameter types
export type { CoinColumnBinding } from './coin-fields';
export { COIN_FIELDS, normalizeCoinValue } from './coin-fields';
export { DB_BINDINGS } from './bindings';
export type { DbType } from './column-types';
export { normalizeTextDate, normalizeNullable } from './value-normalizers';

// ----- Helpers shared across route modules ----------------------------
export { rowToCoin, formatDate } from './row-mappers';
