/**
 * The only file allowed to import a SQLite package (enforced by
 * db/driver-isolation.spec.ts).
 *
 * The driver is `node:sqlite`, built into Node 22+, so there is no native
 * module to compile. If a future host (e.g. Electron) lacks it, the fallback
 * is `better-sqlite3`, and only this file should need to change. The
 * structural interfaces below describe just the surface the app uses, so
 * consumers don't depend on the package's own types.
 */

import { DatabaseSync, backup } from 'node:sqlite';

/** Which package is behind these interfaces. Logged at startup. */
export const SQLITE_DRIVER_NAME = 'node:sqlite';

/**
 * A value the app hands to the driver as a bound parameter. Narrower than
 * what node:sqlite accepts: db/bind-values.ts converts every value first, so
 * a Date, boolean or undefined never reaches the driver.
 */
export type SqliteBindValue = null | number | bigint | string | Uint8Array;

/** A column description, used to tell "this statement returns rows" apart
 *  from "this statement does not". */
export interface SqliteColumnInfo {
  readonly name: string;
}

/** What a non-row-returning statement reports. */
export interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/**
 * One prepared statement. The data layer binds by name (`@coinId`); test
 * fixtures and the migration import bind positionally (`?`).
 */
export interface SqliteStatement {
  all(parameters?: Record<string, SqliteBindValue>): Record<string, unknown>[];
  all(...parameters: SqliteBindValue[]): Record<string, unknown>[];
  run(parameters?: Record<string, SqliteBindValue>): SqliteRunResult;
  run(...parameters: SqliteBindValue[]): SqliteRunResult;
  /** Empty for statements that produce no result set (INSERT without RETURNING,
   *  UPDATE, DELETE, DDL). Non-empty for SELECT and for RETURNING. */
  columns(): SqliteColumnInfo[];
}

/** One open database handle. */
export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  /** Runs one or more statements with no parameters. Used for the schema and
   *  for transaction control (BEGIN / COMMIT / ROLLBACK). */
  exec(sql: string): void;
  close(): void;
}

/** Everything `openSqliteDatabase()` needs to know. */
export interface SqliteOpenOptions {
  /**
   * `:memory:` for a private in-memory database (tests), otherwise an
   * absolute path to the file. The directory must already exist.
   */
  readonly filename: string;
  /**
   * Always true in production. SQLite leaves foreign keys off unless asked;
   * passed explicitly rather than relying on node:sqlite's default.
   */
  readonly enableForeignKeyConstraints: boolean;
  /** How long SQLite waits for a lock, in ms. The backup job can overlap the app. */
  readonly busyTimeoutMs: number;
  /**
   * Open without write access. Used for the backup source
   * (backup/run-backup.ts) and for inspecting a candidate restore file
   * (backup/inspect.ts), so neither can modify the file. Defaults to false.
   */
  readonly readOnly?: boolean;
}

/** How a backup is getting on. Handed to `onProgress` after each batch. */
export interface SqliteBackupProgress {
  /** Pages in the source database. Fixed for the life of one backup. */
  readonly totalPages: number;
  /** Pages still to copy. Counts DOWN to zero. */
  readonly remainingPages: number;
}

export interface SqliteBackupOptions {
  /**
   * Pages copied per batch. The event loop runs between batches, so this sets
   * progress granularity, cancellation granularity and how long the app waits
   * behind one batch. Kept small (see run-backup.ts).
   */
  readonly rate: number;
  /** Called after every batch. Throwing from it aborts the backup; this is how Cancel works. */
  readonly onProgress: (progress: SqliteBackupProgress) => void;
}

/**
 * Opens a database. `readBigInts` stays false so INTEGER columns arrive as
 * JS numbers; no id or value here approaches 2^53.
 */
export function openSqliteDatabase(options: SqliteOpenOptions): SqliteDatabase {
  const database = new DatabaseSync(options.filename, {
    open: true,
    readOnly: options.readOnly === true,
    enableForeignKeyConstraints: options.enableForeignKeyConstraints,
    timeout: options.busyTimeoutMs,
    readBigInts: false,
    returnArrays: false,
    // Extra bound parameters are normal (routes/coins/writes.ts binds every
    // COIN_FIELDS entry). Missing ones are caught in db/sql-api.ts.
    allowUnknownNamedParameters: true,
  });

  return database as unknown as SqliteDatabase;
}

/**
 * SQLite's online backup, used by the backup feature.
 *
 * A plain file copy of the .db is wrong: in WAL mode recent transactions live
 * in the -wal file, so the copy silently misses them. `VACUUM INTO` is correct
 * but is one blocking statement with no progress or cancel. backup() copies
 * `rate` pages at a time and yields to the event loop between batches.
 *
 * @returns the number of pages copied.
 */
export async function backupSqliteDatabase(
  source: SqliteDatabase,
  destinationPath: string,
  options: SqliteBackupOptions
): Promise<number> {
  // The structural interface is a view of DatabaseSync; backup() needs the real type.
  return backup(source as unknown as DatabaseSync, destinationPath, {
    rate: options.rate,
    progress: options.onProgress,
  });
}
