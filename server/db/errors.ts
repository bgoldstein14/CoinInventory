/**
 * Classifies errors thrown by the database layer:
 *
 *   isConnectionError(err)  is the handle broken (reopen it) or was it just a
 *                           bad query? Used by db/pool.ts.
 *   sqlErrorNumber(err)     the SQL Server error number, which
 *                           routes/db-error-response.ts maps to 409 / 400 / 500.
 *
 * db/sql-api.ts translates SQLite codes into those SQL Server numbers.
 */

/**
 * SQLite result codes that mean "this database handle is not usable", as
 * opposed to "that statement was wrong".
 *
 * Primary codes; extended codes are masked down to their low byte, so
 * e.g. SQLITE_IOERR_READ (266) matches 10.
 *
 *   5  SQLITE_BUSY      the file is locked by someone else and stayed locked
 *   6  SQLITE_LOCKED    a table in this connection is locked
 *   10 SQLITE_IOERR     the disk said no
 *   11 SQLITE_CORRUPT   the file is damaged
 *   14 SQLITE_CANTOPEN  could not open the file at all
 *   26 SQLITE_NOTADB    the file is not a database (or is encrypted)
 *
 * SQLITE_READONLY (8) is excluded: reopening a read-only file doesn't help.
 */
const CONNECTION_RESULT_CODES = new Set([5, 6, 10, 11, 14, 26]);

/**
 * Node-level codes that mean the handle is gone. `ERR_INVALID_STATE` is what
 * `node:sqlite` raises when a method is called on a closed database.
 */
const CONNECTION_ERROR_CODES = new Set(['ERR_INVALID_STATE', 'ERR_SQLITE_DATABASE_CLOSED']);

/** Message patterns that indicate a dead handle even when no code is set. Kept narrow. */
const CONNECTION_ERROR_MESSAGE_PATTERN =
  /database (?:connection )?is (?:not open|closed)|database is locked|unable to open database|disk i\/o error/i;

/**
 * True when `err` is a handle-level failure rather than a query problem.
 * Conservative: a false positive reopens the database and reruns the caller's
 * writes, so when in doubt it returns false.
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

  // 3. A SQL Server error number means a query problem. Checked before the
  //    message pattern so a constraint error mentioning a lock isn't misread.
  if (typeof (err as { number?: unknown }).number === 'number') return false;

  // 4. Last resort: a recognisable message.
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (message && CONNECTION_ERROR_MESSAGE_PATTERN.test(message)) {
    return true;
  }

  return false;
}

/**
 * The SQL Server error number on an error, if any (set by db/sql-api.ts and
 * db/bind-values.ts). Also checks `originalError` for re-wrapped errors.
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
