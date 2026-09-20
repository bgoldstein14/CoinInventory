/**
 * db/errors.ts — classifying the errors the database driver throws at us.
 *
 * This file owns the two questions every error path in the backend has to ask:
 *
 *   1. `isConnectionError(err)` — "is the *connection* broken, or was it just a
 *      bad query?" Only a broken connection justifies throwing the shared pool
 *      away and rebuilding it (see db/pool.ts).
 *   2. `sqlErrorNumber(err)`    — "which SQL Server error number is this?" The
 *      route error translator (routes/db-error-response.ts) uses it to answer
 *      409 Conflict vs 400 Bad Request vs 500.
 *
 * Both are pure functions with no state and no I/O, which is why they live on
 * their own: they are the easiest part of the database layer to reason about
 * and to unit test.
 */

import sql from 'mssql';

/**
 * mssql / tedious error codes that mean "the connection itself is broken".
 * These are the only errors for which it is safe (and useful) to throw the pool
 * away and reconnect.
 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNCLOSED',       // pool/connection was closed underneath us
  'ESOCKET',           // TCP socket error
  'ETIMEOUT',          // connect or request timed out
  'ECONNRESET',        // server reset the TCP connection
  'ENOTOPEN',          // tried to use a connection that was never opened
  'ELOGIN',            // login failed (often SQL Server restarting)
  'EALREADYCONNECTED', // pool state confusion after a half-open connection
  'ENOTFOUND',         // DNS / host lookup failure
]);

/**
 * Message patterns that indicate a dead connection even when no code is set.
 * Deliberately narrow — see the "be conservative" note on isConnectionError().
 */
const CONNECTION_ERROR_MESSAGE_PATTERN = /connection is closed|connection lost|not connected|socket hang up/i;

/**
 * Returns true when `err` looks like a *connection-level* failure rather than a
 * problem with the query itself.
 *
 * Be conservative here on purpose. A false positive means we destroy a perfectly
 * healthy pool (and break every other in-flight request) because of, say, a
 * constraint violation. When in doubt this function returns false.
 */
export function isConnectionError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  // 1. Explicit mssql/tedious error code.
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }

  // 2. mssql's dedicated ConnectionError class.
  //    Guarded with a typeof check because unit-test mocks of the `mssql`
  //    module do not always provide this class.
  const ConnectionErrorClass = (sql as unknown as {
    ConnectionError?: new (...args: never[]) => Error;
  }).ConnectionError;
  if (typeof ConnectionErrorClass === 'function' && err instanceof ConnectionErrorClass) {
    return true;
  }

  // 3. Last resort: a recognisable message.
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (message && CONNECTION_ERROR_MESSAGE_PATTERN.test(message)) {
    return true;
  }

  return false;
}

/**
 * Pulls the SQL Server error number off an mssql RequestError, if present.
 * Used by the route modules to distinguish constraint violations (409) from
 * genuine server faults (500).
 */
export function sqlErrorNumber(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;

  const direct = (err as { number?: unknown }).number;
  if (typeof direct === 'number') return direct;

  // Some driver paths nest the real SQL Server message one level down.
  const original = (err as { originalError?: { info?: { number?: unknown }; number?: unknown } }).originalError;
  if (original) {
    if (typeof original.number === 'number') return original.number;
    if (original.info && typeof original.info.number === 'number') return original.info.number;
  }

  return undefined;
}
