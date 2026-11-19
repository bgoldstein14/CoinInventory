/**
 * Helpers for specs that need a real SQLite file in a temp directory
 * (backup and restore). Everything else runs on ':memory:'.
 *
 * Always call releaseFileDatabase() when done: vitest-setup.ts fails any test
 * that leaves COIN_INVENTORY_DB_PATH pointing away from ':memory:'.
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
 * Points the data layer at a new file database and opens it (schema, seed
 * and version stamp applied).
 *
 * Call inside the test or a beforeEach, not at module scope: the global
 * beforeEach in vitest-setup.ts resets the path to ':memory:'.
 */
export async function useFileDatabase(label = 'coin-file-db'): Promise<FileDatabase> {
  // Close the in-memory handle, otherwise getPool() would return it again.
  await resetPool();

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const backupDirectory = path.join(directory, 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });

  const file = path.join(directory, 'coin-inventory.db');
  process.env[DB_PATH_ENV_VAR] = file;

  await getPool();

  return { directory, file, backupDirectory };
}

/**
 * Closes the handle, restores ':memory:' and deletes the temporary tree.
 *
 * Order matters on Windows: the handle must be closed before the file can be
 * deleted, and ':memory:' is restored before deleting so a failed delete
 * still leaves the suite in a safe state.
 */
export async function releaseFileDatabase(database: FileDatabase): Promise<void> {
  await resetPool();
  await rebuildTestDatabase();

  try {
    fs.rmSync(database.directory, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A leftover temp directory is not a test failure.
  }
}

/** Number of rows in Coins. */
export async function liveCoinCount(): Promise<number> {
  const connection = await getPool();
  const result = await connection.request().query('SELECT COUNT(*) AS n FROM Coins');
  return Number(result.recordset[0]?.['n'] ?? 0);
}

/** Inserts `count` minimal coins. */
export async function insertCoins(count: number, prefix = 'coin'): Promise<void> {
  const connection = await getPool();
  for (let index = 0; index < count; index++) {
    await connection
      .request()
      .input('id', DB_BINDINGS.coinId, `${prefix}-${index}`)
      .query('INSERT INTO Coins (CoinId) VALUES (@id)');
  }
}
