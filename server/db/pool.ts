/**
 * db/pool.ts — the database handle's lifecycle. Read db/index.ts first.
 *
 * This file owns:
 *   - opening the one shared database (and creating its folder, its schema
 *     and its reference data the first time)
 *   - the single-flight guard so concurrent callers share one open attempt
 *   - the generation counter so a stale reset cannot destroy a fresh handle
 *   - `getPool()`  — hand out the connection
 *   - `resetPool()`— close it (shutdown / tests / a handle that went bad)
 *   - `withDb()`   — the wrapper EVERY route handler should use
 *
 * Nothing else in the codebase is allowed to open a database, and in
 * particular NO ROUTE HANDLER MAY CALL resetPool(). Route code tearing down
 * the shared connection on ordinary errors was a primary cause of the
 * original production crash.
 *
 *
 * *** WHAT CHANGED WITH SQLITE, AND WHAT DELIBERATELY DID NOT ***
 *
 * The crash this layer was built around was specific to `mssql`: its
 * ConnectionPool is an EventEmitter, a Node EventEmitter with zero 'error'
 * listeners THROWS when 'error' is emitted on it, and that throw happened on
 * a socket callback where nothing could catch it — so a dropped idle
 * connection killed the whole Express process. There is no socket here, no
 * EventEmitter and no pool, so that failure mode does not exist and the
 * listener that guarded against it is gone. It has NOT been re-created in a
 * fake form: a guard against a mechanism that is absent is a comment
 * pretending to be code. db/connection.spec.ts records the deletion.
 *
 * Everything else was kept, because the reasons for it survive the engine:
 *
 *   - SINGLE FLIGHT. The Angular app fires ~7 API calls in parallel on load.
 *     Without the guard each would see "no handle" and each would open the
 *     file, apply the schema and run the seed — seven times, concurrently,
 *     against one file.
 *   - GENERATION COUNTER. A request that fails slowly must not be able to
 *     close a handle that was opened after it started.
 *   - ONE AUTOMATIC RETRY, CONNECTION-CLASS ERRORS ONLY. A locked or
 *     momentarily unavailable file is worth retrying once. A constraint
 *     violation is not, and retrying it would run the caller's function —
 *     including its writes — a second time.
 *   - NO PER-REQUEST HEALTH CHECK. It halved round trips and removed a race
 *     where the check closed a handle other requests were using. It would be
 *     even more pointless here, where the "connection" is a file descriptor.
 */

import fs from 'fs';

import { logInfo, logWarn, logError } from '../logger';
import { buildDbConfig, IN_MEMORY_DATABASE, type DbConfig } from './config';
import { isConnectionError } from './errors';
import { openSqliteDatabase, SQLITE_DRIVER_NAME } from './driver';
import { DbConnection } from './sql-api';
import { applySchema, enableWriteAheadLog } from './schema';
import { seedReferenceData } from './seed';

/**
 * Everything we track about one open database. `generation` is the key idea:
 * every handle we ever build gets a unique, increasing id. Callers remember
 * the generation they used, so when they later ask us to tear it down we can
 * check "is this still the handle you were talking about?" and ignore the
 * request if we have already moved on.
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
 * Makes sure the folder the database file goes in exists.
 *
 * On a first run under §4.10a this is `%LOCALAPPDATA%\CoinInventory`, which
 * the installer is not required to create — the application owns its own
 * data directory so that a portable copy, a different user profile and a
 * restored backup all work without the installer having been involved.
 */
function ensureDirectory(config: DbConfig): void {
  if (config.directory === null) return;
  fs.mkdirSync(config.directory, { recursive: true });
}

/**
 * Opens the database once, retrying a few times with a short backoff, and
 * brings it up to date.
 *
 * The three steps after opening are all idempotent, which is what lets them
 * run on EVERY open rather than only on a first run — there is no "is this a
 * new database?" test to get wrong.
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
        // Clear the single-flight slot whether we succeeded or failed, so the
        // next request is free to try again.
        openPromise = null;
      });
  }

  return openPromise;
}

/**
 * Gets (or lazily opens) the shared database connection.
 *
 * Still called `getPool()`. The name is a small lie now — there is no pool —
 * but it is exported from db/index.ts, re-exported from server.ts and named
 * in the specs, and renaming it would be churn in a change that is already
 * large. It will be worth renaming when something else is touching those
 * files anyway.
 */
export async function getPool(): Promise<DbConnection> {
  const handle = await acquireConnection();
  return handle.connection;
}

/**
 * Closes the current database so the next caller opens a fresh one.
 *
 * @param generation - Optional. When supplied, the reset is IGNORED unless
 *   that generation is still the live handle. Callers should always pass the
 *   generation they actually used, so a slow/late failure cannot close a
 *   handle that was opened after it. Calling with no argument forces an
 *   unconditional reset (used at shutdown and by tests).
 *
 * Safe to call concurrently: `current` is cleared BEFORE the await, so a
 * second concurrent caller sees null and returns immediately.
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
    // The handle may already be gone; ignore cleanup failures and let the
    // next request open a fresh one.
  }
}

/**
 * Runs `fn` against the shared connection, with exactly one automatic retry
 * when — and only when — the failure was a connection-level error.
 *
 * This is the function every route handler should use:
 *
 *   const rows = await withDb(async (db) => {
 *     const result = await db.request().query('SELECT ...');
 *     return result.recordset;
 *   });
 *
 * Connection-class errors ONLY. Retrying every failure means a constraint
 * violation or a too-long string runs the caller's writes twice. Ordinary
 * query errors propagate on the first throw, untouched.
 */
export async function withDb<T>(fn: (db: DbConnection) => Promise<T>): Promise<T> {
  const handle = await acquireConnection();

  try {
    return await fn(handle.connection);
  } catch (err) {
    if (!isConnectionError(err)) {
      // Not a connection problem — leave the handle alone and let the route's
      // catch block decide on the HTTP status.
      throw err;
    }

    logWarn(
      `Database call failed with a connection-level error on generation ${handle.generation}; reopening and retrying once.`
    );

    // Generation-guarded: only closes the handle we actually used.
    await resetPool(handle.generation);

    const retryHandle = await acquireConnection();
    return await fn(retryHandle.connection);
  }
}
