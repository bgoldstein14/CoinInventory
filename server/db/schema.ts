/**
 * db/schema.ts — bringing a database up to the shape the application needs.
 *
 * Two jobs, both run once per open by db/pool.ts:
 *
 *   applySchema()   execute db/schema.sql, which is written entirely in
 *                   CREATE ... IF NOT EXISTS so it is a no-op against an
 *                   existing database and a full build against a new one.
 *   seedReferenceData()  (db/seed.ts) put the reference rows back.
 *
 * *** THIS IS NOT A MIGRATION RUNNER, AND IT SHOULD NOT BECOME ONE. ***
 * server/migrations/*.sql is the history of a SQL SERVER database. Those
 * scripts are kept in the tree because the owner has not moved his data yet
 * and Stage 2's import needs to be able to read a database in that shape —
 * they are not a sequence to replay here, and db/schema.sql is already their
 * destination.
 *
 * A SQLite database will eventually need its own migrations, when a release
 * changes the schema under a user who already has a collection. The right
 * shape for that is `PRAGMA user_version` plus a list of numbered steps, and
 * the right time to build it is when there is a first one to write — not
 * now, speculatively, against a schema no user has yet.
 */

import fs from 'fs';
import path from 'path';

import type { SqliteDatabase } from './driver';

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
 * Creates every table and index that is missing.
 *
 * `exec()` rather than prepare/run, because this is the one place a
 * multi-statement script is correct: exec() runs all of them, where
 * prepare() would compile the first and silently discard the rest (the trap
 * db/sql-api.ts guards against for ordinary queries).
 */
export function applySchema(database: SqliteDatabase): void {
  database.exec(readSchemaSql());
}

/**
 * Enables write-ahead logging on a file database.
 *
 * WAL lets a reader and a writer proceed at the same time, and — more
 * usefully here — means a crash cannot leave a half-written page in the main
 * file. It is a property of the FILE and survives reopening, so setting it
 * every time is harmless.
 *
 * Not applicable to an in-memory database, which has no journal to write;
 * SQLite answers 'memory' to the pragma and that is not a failure.
 *
 * NOTE for §4.7 (backup): WAL adds `-wal` and `-shm` sidecar files next to
 * the database. They are transient, and `VACUUM INTO` produces a single
 * self-contained file, so "one file to back up" survives — but a backup
 * implemented as a file copy of the `.db` alone would silently lose the most
 * recent transactions.
 */
export function enableWriteAheadLog(database: SqliteDatabase): void {
  database.exec('PRAGMA journal_mode = WAL');
}
