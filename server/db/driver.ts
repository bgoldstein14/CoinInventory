/**
 * db/driver.ts — THE ONLY FILE IN THIS REPOSITORY THAT MAY NAME A SQLITE
 * PACKAGE.
 *
 * *** READ THIS BEFORE ADDING AN IMPORT ANYWHERE ELSE. ***
 *
 * The driver is `node:sqlite`, which is core in Node 22+ and verified present
 * in the Node this project runs on (v24.19.0: `DatabaseSync`, `StatementSync`,
 * `Session`, `backup`). Being core is the whole reason it was chosen: there is
 * no native module, nothing for `electron-rebuild` to do, and `npm install`
 * needs no C++ toolchain — which matters on a machine where native builds are
 * blocked by group policy.
 *
 * BUT the shell is not chosen yet (design §4.2/§4.3). Electron bundles its own
 * Node and that Node may predate `node:sqlite` or may not expose it. If that
 * turns out to be the case the fallback is `better-sqlite3`, and the entire
 * cost of that swap must be THIS FILE: re-point `openSqliteDatabase()` at the
 * other package and leave the data layer, the routes and the tests alone.
 * `better-sqlite3`'s API is close enough to `node:sqlite`'s that the
 * structural interfaces below cover both almost verbatim.
 *
 * That guarantee is only worth anything if it is enforced, so
 * db/driver-isolation.spec.ts walks every `.ts` file in `server/` and fails
 * the build if any file other than this one imports a SQLite package.
 *
 * WHY STRUCTURAL INTERFACES RATHER THAN THE PACKAGE'S OWN TYPES. Re-exporting
 * `DatabaseSync` would put `node:sqlite`'s types into every consumer's type
 * graph, and swapping the package would then be a type-level rewrite even if
 * the runtime behaviour matched. The interfaces below describe only the
 * surface this application actually uses.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * Which package is behind the interfaces here.
 *
 * Logged at startup by db/pool.ts, so a support bundle says which driver the
 * user's install actually ran — the one fact that matters first if the
 * Electron fallback to `better-sqlite3` ever ships alongside this.
 */
export const SQLITE_DRIVER_NAME = 'node:sqlite';

/**
 * A value this application is willing to hand to the driver as a bound
 * parameter. Deliberately NARROWER than what `node:sqlite` accepts: every
 * JSON value is converted to one of these by db/bind-values.ts first, so a
 * `Date`, a boolean or an `undefined` can never reach the driver (all three
 * throw "Provided value cannot be bound to SQLite parameter").
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
 * One prepared statement.
 *
 * Both overloads are real and both are used: the data layer binds by NAME
 * (`@coinId`), because that is the shape `.input(name, ...)` produces and
 * because a positional bind would make the 30-column coin INSERT unreadable.
 * Test fixtures and the Stage 2 import bind POSITIONALLY (`?`), where the
 * statement is written and bound in the same two lines and a name would be
 * ceremony.
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
   * *** ALWAYS TRUE IN PRODUCTION. ***
   * SQLite enforces foreign keys only when asked: the pragma is OFF by default
   * at the C-library level, which would make every FOREIGN KEY in schema.sql
   * decorative — declared, documented, and enforcing nothing. `node:sqlite`
   * defaults this option to true; it is passed explicitly anyway so that the
   * value is visible at the call site rather than inherited from a default a
   * future Node release could change.
   */
  readonly enableForeignKeyConstraints: boolean;
  /**
   * How long SQLite waits for a lock before giving up, in milliseconds.
   * One desktop user means contention is rare, but the backup job (§4.7) and
   * the application can still overlap.
   */
  readonly busyTimeoutMs: number;
}

/**
 * Opens a database. The ONE place the SQLite package is constructed.
 *
 * `readBigInts` is left at its default (false), so INTEGER columns arrive as
 * JavaScript numbers — which is what every row mapper and every route in this
 * application already expects from `mssql`. The ids involved (an AUTOINCREMENT
 * key, a year, a sort order) are nowhere near 2^53.
 */
export function openSqliteDatabase(options: SqliteOpenOptions): SqliteDatabase {
  const database = new DatabaseSync(options.filename, {
    open: true,
    enableForeignKeyConstraints: options.enableForeignKeyConstraints,
    timeout: options.busyTimeoutMs,
    readBigInts: false,
    returnArrays: false,
    // An `.input()` whose parameter the statement does not mention is normal
    // in this codebase: routes/coins/writes.ts binds every COIN_FIELDS entry
    // and then names only the ones the request body supplied. `mssql` ignores
    // the extras; so must this. The OPPOSITE mistake — a statement naming a
    // parameter nobody bound — is NOT tolerated, because SQLite would bind it
    // to NULL silently; db/sql-api.ts checks for it before executing.
    allowUnknownNamedParameters: true,
  });

  return database as unknown as SqliteDatabase;
}
