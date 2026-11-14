/**
 * test-support/real-file-db.ts — RUNNING THE SUITE AGAINST A DATABASE THAT
 * IS ACTUALLY A FILE.
 *
 * Every other spec in this project runs on `:memory:`, which is right: it
 * is fast, it is private per test, and it exercises the real schema, the
 * real bindings and the real constraints. §16 is the one feature it cannot
 * test at all. Backup and restore are ABOUT files — a write-ahead log, a
 * rename, a copy, a sidecar, a handle Windows will not let go of — and
 * every interesting failure mode lives in exactly the part an in-memory
 * database does not have.
 *
 * So these specs open a real SQLite file in a real temporary directory, and
 * this module is the safety rail around that.
 *
 * *** IT MUST PUT COIN_INVENTORY_DB_PATH BACK. *** test-support/
 * vitest-setup.ts fails any test that leaves the variable pointing
 * somewhere other than ':memory:', and its header explains why in detail:
 * a spec once left it set, a later file opened `%LOCALAPPDATA%` and a
 * seeded test database appeared in the owner's real collection folder with
 * nothing going red. `releaseFileDatabase()` is what satisfies that guard,
 * and it is why every function here is written to be callable from a
 * `finally` / `afterEach` that must not throw.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { DB_BINDINGS } from '../db/bindings';
import { DB_PATH_ENV_VAR } from '../db/config';
import { getPool, resetPool } from '../db/pool';
import { rebuildTestDatabase } from './sqlite-test-db';

export interface FileDatabase {
  /** The temporary directory holding it. Deleted by releaseFileDatabase(). */
  readonly directory: string;
  /** The database file itself. */
  readonly file: string;
  /** A second temporary directory, for backups to be written into. */
  readonly backupDirectory: string;
}

/**
 * Points the data layer at a brand-new file database and opens it, so the
 * schema, the seed and the version stamp have all run.
 *
 * Call it inside the test (or a `beforeEach` of your own), NOT at module
 * scope: the global `beforeEach` in vitest-setup.ts re-asserts ':memory:'
 * before every test and would undo it.
 */
export async function useFileDatabase(label = 'coin-file-db'): Promise<FileDatabase> {
  // Close whatever in-memory handle the harness already opened, or the
  // next getPool() would hand it back and the file would never be created.
  await resetPool();

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const backupDirectory = path.join(directory, 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });

  const file = path.join(directory, 'coin-inventory.db');
  process.env[DB_PATH_ENV_VAR] = file;

  // Opens it for real: WAL on, schema applied, reference data seeded,
  // user_version stamped.
  await getPool();

  return { directory, file, backupDirectory };
}

/**
 * Closes the handle, restores ':memory:' and deletes the temporary tree.
 *
 * THE ORDER IS LOAD-BEARING ON WINDOWS. A file with an open handle cannot
 * be deleted, so the pool is closed first; and the environment variable is
 * restored BEFORE the directory is removed, so a failure to delete (an
 * antivirus scanner holding the file for a moment, which does happen) still
 * leaves the suite pointing at ':memory:' rather than at a path that is
 * about to vanish.
 */
export async function releaseFileDatabase(database: FileDatabase): Promise<void> {
  await resetPool();
  await rebuildTestDatabase();

  try {
    fs.rmSync(database.directory, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A leftover temp directory is the operating system's problem, not a
    // test failure. Swallowed so the guard above is never skipped.
  }
}

/** Convenience: how many coins the live collection has, read through SQL. */
export async function liveCoinCount(): Promise<number> {
  const connection = await getPool();
  const result = await connection.request().query('SELECT COUNT(*) AS n FROM Coins');
  return Number(result.recordset[0]?.['n'] ?? 0);
}

/** Convenience: insert `count` coins into the live collection. */
export async function insertCoins(count: number, prefix = 'coin'): Promise<void> {
  const connection = await getPool();
  for (let index = 0; index < count; index++) {
    await connection
      .request()
      .input('id', DB_BINDINGS.coinId, `${prefix}-${index}`)
      .query('INSERT INTO Coins (CoinId) VALUES (@id)');
  }
}
