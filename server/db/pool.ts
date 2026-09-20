/**
 * db/pool.ts — the connection pool lifecycle. THE MOST IMPORTANT FILE IN THE
 * BACKEND. Read db/index.ts first for the story of the crash this code fixes.
 *
 * This file owns:
 *   - creating the one shared `sql.ConnectionPool` (and attaching its 'error'
 *     listener before connecting — that listener IS the crash fix)
 *   - the single-flight guard so concurrent callers share one connect attempt
 *   - the generation counter so a stale reset cannot destroy a fresh pool
 *   - `getPool()`  — hand out the pool
 *   - `resetPool()`— tear the pool down (shutdown / tests / a dead connection)
 *   - `withDb()`   — the wrapper EVERY route handler should use
 *
 * Nothing else in the codebase is allowed to construct a ConnectionPool, and
 * in particular NO ROUTE HANDLER MAY CALL resetPool(). Route code tearing down
 * the shared pool on ordinary errors was a primary cause of the original crash.
 */

import sql from 'mssql';
import { logInfo, logWarn, logError } from '../logger';
import { buildDbConfig } from './config';
import { isConnectionError } from './errors';

// ============================================================
// Connection pool (single-flight, generation-guarded singleton)
// ============================================================

/**
 * Everything we track about one physical pool. `generation` is the key idea:
 * every pool we ever build gets a unique, increasing id. Callers remember the
 * generation they used, so when they later ask us to tear the pool down we can
 * check "is this still the pool you were talking about?" and ignore the request
 * if we have already moved on. Without that guard, a slow request failing at
 * 10:00:05 could destroy a healthy pool that was created at 10:00:04.
 */
interface PooledConnection {
  readonly generation: number;
  readonly pool: sql.ConnectionPool;
  /** Flipped to false by the pool 'error' listener or by resetPool(). */
  healthy: boolean;
}

/** The pool currently in use, or null if we have none. */
let current: PooledConnection | null = null;

/**
 * The in-flight connect attempt, if any. This is the "single-flight" guard:
 * the Angular app fires ~7 API calls in parallel on load, and without this they
 * would each see `current === null` and each open a competing pool.
 */
let connectPromise: Promise<PooledConnection> | null = null;

/** Monotonically increasing id handed to each new pool. */
let generationCounter = 0;

/** How many times we retry the *initial* connect before surfacing the failure. */
const CONNECT_ATTEMPTS = 3;
const CONNECT_BASE_DELAY_MS = 1000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds and connects one pool, retrying a few times with a short backoff.
 * Never called directly by routes — go through getPool()/withDb().
 */
async function createPooledConnection(): Promise<PooledConnection> {
  const config = buildDbConfig();
  let lastError: unknown;

  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    const generation = ++generationCounter;

    // Construct the pool explicitly instead of calling the global sql.connect().
    // sql.connect() stashes the pool in a hidden module-level global inside the
    // mssql package, which made it impossible to reason about who owned what.
    const pool = new sql.ConnectionPool(config);
    const handle: PooledConnection = { generation, pool, healthy: true };

    // ******************************************************************
    // *** THE ACTUAL CRASH FIX ***
    // Attach the 'error' listener IMMEDIATELY, before connect() is called,
    // so there is never a window where the pool can emit 'error' with no
    // listener attached. An EventEmitter with no 'error' listener throws,
    // and that throw kills the Node process.
    //
    // We log it, mark the pool unhealthy so the next caller rebuilds it,
    // and deliberately do NOT rethrow.
    // ******************************************************************
    pool.on('error', (err: unknown) => {
      handle.healthy = false;
      logError(`SQL connection pool (generation ${generation}) reported an error; it will be rebuilt on next use`, err);
    });

    try {
      logInfo(`Connecting to SQL Server at ${config.server}/${config.database} (attempt ${attempt}/${CONNECT_ATTEMPTS})...`);
      await pool.connect();
      logInfo(`Connected to SQL Server successfully (pool generation ${generation})`);
      return handle;
    } catch (err) {
      lastError = err;
      handle.healthy = false;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logError(`Failed to connect to SQL Server (attempt ${attempt}/${CONNECT_ATTEMPTS})`, errorMessage);

      // Release the half-built pool's resources. It may already be dead; that's fine.
      try {
        await pool.close();
      } catch {
        // Ignore cleanup failures on a pool that never fully opened.
      }

      if (attempt < CONNECT_ATTEMPTS) {
        await delay(CONNECT_BASE_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Unable to establish SQL Server connection: ${String(lastError)}`);
}

/**
 * Returns the current healthy pool handle, creating one if needed.
 * Concurrent callers share a single connect attempt (see `connectPromise`).
 */
async function acquirePooledConnection(): Promise<PooledConnection> {
  // Fast path: we already have a pool and nothing has reported it broken.
  if (current && current.healthy) {
    return current;
  }

  // We have a pool but its 'error' listener marked it unhealthy — discard it.
  if (current && !current.healthy) {
    await resetPool(current.generation);
  }

  // Another caller is already connecting: await their attempt instead of
  // starting a competing one.
  if (!connectPromise) {
    connectPromise = createPooledConnection()
      .then((handle) => {
        current = handle;
        return handle;
      })
      .finally(() => {
        // Clear the single-flight slot whether we succeeded or failed, so the
        // next request is free to try again.
        connectPromise = null;
      });
  }

  return connectPromise;
}

/**
 * Gets (or lazily creates) the shared SQL Server connection pool.
 *
 * Prefer `withDb()` in route handlers — it adds the automatic single retry for
 * dropped connections. `getPool()` remains for callers that just need the pool.
 */
export async function getPool(): Promise<sql.ConnectionPool> {
  const handle = await acquirePooledConnection();
  return handle.pool;
}

/**
 * Tears down the current pool so the next caller builds a fresh one.
 *
 * @param generation - Optional. When supplied, the reset is IGNORED unless that
 *   generation is still the live pool. Callers should always pass the
 *   generation they actually used, so a slow/late failure cannot destroy a pool
 *   that was created after it. Calling with no argument forces an
 *   unconditional reset (used at shutdown and by tests).
 *
 * Safe to call concurrently: `current` is cleared *before* the await, so a
 * second concurrent caller sees null and returns immediately.
 */
export async function resetPool(generation?: number): Promise<void> {
  const handle = current;
  if (!handle) return;

  if (generation !== undefined && generation !== handle.generation) {
    logInfo(
      `Ignoring stale pool reset for generation ${generation}; the live pool is generation ${handle.generation}.`
    );
    return;
  }

  // Detach before awaiting so concurrent resetPool() calls become no-ops.
  current = null;
  handle.healthy = false;

  logInfo(`Closing SQL connection pool (generation ${handle.generation}).`);
  try {
    await handle.pool.close();
  } catch {
    // The old pool may already be dead or half-open; ignore cleanup failures
    // and let the next request build a fresh one.
  }
}

/**
 * Runs `fn` against the shared pool, with exactly one automatic retry when — and
 * only when — the failure was a connection-level error.
 *
 * This is the function every route handler should use:
 *
 *   const rows = await withDb(async (db) => {
 *     const result = await db.request().query('SELECT ...');
 *     return result.recordset;
 *   });
 *
 * Why "connection-class errors only"? Because the previous code called
 * `resetPool()` in every catch block. A constraint violation or a too-long
 * string would nuke the shared pool and break every other request in flight.
 * Ordinary query errors now propagate on the first throw, untouched.
 */
export async function withDb<T>(fn: (db: sql.ConnectionPool) => Promise<T>): Promise<T> {
  const handle = await acquirePooledConnection();

  try {
    return await fn(handle.pool);
  } catch (err) {
    if (!isConnectionError(err)) {
      // Not a connection problem — leave the pool alone and let the route's
      // catch block decide on the HTTP status.
      throw err;
    }

    logWarn(
      `Database call failed with a connection-level error on pool generation ${handle.generation}; rebuilding the pool and retrying once.`
    );

    // Generation-guarded: only kills the pool we actually used.
    await resetPool(handle.generation);

    const retryHandle = await acquirePooledConnection();
    return await fn(retryHandle.pool);
  }
}
