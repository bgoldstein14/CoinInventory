/**
 * Shared error -> HTTP status translation for the API route modules.
 *
 * A blanket 500 from every catch block leaves the Angular app unable to tell
 * "you typed something invalid" apart from "the database is on fire". Routes
 * instead do:
 *
 *   } catch (err) {
 *     sendDbError(res, 'PUT /api/coins/:id', err, 'Failed to update coin');
 *   }
 *
 * and get a sensible status code with the error logged exactly once. Nothing
 * here calls resetPool() — see db/index.ts for why that matters.
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

/*
 * A single `error` string cannot carry both "what happened" and "what it
 * means for your collection" (see routes/failure-report.ts). The body
 * therefore also carries:
 *
 *   stage   'connection' | 'database' | 'delivery' — WHICH part failed
 *   detail  one technical line, for whoever wants it (not shouted at the user)
 *   error   the sentence to show. For a delivery failure it is the headline
 *           PLUS the reassurance, so a client that reads nothing but `error`
 *           still gets the honest answer.
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

/**
 * What the caller knows about the failure beyond the error object itself.
 * All optional: a route that passes nothing behaves exactly as before.
 */
export interface DbErrorOptions {
  /** Route label for the technical detail line, e.g. 'GET /api/coins'. */
  context?: string;
  /** The noun the delivery message names, e.g. 'coin list'. */
  subject?: string;
  /**
   * TRUE ONLY WHEN THE DATA WAS ALREADY IN HAND. Set by sendJson(), which
   * wraps nothing but the `res.json()` call, so anything it catches happened
   * after a successful read by construction. Never set this by hand in a
   * catch block that also covers the query.
   */
  retrieved?: boolean;
}

/**
 * Works out the right HTTP status + client-facing body for a caught error.
 * Exported separately from sendDbError so it can be unit-tested directly.
 */
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

  // DELIVERY FIRST, and only when the caller positively knows the data was
  // retrieved. Everything below this point GUESSES from properties of the
  // error; this branch does not have to guess, so it must not fall through
  // into a guess that contradicts it.
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

  // Everything else goes to the shared classifier. It is reached AFTER the
  // specific SQL error numbers above, so a genuine query error is never
  // mistaken for a dead connection; keep that ordering.
  const report = buildFailureReport(err, ctx);

  // 503 for an unreachable database; 500 for a database fault or a response
  // we could not build. A delivery failure is a 500 because it IS the
  // server's fault — but the body says whose, and that the user's data is not
  // involved.
  const status = report.stage === 'connection' ? 503 : 500;
  return { status, body: bodyFor(report) };
}

/** Local alias so the branches above stay readable. */
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
 * @param subject         - Noun phrase for the thing the caller was waiting
 *                          for ('coin list', 'coin', 'transaction list'). Only
 *                          read when the failure turns out to be a delivery
 *                          one, which is the one case where the message has to
 *                          name it.
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

  // If the handler already started streaming a response there is nothing
  // useful we can do beyond the log line above.
  if (res.headersSent) return;

  const { status, body } = classifyDbError(err, fallbackMessage, { ...options, context, subject });
  res.status(status).json(body);
}

/*
 * sendJson — the "did the query fail, or only the send?" distinction made
 * structural rather than guessed.
 *
 * `res.json(payload)` runs JSON.stringify SYNCHRONOUSLY and can throw
 * (`RangeError: Invalid string length` on a large enough payload). A try
 * block wrapping both the query and the send cannot tell those apart, and
 * blames the database. This helper wraps NOTHING BUT the send, so anything it
 * catches provably happened after the data was in hand — which is why it may
 * pass `retrieved: true` and tell the user their data is safe.
 *
 * Use it in every handler that serialises data read out of the database.
 * Handlers that send a small literal (`{ success: true }`, a 404 body) do not
 * need it: those cannot fail to serialise.
 */
export function sendJson(res: Response, context: string, payload: unknown, subject: string): void {
  try {
    res.json(payload);
  } catch (err) {
    // Express builds the whole string before touching the socket, so nothing
    // has been written yet and a proper error response is still possible.
    sendDbError(res, context, err, `Failed to send the ${subject}`, subject, { retrieved: true });
  }
}
