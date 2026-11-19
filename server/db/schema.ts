/**
 * Brings a database up to the shape the application needs. Run on every open
 * by db/pool.ts:
 *
 *   applySchema()        executes db/schema.sql (all CREATE ... IF NOT EXISTS,
 *                        so a no-op on an existing database)
 *   stampSchemaVersion() records SCHEMA_VERSION in PRAGMA user_version
 *
 * This is not a migration runner. Numbered upgrade steps (keyed on
 * user_version) can be added when a schema change has to reach existing users.
 */

import fs from 'fs';
import path from 'path';

import type { SqliteDatabase } from './driver';

/**
 * The schema version this build creates and understands. Stamped into every
 * database it opens; restore refuses a file with a higher number.
 *
 * Bump it only when db/schema.sql changes in a way an older build couldn't
 * read, since bumping makes every earlier build refuse the file. Version 0
 * means a file made before stamping existed; those have the same tables and
 * restore accepts them based on the table check (see backup/inspect.ts).
 */
export const SCHEMA_VERSION = 2;

/** PRAGMA user_version's default, meaning "never stamped". */
export const UNSTAMPED_SCHEMA_VERSION = 0;

/** The DDL. Read from disk rather than embedded so it stays reviewable SQL. */
export const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** The schema text. Read once; it cannot change while the process is alive. */
let cachedSchemaSql: string | null = null;

export function readSchemaSql(): string {
  if (cachedSchemaSql === null) {
    cachedSchemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  }
  return cachedSchemaSql;
}

/**
 * Creates every missing table and index. Uses exec() because this is a
 * multi-statement script; prepare() would run only the first statement.
 */
export function applySchema(database: SqliteDatabase): void {
  database.exec(readSchemaSql());
}

/**
 * Brings an older file's data into the current tables. Run after applySchema()
 * and before stampSchemaVersion(), with the version the file carried.
 *
 *   version < 2: copy each coin's single reference (Coins.CatalogId /
 *   CatalogNumber) into CoinCatalogRefs. The old columns are left in place,
 *   unused; references without a number are dropped, as on any save.
 *
 * Returns the number of rows copied (0 when there was nothing to do).
 */
export function upgradeSchema(database: SqliteDatabase, fromVersion: number): number {
  if (fromVersion >= 2) return 0;

  const coinColumns = database.prepare("SELECT name FROM pragma_table_info('Coins')").all()
    .map(row => row['name']);
  if (!coinColumns.includes('CatalogNumber')) return 0;

  const result = database.prepare(`
    INSERT INTO CoinCatalogRefs (CoinId, CatalogId, CatalogNumber, SortOrder)
    SELECT c.CoinId, c.CatalogId, TRIM(c.CatalogNumber), 0
    FROM Coins c
    WHERE TRIM(COALESCE(c.CatalogNumber, '')) <> ''
      AND NOT EXISTS (SELECT 1 FROM CoinCatalogRefs r WHERE r.CoinId = c.CoinId)
  `).run();
  return Number(result.changes ?? 0);
}

/**
 * What PRAGMA user_version says (0 if never stamped). Uses prepare/all
 * because exec() returns no rows.
 */
export function readSchemaVersion(database: SqliteDatabase): number {
  const rows = database.prepare('PRAGMA user_version').all();
  const value = rows[0]?.['user_version'];
  return typeof value === 'number' ? value : Number(value ?? UNSTAMPED_SCHEMA_VERSION);
}

/** What stampSchemaVersion() did, so the caller can log it meaningfully. */
export interface SchemaVersionStamp {
  /** What the file said before we touched it. */
  readonly before: number;
  /** What it says now. Equal to `before` unless we wrote. */
  readonly after: number;
  /** True when this call wrote the pragma. */
  readonly stamped: boolean;
  /** True when the file claims a version this build does not know about. */
  readonly newerThanThisBuild: boolean;
}

/**
 * Writes SCHEMA_VERSION into the file if that is an upgrade:
 *
 *   before <  SCHEMA_VERSION   stamp it (new or pre-stamping database)
 *   before == SCHEMA_VERSION   nothing to do
 *   before >  SCHEMA_VERSION   leave it alone and report it; stamping down
 *                              would hide that the file is from a newer build
 *
 * The pragma can't take a bound parameter, so the constant is interpolated;
 * the assertion below keeps it a safe integer.
 */
export function stampSchemaVersion(database: SqliteDatabase): SchemaVersionStamp {
  if (!Number.isSafeInteger(SCHEMA_VERSION) || SCHEMA_VERSION < 1) {
    throw new Error(`SCHEMA_VERSION must be a positive integer; got ${String(SCHEMA_VERSION)}`);
  }

  const before = readSchemaVersion(database);

  if (before > SCHEMA_VERSION) {
    return { before, after: before, stamped: false, newerThanThisBuild: true };
  }

  if (before === SCHEMA_VERSION) {
    return { before, after: before, stamped: false, newerThanThisBuild: false };
  }

  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return {
    before,
    after: readSchemaVersion(database),
    stamped: true,
    newerThanThisBuild: false,
  };
}

/**
 * Enables write-ahead logging on a file database. WAL lets readers and a
 * writer run concurrently and protects the main file from torn pages on a
 * crash. It persists in the file, so setting it on every open is harmless.
 * In-memory databases answer 'memory', which is fine.
 *
 * Because recent transactions live in the -wal file, backups must use the
 * online backup API, not a file copy (see db/driver.ts).
 */
export function enableWriteAheadLog(database: SqliteDatabase): void {
  database.exec('PRAGMA journal_mode = WAL');
}
