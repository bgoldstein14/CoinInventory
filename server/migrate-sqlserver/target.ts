/**
 * migrate-sqlserver/target.ts — the SQLite side: open it, refuse to write
 * into a collection that already exists, and (only when told) clear one.
 *
 * *** REQUIREMENT 3 LIVES HERE AND IT IS THE CHEAPEST SAFETY IN THE TOOL. ***
 * The owner has already made test coins while checking Stage 1. A second run
 * of a migration that merged would give him two of every coin, two of every
 * photograph and two of every spot price, with new ids, and no way to tell
 * which half is which. So:
 *
 *   - a target with any owner data in it is REFUSED, by default, with the
 *     per-table counts printed so the refusal is checkable;
 *   - `--force` does not mean "merge anyway". It means "delete what is
 *     there first", it says exactly what it is about to delete, and it
 *     deletes nothing until the whole migration is ready to run.
 *
 * There is deliberately no "merge" mode and no "skip duplicates" mode. Both
 * are plausible-sounding, both produce a collection whose contents depend on
 * the order the rows happened to arrive in, and neither can be verified.
 *
 * WHY THIS OPENS THE DATABASE ITSELF RATHER THAN CALLING db/pool.ts.
 * `getPool()` resolves the file from the environment, logs through the
 * server's logger and retries. All three are right for a server and wrong
 * for a one-shot script that must say out loud which file it is about to
 * write, and must be pointable at a scratch copy for a rehearsal.
 */

import fs from 'fs';
import path from 'path';

import { openSqliteDatabase, type SqliteDatabase } from '../db/driver';
import { applySchema, enableWriteAheadLog } from '../db/schema';
import { seedReferenceData, type SeedReport } from '../db/seed';
import { BUSY_TIMEOUT_MS, IN_MEMORY_DATABASE } from '../db/config';
import { ALL_TABLES, DELETE_ORDER, OCCUPANCY_TABLES, type TableName } from './tables';

/** Same identifier rule as the source side, for the same reason. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Refusing to build SQL around the identifier ${JSON.stringify(name)}.`);
  }
  return name;
}

/** What `openTarget()` produced. */
export interface OpenedTarget {
  readonly database: SqliteDatabase;
  readonly file: string;
  /** Rows db/seed.ts inserted on this open. Zero on a database already seeded. */
  readonly seeded: SeedReport;
  /** True when the file did not exist before this call. */
  readonly created: boolean;
}

/**
 * Opens (or builds) the destination, exactly as the application would.
 *
 * Schema and seed are applied here, before anything is migrated, because the
 * reconciliation in reference-data.ts is written against a database that has
 * already been seeded — it compares the owner's reference rows with the rows
 * the seeder put there, and "the seeder has not run yet" would make every
 * seeded row look like one of his.
 */
export function openTarget(file: string): OpenedTarget {
  const inMemory = file === IN_MEMORY_DATABASE;
  const created = inMemory ? true : !fs.existsSync(file);

  if (!inMemory) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const database = openSqliteDatabase({
    filename: file,
    enableForeignKeyConstraints: true,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
  });

  if (!inMemory) enableWriteAheadLog(database);
  applySchema(database);
  const seeded = seedReferenceData(database);

  return { database, file, seeded, created };
}

/** Column names the target actually has, straight from SQLite. */
export function targetColumns(database: SqliteDatabase, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${assertIdentifier(table)})`).all();
  return rows.map((row) => String(row['name']));
}

/** COUNT(*) on the target. */
export function targetCount(database: SqliteDatabase, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${assertIdentifier(table)}`).all()[0];
  return Number(row?.['n'] ?? 0);
}

/** Every table's row count, for the report and for the occupancy check. */
export function targetCounts(database: SqliteDatabase): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ALL_TABLES) counts[table] = targetCount(database, table);
  return counts;
}

/** What the occupancy check found. */
export interface TargetOccupancy {
  readonly occupied: boolean;
  /** Only the tables that actually had rows, in the order they were checked. */
  readonly occupiedTables: ReadonlyArray<{ table: TableName; rows: number }>;
}

/**
 * Is there already a collection in this file?
 *
 * Reference tables are excluded on purpose — see OCCUPANCY_TABLES. A newly
 * created database is already full of seeded issuers and denominations, and
 * a check that counted those would refuse every first run.
 */
export function inspectOccupancy(database: SqliteDatabase): TargetOccupancy {
  const occupiedTables: Array<{ table: TableName; rows: number }> = [];

  for (const table of OCCUPANCY_TABLES) {
    const rows = targetCount(database, table);
    if (rows > 0) occupiedTables.push({ table, rows });
  }

  return { occupied: occupiedTables.length > 0, occupiedTables };
}

/** Raised instead of writing into a database that already holds coins. */
export class TargetNotEmptyError extends Error {
  constructor(
    readonly file: string,
    readonly occupancy: TargetOccupancy
  ) {
    const detail = occupancy.occupiedTables
      .map((entry) => `    ${entry.table.padEnd(14)} ${entry.rows} row(s)`)
      .join('\n');

    super(
      `REFUSING TO MIGRATE: ${file} already holds data.\n\n` +
        `${detail}\n\n` +
        `  Nothing has been written and nothing has been read from SQL Server.\n\n` +
        `  This tool will not merge. A second run that merged would give you a\n` +
        `  second copy of every coin, photograph and spot price, with new ids,\n` +
        `  and no way to tell the two apart.\n\n` +
        `  What to do:\n` +
        `    - if those rows are the test coins from Stage 1, re-run with --force,\n` +
        `      which DELETES them and then migrates;\n` +
        `    - if they are real, point --target at a new file instead, or move\n` +
        `      the existing one aside first (close the app, and take the -wal and\n` +
        `      -shm files with it).`
    );
    this.name = 'TargetNotEmptyError';
  }
}

/**
 * Deletes the owner-data tables, child before parent.
 *
 * Reference tables are deliberately left alone. The reconciliation is
 * idempotent by identity — an issuer the owner added is matched by name on
 * the next run and not inserted twice — so clearing them would only throw
 * away the seed and make the next open rebuild it.
 */
export function clearOwnerData(database: SqliteDatabase): Record<string, number> {
  const deleted: Record<string, number> = {};

  // No transaction of its own, deliberately. migrate.ts runs the clear, the
  // copy and the verification inside ONE transaction, so that a migration
  // which fails verification leaves the target exactly as it was — deleting
  // in a transaction of its own would break that and leave an emptied file
  // behind after a failed run.
  for (const table of DELETE_ORDER) {
    const result = database.prepare(`DELETE FROM ${assertIdentifier(table)}`).run();
    deleted[table] = Number(result.changes);
  }

  return deleted;
}
