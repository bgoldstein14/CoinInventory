/**
 * Database layer: public entry point. Code outside db/ imports from here.
 *
 *   db/driver.ts             the only file that imports a SQLite package
 *   db/config.ts             where the database file lives
 *   db/schema.sql            the tables, as SQLite DDL
 *   db/schema.ts             applies schema.sql; enables WAL; schema version
 *   db/seed.ts               idempotent reference data
 *   db/pool.ts               connection lifecycle: getPool / resetPool / withDb
 *   db/sql-api.ts            the .input(...).query(...) API over SQLite
 *   db/column-types.ts       parameter type vocabulary (NVarChar, Decimal, ...)
 *   db/bind-values.ts        JSON value -> bound value, with validation
 *   db/errors.ts             isConnectionError / sqlErrorNumber
 *   db/coin-fields.ts        the Coins column map (COIN_FIELDS)
 *   db/bindings.ts           parameter types for the other tables
 *   db/value-normalizers.ts  JSON value -> SQL parameter value helpers
 *   db/row-mappers.ts        SQL row -> JSON for the Angular app
 *
 * Route handlers use withDb() and must not call resetPool().
 */

// ----- Configuration --------------------------------------------------
export {
  buildDbConfig,
  resolveDataDirectory,
  DB_PATH_ENV_VAR,
  DB_DIR_ENV_VAR,
  DATABASE_FILE_NAME,
  IN_MEMORY_DATABASE,
} from './config';
export type { DbConfig } from './config';

// ----- Connection error classification --------------------------------
export { isConnectionError, sqlErrorNumber } from './errors';

// ----- Connection lifecycle -------------------------------------------
// withDatabaseOffline (restore only) is intentionally not re-exported.
export { getPool, resetPool, withDb } from './pool';

// ----- Schema version -------------------------------------------------
export { SCHEMA_VERSION, UNSTAMPED_SCHEMA_VERSION, readSchemaVersion } from './schema';

// ----- Backup / restore file operations (paths and plain data only) ----
export {
  BACKUP_METADATA_PREFIX,
  copyDatabaseFile,
  distinctFolders,
  looksLikeSqliteFile,
  readDatabaseFileFacts,
  writeBackupMetadata,
} from './backup';
export type { DatabaseFileFacts } from './backup';

// ----- The request-shaped API the routes speak ------------------------
export { DbConnection, DbRequest, DbTransaction, DbQueryError } from './sql-api';
export type { DbResult } from './sql-api';

// ----- Column bindings ------------------------------------------------
export type { CoinColumnBinding } from './coin-fields';
export { COIN_FIELDS, normalizeCoinValue, normalizeForeignKeyId } from './coin-fields';
export { DB_BINDINGS } from './bindings';
export type { DbType } from './column-types';
export { normalizeTextDate, normalizeNullable } from './value-normalizers';

// ----- Helpers shared across route modules ----------------------------
export { rowToCoin, formatDate } from './row-mappers';
