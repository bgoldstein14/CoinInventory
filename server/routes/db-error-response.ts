/**
 * Shared error -> HTTP status translation for the API route modules.
 *
 * Previously every route catch block did the same two things: call
 * `resetPool()` (which destroyed the shared pool for the whole process — see
 * the long comment at the top of db.ts) and return a blanket 500. That meant
 * the Angular app could not tell "you typed something invalid" apart from
 * "the database is on fire", and one bad request poisoned every other one.
 *
 * This helper replaces that. Routes now do:
 *
 *   } catch (err) {
 *     sendDbError(res, 'PUT /api/coins/:id', err, 'Failed to update coin');
 *   }
 *
 * and get a sensible status code with the error logged exactly once.
 */

import { Response } from 'express';
import { logError } from '../logger';
import { isConnectionError, sqlErrorNumber } from '../db';

/**
 * SQL Server error numbers that mean "your data conflicts with an existing
 * row" -> HTTP 409 Conflict.
 *   2627 = violation of PRIMARY KEY / UNIQUE constraint
 *   2601 = cannot insert duplicate key row in a unique index
 *    547 = FOREIGN KEY / CHECK constraint violation
 */
const CONFLICT_SQL_ERROR_NUMBERS = new Set([2627, 2601, 547]);

/**
 * SQL Server error numbers that really mean "the caller sent bad data"
 * -> HTTP 400 Bad Request.
 *   8152 / 2628 = string or binary data would be truncated (value too long
 *                 for its NVarChar column — the classic "notes field too big")
 *    245        = conversion failed when converting a value to its data type
 *    241        = conversion failed when converting date and/or time
 *    8114       = error converting data type
 */
const BAD_REQUEST_SQL_ERROR_NUMBERS = new Set([8152, 2628, 245, 241, 8114]);

/**
 * mssql driver codes raised when the *parameters* we were handed fail
 * validation before the query is even sent. Also a 400.
 */
const BAD_REQUEST_DRIVER_CODES = new Set(['EPARAM', 'EARGS']);

/**
 * A route can throw this when it detects a validation problem inside a
 * transaction (where an early `res.status(400)` + `return` is awkward).
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Works out the right HTTP status + client-facing message for a caught error.
 * Exported separately from sendDbError so it can be unit-tested directly.
 */
export function classifyDbError(
  err: unknown,
  fallbackMessage: string
): { status: number; body: { error: string } } {
  // --- 400: the request itself was bad -----------------------------------
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: err.message } };
  }

  const driverCode = (err as { code?: unknown } | null)?.code;
  if (typeof driverCode === 'string' && BAD_REQUEST_DRIVER_CODES.has(driverCode)) {
    return { status: 400, body: { error: 'One or more supplied values were invalid for this record.' } };
  }

  const errorNumber = sqlErrorNumber(err);
  if (errorNumber !== undefined && BAD_REQUEST_SQL_ERROR_NUMBERS.has(errorNumber)) {
    return {
      status: 400,
      body: { error: 'One or more values were invalid or too long for the field they were saved to.' },
    };
  }

  // --- 409: conflicts with data already in the database -------------------
  if (errorNumber !== undefined && CONFLICT_SQL_ERROR_NUMBERS.has(errorNumber)) {
    return {
      status: 409,
      body: { error: 'That record conflicts with existing data (duplicate or referenced elsewhere).' },
    };
  }

  // --- 503: the database is unreachable -----------------------------------
  // Checked AFTER the specific SQL error numbers so a genuine query error is
  // never mistaken for a dead connection.
  if (isConnectionError(err)) {
    return {
      status: 503,
      body: { error: 'The database is currently unreachable. Please try again in a moment.' },
    };
  }

  // --- 500: anything else --------------------------------------------------
  return { status: 500, body: { error: fallbackMessage } };
}

/**
 * Logs the error and writes the classified response.
 *
 * @param res             - Express response.
 * @param context         - Human-readable route label used in the log line,
 *                          e.g. 'PUT /api/coins/:id'.
 * @param err             - The caught error.
 * @param fallbackMessage - Message used for the generic 500 case.
 */
export function sendDbError(res: Response, context: string, err: unknown, fallbackMessage: string): void {
  logError(`${context} error`, err);

  // If the handler already started streaming a response there is nothing
  // useful we can do beyond the log line above.
  if (res.headersSent) return;

  const { status, body } = classifyDbError(err, fallbackMessage);
  res.status(status).json(body);
}
