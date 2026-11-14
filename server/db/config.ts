/**
 * db/config.ts — WHERE THE DATABASE FILE LIVES, and nothing else.
 *
 * This file used to turn `server/.env` into an `mssql` connection config. It
 * now answers the one question SQLite leaves open: which file. It still opens
 * nothing and holds no state, which is what makes it trivial to unit test.
 *
 * *** THE DATA MUST NOT LIVE IN THE INSTALL DIRECTORY. *** Design §4.10a:
 *
 *     Program Files\Coin Inventory\     the application. Chosen at install.
 *     %LOCALAPPDATA%\CoinInventory\     the database. NOT chosen, NOT asked.
 *
 * Two reasons, and the first is a Windows constraint rather than a
 * preference. `Program Files` is not writable by a standard user account
 * without elevation, so a SQLite file there would fail to open for writing on
 * an ordinary run — and it would fail INTERMITTENTLY, because an admin
 * install followed by a standard-user launch is exactly the common case. The
 * second is that §4.7's rule "uninstall must not remove the collection
 * silently" becomes structurally true when the uninstaller's target directory
 * simply does not contain the data.
 *
 * *** AND IT MUST BE OVERRIDABLE, OR THE TEST SUITE EATS THE OWNER'S
 * COLLECTION. *** Every spec in this project runs against a real SQLite
 * database now (that is the point — see test-support/sqlite-test-db.ts). A
 * suite that resolved the production path would truncate the user's coins on
 * every `npm test`. COIN_INVENTORY_DB_PATH is therefore read FIRST, before
 * any platform logic, and the test harness sets it to ':memory:'.
 */

import os from 'os';
import path from 'path';

/**
 * Absolute path to the database file, or ':memory:'. Overrides everything.
 * Set by the test harness and available for CI and for a portable install.
 */
export const DB_PATH_ENV_VAR = 'COIN_INVENTORY_DB_PATH';

/**
 * Directory to put the database in, when the file name should stay the
 * default. Useful for "run two collections side by side" without having to
 * know the file name.
 */
export const DB_DIR_ENV_VAR = 'COIN_INVENTORY_DATA_DIR';

/** The folder under %LOCALAPPDATA%. Named in design §4.10a. */
export const DATA_DIR_NAME = 'CoinInventory';

/** The file inside it. */
export const DATABASE_FILE_NAME = 'coin-inventory.db';

/** The literal `node:sqlite` understands as "private in-memory database". */
export const IN_MEMORY_DATABASE = ':memory:';

/** Everything the pool needs in order to open a database. */
export interface DbConfig {
  /** Absolute path to the file, or ':memory:'. */
  readonly file: string;
  /** The directory that must exist before the file can be opened; null for
   *  an in-memory database, which has no directory. */
  readonly directory: string | null;
  /** Always true. See the note on SqliteOpenOptions in db/driver.ts. */
  readonly enableForeignKeyConstraints: boolean;
  /** Lock wait, in milliseconds. */
  readonly busyTimeoutMs: number;
}

/**
 * How long to wait for a lock before failing.
 *
 * One desktop user means real contention is rare, but it is not impossible:
 * §4.7's backup runs `VACUUM INTO` against the same file the application is
 * using. Five seconds is long enough to ride out a checkpoint and short
 * enough that a genuinely stuck lock still surfaces as an error rather than
 * as a hung window.
 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * The directory the database lives in, on this machine.
 *
 * LOCALAPPDATA is read from the environment rather than derived, because
 * that is where Windows actually publishes it and a user with a redirected
 * profile has a different answer from the one `os.homedir()` would guess.
 * The fallbacks exist so the server still starts on a machine (or a CI
 * container) where it is not set, rather than throwing during module load.
 */
export function resolveDataDirectory(): string {
  const explicit = process.env[DB_DIR_ENV_VAR]?.trim();
  if (explicit) return path.resolve(explicit);

  const localAppData = process.env['LOCALAPPDATA']?.trim();
  if (localAppData) return path.join(localAppData, DATA_DIR_NAME);

  // Not Windows, or a stripped environment. `os.homedir()` is the closest
  // equivalent and keeps the data out of the install directory, which is the
  // property that actually matters.
  return path.join(os.homedir(), `.${DATA_DIR_NAME.toLowerCase()}`);
}

/**
 * Builds the database configuration.
 *
 * Kept under the name `buildDbConfig` on purpose: db/index.ts exports it,
 * db/pool.ts consumes it and the specs name it. The SHAPE it returns changed
 * with the engine; the role it plays did not.
 */
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
