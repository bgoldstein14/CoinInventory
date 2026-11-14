/**
 * db/errors.ts — classifying the errors the database driver throws at us.
 *
 * This file owns the two questions every error path in the backend has to ask:
 *
 *   1. `isConnectionError(err)` — "is the HANDLE broken, or was it just a bad
 *      query?" Only a broken handle justifies throwing the open database away
 *      and reopening it (see db/pool.ts).
 *   2. `sqlErrorNumber(err)`    — "which SQL Server error number is this?" The
 *      route error translator (routes/db-error-response.ts) uses it to answer
 *      409 Conflict vs 400 Bad Request vs 500.
 *
 * *** WHY A SQL SERVER ERROR NUMBER SURVIVES THE MOVE TO SQLITE. *** It would
 * have been tidier to invent a new vocabulary and rewrite
 * routes/db-error-response.ts to speak it. It would also have pushed this
 * migration into the HTTP layer and into every route spec that asserts on a
 * status code, for no behavioural gain: 2627 is just a name for "duplicate
 * key", and the one place that name is interpreted is well tested. So
 * db/sql-api.ts translates SQLite's codes into those numbers and the HTTP
 * layer is untouched. The translation table lives in db/sql-api.ts.
 *
 * Both functions here are pure, with no state and no I/O.
 */

/**
 * SQLite result codes that mean "this database handle is not usable", as
 * opposed to "that statement was wrong".
 *
 * These are PRIMARY result codes; SQLite also returns extended codes whose
 * low byte is the primary one (SQLITE_IOERR_READ is 266, and 266 & 0xFF is
 * 10). The check below masks, so every extended variant of an I/O error is
 * caught by the one entry.
 *
 *   5  SQLITE_BUSY      the file is locked by someone else and stayed locked
 *   6  SQLITE_LOCKED    a table in this connection is locked
 *   10 SQLITE_IOERR     the disk said no
 *   11 SQLITE_CORRUPT   the file is damaged
 *   14 SQLITE_CANTOPEN  could not open the file at all
 *   26 SQLITE_NOTADB    the file is not a database (or is encrypted)
 *
 * SQLITE_READONLY (8) is deliberately ABSENT. A read-only file is not a
 * transient fault: reopening it changes nothing, and retrying would turn one
 * clear failure into two. It surfaces as an ordinary error.
 */
const CONNECTION_RESULT_CODES = new Set([5, 6, 10, 11, 14, 26]);

/**
 * Node-level codes that mean the handle is gone. `ERR_INVALID_STATE` is what
 * `node:sqlite` raises when a method is called on a closed database.
 */
const CONNECTION_ERROR_CODES = new Set(['ERR_INVALID_STATE', 'ERR_SQLITE_DATABASE_CLOSED']);

/**
 * Message patterns that indicate a dead handle even when no code is set.
 * Deliberately narrow — see the "be conservative" note on isConnectionError().
 */
const CONNECTION_ERROR_MESSAGE_PATTERN =
  /database (?:connection )?is (?:not open|closed)|database is locked|unable to open database|disk i\/o error/i;

/**
 * Returns true when `err` looks like a HANDLE-level failure rather than a
 * problem with the query itself.
 *
 * Be conservative here on purpose. A false positive means we close a
 * perfectly good database and reopen it because of, say, a constraint
 * violation — and then RUN THE CALLER'S FUNCTION A SECOND TIME, which for a
 * write is a duplicate. When in doubt this function returns false.
 */
export function isConnectionError(err: unknown): boolean {
  if (err === null || err === undefined) return false;

  // 1. A SQLite result code, masked down to its primary value. Both the raw
  //    driver error and the DbQueryError that wraps it carry `errcode`.
  const errcode = (err as { errcode?: unknown }).errcode;
  if (typeof errcode === 'number' && CONNECTION_RESULT_CODES.has(errcode & 0xff)) {
    return true;
  }

  // 2. An explicit Node error code.
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }

  // 3. A SQL Server error NUMBER means the error was classified as a query
  //    problem by db/sql-api.ts. Never a connection error, and checked
  //    before the message pattern so a constraint violation whose text
  //    happens to mention a lock cannot be misread.
  if (typeof (err as { number?: unknown }).number === 'number') return false;

  // 4. Last resort: a recognisable message.
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (message && CONNECTION_ERROR_MESSAGE_PATTERN.test(message)) {
    return true;
  }

  return false;
}

/**
 * Pulls the SQL Server error number off an error, if it has one.
 *
 * Used by routes/db-error-response.ts to distinguish constraint violations
 * (409) from bad input (400) from genuine faults (500). db/sql-api.ts and
 * db/bind-values.ts are what put the number there; the `originalError`
 * fallback is kept because errors travelling through the route layer are
 * sometimes wrapped again.
 */
export function sqlErrorNumber(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;

  const direct = (err as { number?: unknown }).number;
  if (typeof direct === 'number') return direct;

  const original = (err as { originalError?: { info?: { number?: unknown }; number?: unknown } })
    .originalError;
  if (original) {
    if (typeof original.number === 'number') return original.number;
    if (original.info && typeof original.info.number === 'number') return original.info.number;
  }

  return undefined;
}
