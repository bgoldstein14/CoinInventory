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
 *
 * *** THE PRAGMA IS NOW SET. THE NUMBERED STEPS ARE STILL NOT. ***
 * See SCHEMA_VERSION below. Stamping the version is not the first half of a
 * migration runner — it is an IDENTITY on the file, and it had to be added
 * before §16's backup feature shipped because it is the one thing that
 * cannot be added to a file retrospectively. A backup written yesterday is
 * unidentifiable for ever.
 */

import fs from 'fs';
import path from 'path';

import type { SqliteDatabase } from './driver';

/**
 * WHAT SHAPE THIS BUILD'S DATABASE IS. Stamped into every database this
 * build opens, read back out of every file §16's restore is offered.
 *
 * *** 1 MEANS: db/schema.sql as it stands at the dealer-readiness release —
 * the eleven tables that came out of the SQL Server migration, with
 * Transactions already folded into Coins. ***
 *
 * WHY 1 AND NOT A DATE OR A BUILD NUMBER. The number has exactly one job:
 * be comparable. `restore` asks "is this file's number greater than mine?"
 * and refuses if it is. A date (20261114) answers that too, but it invites
 * the belief that any two dates differ meaningfully, which encourages
 * stamping a new one for a release that did not touch the schema — and then
 * last month's perfectly readable backup is refused by this month's build
 * for no reason. A small integer that moves ONLY when db/schema.sql changes
 * in a way that makes an older build unable to read the file keeps the
 * comparison honest.
 *
 * ZERO IS NOT AN ERROR, IT IS A DATE. `PRAGMA user_version` defaults to 0 and
 * this application never set it until now, so 0 means "made by a build from
 * before 2026-11-14". Those files have the same eleven tables — nothing in
 * the schema changed when the stamp was added — so restore ACCEPTS them, on
 * the strength of the table check rather than the number. See
 * backup/inspect.ts, which says this to the user in those words.
 *
 * *** WHEN TO BUMP THIS. *** When db/schema.sql gains a column, table or
 * constraint that this build's code depends on. Bumping it is a promise to
 * EVERY EARLIER BUILD that it should refuse the file, so it must not be
 * touched for a change an earlier build could have read quite happily. And
 * bumping it still does not make this a migration runner: it makes an old
 * build say "this collection is from a newer version of Coin Inventory"
 * instead of mis-reading it. Writing the step that brings an OLD file
 * forward is a separate decision, deliberately not taken yet.
 */
export const SCHEMA_VERSION = 1;

/**
 * The value this application never set, and therefore the one that means
 * "stamped before stamping existed". Named so the comparisons below read as
 * something other than a bare 0.
 */
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
 * What `PRAGMA user_version` currently says. 0 for any database this
 * application opened before the stamp existed, and for any SQLite file that
 * was never ours.
 *
 * `PRAGMA user_version` returns a row, so it goes through prepare/all rather
 * than exec — which returns nothing at all and would silently give back
 * `undefined` here.
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
 * Writes SCHEMA_VERSION into the file, if and only if that is an upgrade.
 *
 * THREE CASES, AND THE THIRD IS THE REASON THIS IS NOT A ONE-LINER:
 *
 *   before <  SCHEMA_VERSION   stamp it. Covers both a brand-new file and
 *                              every database that existed before this
 *                              feature — their shape is already correct, so
 *                              recording what they are is all that is owed.
 *   before == SCHEMA_VERSION   nothing to do. The common case, every open.
 *   before >  SCHEMA_VERSION   *** DO NOT WRITE. *** A file from a later
 *                              build has landed in front of an earlier one.
 *                              Stamping it DOWN would destroy the only
 *                              record of what it really is and turn a
 *                              refusable file into one that every future
 *                              restore accepts as ours. We leave the number
 *                              alone, report it, and let the caller warn.
 *
 * The pragma cannot take a bound parameter — SQLite parses the value at
 * prepare time — so the number is interpolated. It is a module constant, not
 * input, and the assertion below is there so it stays that way.
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
 * NOTE for §16 (backup): WAL adds `-wal` and `-shm` sidecar files next to the
 * database, and the most recent transactions live in the `-wal` until a
 * checkpoint folds them back. A backup implemented as a file copy of the
 * `.db` ALONE therefore produces a silently stale database — measured, not
 * assumed: backup/backup.spec.ts writes 5,000 rows, copies the `.db` with
 * `fs.copyFileSync` and reads 4,976 of them back out of the copy.
 *
 * That is why backup/run-backup.ts uses `node:sqlite`'s `backup()` and NOT a
 * copy and NOT `VACUUM INTO`. It is SQLite's online backup API: it reads the
 * database through a connection, so it sees the WAL, and it is consistent
 * while the application is running. The old "close the app before copying
 * the file" warning is gone, and the spec above is what keeps it gone.
 */
export function enableWriteAheadLog(database: SqliteDatabase): void {
  database.exec('PRAGMA journal_mode = WAL');
}
