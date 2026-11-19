/**
 * The database handle's lifecycle: opening the shared database (creating its
 * folder, schema and seed data on first run), `getPool()`, `resetPool()` and
 * `withDb()`. See db/index.ts for an overview.
 *
 * - Single flight: the app fires several API calls in parallel on load, and
 *   they must share one open attempt.
 * - Generation counter: a slow failing request must not close a handle that
 *   was opened after it started.
 * - One automatic retry, for connection-class errors only; retrying anything
 *   else would repeat the caller's writes.
 *
 * Route handlers must not call resetPool().
 */

import fs from 'fs';

import { logInfo, logWarn, logError } from '../logger';
import { buildDbConfig, IN_MEMORY_DATABASE, type DbConfig } from './config';
import { isConnectionError } from './errors';
import { openSqliteDatabase, SQLITE_DRIVER_NAME } from './driver';
import { DbConnection } from './sql-api';
import {
  applySchema,
  enableWriteAheadLog,
  readSchemaVersion,
  stampSchemaVersion,
  upgradeSchema,
  SCHEMA_VERSION
} from './schema';
import { seedReferenceData } from './seed';

/**
 * One open database. Each handle gets an increasing `generation`, so a
 * reset request for an older handle can be ignored.
 */
interface OpenConnection {
  readonly generation: number;
  readonly connection: DbConnection;
  /** Flipped to false by resetPool(). */
  healthy: boolean;
}

/** The connection currently in use, or null if we have none. */
let current: OpenConnection | null = null;

/** The in-flight open attempt, if any. This is the single-flight guard. */
let openPromise: Promise<OpenConnection> | null = null;

/** Monotonically increasing id handed to each new handle. */
let generationCounter = 0;

/** How many times we retry the INITIAL open before surfacing the failure. */
const OPEN_ATTEMPTS = 3;
const OPEN_BASE_DELAY_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates the database folder if needed (e.g. %LOCALAPPDATA%\CoinInventory).
 * The app creates its own data folder rather than relying on the installer.
 */
function ensureDirectory(config: DbConfig): void {
  if (config.directory === null) return;
  fs.mkdirSync(config.directory, { recursive: true });
}

/**
 * Opens the database, retrying with a short backoff, then applies the
 * schema, seed and version stamp. All three are idempotent, so they run on
 * every open.
 */
async function openConnection(): Promise<OpenConnection> {
  const config = buildDbConfig();
  let lastError: unknown;

  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
    const generation = ++generationCounter;

    try {
      logInfo(
        `Opening the coin database at ${config.file} via ${SQLITE_DRIVER_NAME} ` +
          `(attempt ${attempt}/${OPEN_ATTEMPTS})...`
      );

      ensureDirectory(config);

      const database = openSqliteDatabase({
        filename: config.file,
        enableForeignKeyConstraints: config.enableForeignKeyConstraints,
        busyTimeoutMs: config.busyTimeoutMs,
      });

      if (config.file !== IN_MEMORY_DATABASE) enableWriteAheadLog(database);
      applySchema(database);

      // Carry an older file's data into the current tables before stamping it.
      const upgraded = upgradeSchema(database, readSchemaVersion(database));
      if (upgraded > 0) {
        logInfo(`Upgraded the coin database: copied ${upgraded} catalogue reference(s).`);
      }

      // Stamp after applySchema so the version describes the file's current shape.
      const stamp = stampSchemaVersion(database);
      if (stamp.stamped) {
        logInfo(
          `Stamped schema version ${stamp.after} on the coin database ` +
            `(it carried ${stamp.before}).`
        );
      }
      if (stamp.newerThanThisBuild) {
        // Not fatal: newer files are usually compatible, and refusing to open
        // would leave the user with no app. The warning aids diagnosis.
        logWarn(
          `The coin database reports schema version ${stamp.before}, which is NEWER than ` +
            `this build understands (${SCHEMA_VERSION}). It was probably written by a later ` +
            `version of Coin Inventory. Continuing, but some data may not be readable.`
        );
      }

      const seeded = seedReferenceData(database);

      const total =
        seeded.issuers +
        seeded.denominations +
        seeded.catalogs +
        seeded.categories +
        seeded.metalContents +
        seeded.mintMarks;
      if (total > 0) {
        logInfo(
          `Seeded reference data: ${seeded.issuers} issuer(s), ` +
            `${seeded.denominations} denomination(s), ${seeded.catalogs} catalogue(s), ` +
            `${seeded.categories} category/ies, ${seeded.metalContents} metal content(s), ` +
            `${seeded.mintMarks} mint mark(s).`
        );
      }

      logInfo(`Coin database ready (generation ${generation}).`);
      return { generation, connection: new DbConnection(database), healthy: true };
    } catch (err) {
      lastError = err;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(
        `Failed to open the coin database (attempt ${attempt}/${OPEN_ATTEMPTS})`,
        errorMessage
      );

      if (attempt < OPEN_ATTEMPTS) {
        await delay(OPEN_BASE_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to open the coin database: ${String(lastError)}`);
}

/**
 * Returns the current healthy connection, opening one if needed.
 * Concurrent callers share a single open attempt (see `openPromise`).
 */
async function acquireConnection(): Promise<OpenConnection> {
  if (current && current.healthy && !current.connection.isClosed) {
    return current;
  }

  if (current && (!current.healthy || current.connection.isClosed)) {
    await resetPool(current.generation);
  }

  if (!openPromise) {
    openPromise = openConnection()
      .then((handle) => {
        current = handle;
        return handle;
      })
      .finally(() => {
        // Clear the single-flight slot either way so the next request can retry.
        openPromise = null;
      });
  }

  return openPromise;
}

/** Gets (or lazily opens) the shared database connection. Named for the old mssql pool. */
export async function getPool(): Promise<DbConnection> {
  const handle = await acquireConnection();
  return handle.connection;
}

/**
 * Closes the current database so the next caller opens a fresh one.
 *
 * @param generation - When supplied, the reset is ignored unless that
 *   generation is still live, so a late failure can't close a newer handle.
 *   Omit it to force a reset (shutdown and tests).
 *
 * Safe to call concurrently: `current` is cleared before the await.
 */
export async function resetPool(generation?: number): Promise<void> {
  const handle = current;
  if (!handle) return;

  if (generation !== undefined && generation !== handle.generation) {
    logInfo(
      `Ignoring stale database reset for generation ${generation}; the live handle is generation ${handle.generation}.`
    );
    return;
  }

  current = null;
  handle.healthy = false;

  logInfo(`Closing the coin database (generation ${handle.generation}).`);
  try {
    handle.connection.close();
  } catch {
    // The handle may already be gone; the next request opens a fresh one.
  }
}

/**
 * Runs `fn` against the shared connection. Every route handler should use it:
 *
 *   const rows = await withDb(async (db) => {
 *     const result = await db.request().query('SELECT ...');
 *     return result.recordset;
 *   });
 *
 * Retries once only for connection-level errors; other errors propagate
 * immediately so writes are never repeated.
 */
export async function withDb<T>(fn: (db: DbConnection) => Promise<T>): Promise<T> {
  const handle = await acquireConnection();

  try {
    return await fn(handle.connection);
  } catch (err) {
    if (!isConnectionError(err)) {
      // Not a connection problem; the route decides the HTTP status.
      throw err;
    }

    logWarn(
      `Database call failed with a connection-level error on generation ${handle.generation}; reopening and retrying once.`
    );

    await resetPool(handle.generation);

    const retryHandle = await acquireConnection();
    return await fn(retryHandle.connection);
  }
}

/**
 * Runs `work` with no database open, then lets the next caller open whatever
 * is now at the path. Used only by restore to replace the file under a running
 * app. On Windows an open handle would also block the rename (EBUSY).
 * Not exported from db/index.ts.
 */
export async function withDatabaseOffline<T>(work: () => Promise<T>): Promise<T> {
  await resetPool();
  logInfo('The coin database is closed for a restore; the next request will reopen it.');

  try {
    return await work();
  } finally {
    // `current` is already null, so the next request opens the file as it now stands.
    logInfo('Restore window closed; the next request will open the coin database.');
  }
}
