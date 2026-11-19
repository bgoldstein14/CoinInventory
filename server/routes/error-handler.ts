/**
 * The app-wide Express error handler, mounted last. Catches errors that reach
 * next(err), mostly from middleware (routes use sendDbError()).
 *
 * It honours an error's own status, notably body-parser's 413 when a request
 * exceeds the 50 MB limit, so a batch image import gets an actionable message
 * instead of a generic 500.
 */

import { Request, Response, NextFunction } from 'express';
import { logError } from '../logger';

/** Shape of the extra fields Express/body-parser attach to their errors. */
interface HttpishError {
  status?: unknown;
  statusCode?: unknown;
  type?: unknown;
  message?: unknown;
}

/**
 * The status for an unhandled error. Only `status`/`statusCode` values in
 * 400-599 are trusted (other libraries use these fields for other things, and
 * res.status() throws on out-of-range values); otherwise 500.
 */
export function errorStatusFor(err: unknown): number {
  const candidate = err as HttpishError | null;
  const raw = candidate?.status ?? candidate?.statusCode;

  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw <= 599) {
    return raw;
  }

  return 500;
}

/**
 * The client-facing message. 413 gets an actionable message; everything else
 * gets 'Internal server error', since error text can contain paths or SQL.
 * The full error is in app.log.
 */
export function errorMessageFor(err: unknown, status: number): string {
  if (status === 413) {
    return 'The upload is too large for the server to accept (the limit is 50 MB per request). Try adding fewer images at a time.';
  }

  return 'Internal server error';
}

/**
 * The error-handling middleware. Express recognises error handlers by their
 * four parameters, so `_next` must stay.
 */
export function globalErrorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logError('Unhandled error', err);

  // Response already started; the log line is all we can do.
  if (res.headersSent) return;

  const status = errorStatusFor(err);
  res.status(status).json({ error: errorMessageFor(err, status) });
}
