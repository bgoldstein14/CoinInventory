/**
 * Where the database file lives. Opens nothing and holds no state.
 *
 * The database lives in %LOCALAPPDATA%\CoinInventory, not the install
 * directory: Program Files isn't writable by a standard user, and keeping
 * data out of it means uninstalling can't remove the collection.
 *
 * COIN_INVENTORY_DB_PATH is checked first so the test harness can point at
 * ':memory:' instead of the real collection.
 */

import os from 'os';
import path from 'path';

/**
 * Absolute path to the database file, or ':memory:'. Overrides everything.
 * Set by the test harness and available for CI and for a portable install.
 */
export const DB_PATH_ENV_VAR = 'COIN_INVENTORY_DB_PATH';

/** Directory for the database when the file name should stay the default. */
export const DB_DIR_ENV_VAR = 'COIN_INVENTORY_DATA_DIR';

/** The folder under %LOCALAPPDATA%. */
export const DATA_DIR_NAME = 'CoinInventory';

/** The file inside it. */
export const DATABASE_FILE_NAME = 'coin-inventory.db';

/** The literal `node:sqlite` understands as "private in-memory database". */
export const IN_MEMORY_DATABASE = ':memory:';

/** Everything the pool needs in order to open a database. */
export interface DbConfig {
  /** Absolute path to the file, or ':memory:'. */
  readonly file: string;
  /** Directory that must exist before opening; null for an in-memory database. */
  readonly directory: string | null;
  /** Always true (see SqliteOpenOptions in db/driver.ts). */
  readonly enableForeignKeyConstraints: boolean;
  /** Lock wait, in milliseconds. */
  readonly busyTimeoutMs: number;
}

/**
 * How long to wait for a lock before failing. Long enough to ride out a
 * checkpoint or backup batch, short enough that a stuck lock surfaces as an
 * error rather than a hung window.
 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * The directory the database lives in on this machine. Uses LOCALAPPDATA from
 * the environment (correct for redirected profiles), with fallbacks so the
 * server still starts where it isn't set.
 */
export function resolveDataDirectory(): string {
  const explicit = process.env[DB_DIR_ENV_VAR]?.trim();
  if (explicit) return path.resolve(explicit);

  const localAppData = process.env['LOCALAPPDATA']?.trim();
  if (localAppData) return path.join(localAppData, DATA_DIR_NAME);

  // Not Windows, or a stripped environment: use the home directory.
  return path.join(os.homedir(), `.${DATA_DIR_NAME.toLowerCase()}`);
}

/** Builds the database configuration. */
export function buildDbConfig(): DbConfig {
  const override = process.env[DB_PATH_ENV_VAR]?.trim();

  if (override) {
    if (override === IN_MEMORY_DATABASE) {
      return {
        file: IN_MEMORY_DATABASE,
        directory: null,
        enableForeignKeyConstraints: true,
        busyTimeoutMs: BUSY_TIMEOUT_MS,
      };
    }

    const resolved = path.resolve(override);
    return {
      file: resolved,
      directory: path.dirname(resolved),
      enableForeignKeyConstraints: true,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
    };
  }

  const directory = resolveDataDirectory();
  return {
    file: path.join(directory, DATABASE_FILE_NAME),
    directory,
    enableForeignKeyConstraints: true,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
  };
}
