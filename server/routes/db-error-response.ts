/**
 * Shared error -> HTTP status translation for the API routes:
 *
 *   } catch (err) {
 *     sendDbError(res, 'PUT /api/coins/:id', err, 'Failed to update coin');
 *   }
 *
 * Gives a sensible status and logs the error once. Never calls resetPool().
 */

import { Response } from 'express';
import { logError } from '../logger';
import { sqlErrorNumber } from '../db';
import { buildFailureReport, FailureReport, spokenMessage } from './failure-report';

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

/** mssql driver codes for parameters that fail validation before sending (400). */
const BAD_REQUEST_DRIVER_CODES = new Set(['EPARAM', 'EARGS']);

/** Thrown by a route that detects bad input inside a transaction (400). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/*
 * Response body. Besides `error` (the sentence to show, including any
 * reassurance), it carries `stage` (which part failed) and `detail` (one
 * technical line). See routes/failure-report.ts.
 */
export interface DbErrorBody {
  error: string;
  stage: FailureReport['stage'];
  detail: string;
}

/** Package a finished report as the HTTP body. */
function bodyFor(report: FailureReport): DbErrorBody {
  return { error: spokenMessage(report), stage: report.stage, detail: report.detail };
}

/** Extra facts the caller knows about the failure. All optional. */
export interface DbErrorOptions {
  /** Route label for the technical detail line, e.g. 'GET /api/coins'. */
  context?: string;
  /** The noun the delivery message names, e.g. 'coin list'. */
  subject?: string;
  /**
   * True only when the data was already in hand. Set by sendJson(); never
   * set it in a catch block that also covers the query.
   */
  retrieved?: boolean;
}

/** The HTTP status and body for a caught error. Exported for tests. */
export function classifyDbError(
  err: unknown,
  fallbackMessage: string,
  options: DbErrorOptions = {}
): { status: number; body: DbErrorBody } {
  const ctx = {
    context: options.context ?? 'the request',
    subject: options.subject ?? 'data',
    fallbackMessage,
    retrieved: options.retrieved,
  };

  // Delivery first, and only when the caller knows the data was retrieved;
  // the branches below infer from the error.
  if (options.retrieved) {
    return { status: 500, body: bodyFor(buildFailureReport(err, ctx)) };
  }

  // --- 400: the request itself was bad -----------------------------------
  if (err instanceof ValidationError) {
    return {
      status: 400,
      body: bodyFor({ stage: 'database', message: err.message, reassurance: null, detail: detailOf(err, ctx.context) }),
    };
  }

  const driverCode = (err as { code?: unknown } | null)?.code;
  if (typeof driverCode === 'string' && BAD_REQUEST_DRIVER_CODES.has(driverCode)) {
    return {
      status: 400,
      body: bodyFor({
        stage: 'database',
        message: 'One or more supplied values were invalid for this record.',
        reassurance: null,
        detail: detailOf(err, ctx.context),
      }),
    };
  }

  const errorNumber = sqlErrorNumber(err);
  if (errorNumber !== undefined && BAD_REQUEST_SQL_ERROR_NUMBERS.has(errorNumber)) {
    return {
      status: 400,
      body: bodyFor({
        stage: 'database',
        message: 'One or more values were invalid or too long for the field they were saved to.',
        reassurance: null,
        detail: detailOf(err, ctx.context),
      }),
    };
  }

  // --- 409: conflicts with data already in the database -------------------
  if (errorNumber !== undefined && CONFLICT_SQL_ERROR_NUMBERS.has(errorNumber)) {
    return {
      status: 409,
      body: bodyFor({
        stage: 'database',
        message: 'That record conflicts with existing data (duplicate or referenced elsewhere).',
        reassurance: null,
        detail: detailOf(err, ctx.context),
      }),
    };
  }

  // Everything else goes to the shared classifier, after the specific SQL
  // error numbers so a query error is never mistaken for a dead connection.
  const report = buildFailureReport(err, ctx);

  // 503 for an unreachable database; 500 otherwise (the body says whether
  // the user's data is involved).
  const status = report.stage === 'connection' ? 503 : 500;
  return { status, body: bodyFor(report) };
}

/** Shorthand for technicalDetail(). */
function detailOf(err: unknown, context: string): string {
  return buildFailureReport(err, { context, subject: 'data', fallbackMessage: '' }).detail;
}

/**
 * Logs the error and writes the classified response.
 *
 * @param res             - Express response.
 * @param context         - Human-readable route label used in the log line,
 *                          e.g. 'PUT /api/coins/:id'.
 * @param err             - The caught error.
 * @param fallbackMessage - Message used for the generic 500 case.
 * @param subject         - Noun phrase for what the caller was waiting for
 *                          ('coin list'); used only for delivery failures.
 * @param options         - Extra facts the caller knows; see DbErrorOptions.
 */
export function sendDbError(
  res: Response,
  context: string,
  err: unknown,
  fallbackMessage: string,
  subject?: string,
  options: Omit<DbErrorOptions, 'context' | 'subject'> = {}
): void {
  logError(`${context} error`, err);

  // A response already started; the log line is all we can do.
  if (res.headersSent) return;

  const { status, body } = classifyDbError(err, fallbackMessage, { ...options, context, subject });
  res.status(status).json(body);
}

/*
 * Sends JSON, attributing a failure to delivery rather than the database.
 * res.json() runs JSON.stringify synchronously and can throw on a large
 * payload; this wraps only the send, so anything it catches happened after
 * the data was retrieved. Use it for data read from the database; small
 * literals don't need it.
 */
export function sendJson(res: Response, context: string, payload: unknown, subject: string): void {
  try {
    res.json(payload);
  } catch (err) {
    // Nothing has been written yet, so an error response is still possible.
    sendDbError(res, context, err, `Failed to send the ${subject}`, subject, { retrieved: true });
  }
}
