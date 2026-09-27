/**
 * routes/error-handler.ts — the app-wide Express error handler.
 *
 * This is the last middleware server.ts mounts, and it catches anything that
 * reached `next(err)` without a route dealing with it. In practice that means
 * errors raised by MIDDLEWARE rather than by handlers, because every route
 * module funnels its own failures through sendDbError().
 *
 * ------------------------------------------------------------------
 * THE BUG THIS FILE FIXES: an oversized upload reported 500, not 413
 * ------------------------------------------------------------------
 * The handler used to be four lines that ended in an unconditional
 * `res.status(500).json({ error: 'Internal server error' })`.
 *
 * That threw away information the error was already carrying. `express.json()`
 * is configured with `limit: '50mb'`, and when a request body exceeds it
 * body-parser rejects the request with a PayloadTooLargeError that already has
 * `status: 413` and `type: 'entity.too.large'` set on it. The old handler
 * ignored both and reported "Internal server error".
 *
 * During a batch photo import that was actively misleading: the real problem is
 * "that batch of images is too big, send fewer at a time", which the user can
 * act on immediately — but what they saw was a generic server error, which
 * suggests the server is broken and there is nothing to be done. Someone
 * debugging that goes looking in entirely the wrong place.
 *
 * So the handler now honours `err.status` when the error supplies a sensible
 * one, and gives the 413 case a message that names the actual problem.
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
 * Works out the HTTP status to report for an unhandled error.
 *
 * Only a valid client-or-server status in the 400-599 range is trusted. Errors
 * from unrelated libraries sometimes carry a `status` field meaning something
 * entirely different (a process exit code, an enum value, a plain 0), and
 * `res.status()` throws on a value outside the HTTP range — which, inside the
 * error handler itself, would leave the request hanging with no response at
 * all. Anything we do not recognise falls back to 500.
 *
 * `statusCode` is checked as well as `status` because http-errors sets both and
 * some libraries set only one.
 *
 * Exported separately from the middleware so it can be unit-tested directly.
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
 * Works out the client-facing message for an unhandled error.
 *
 * The 413 case gets a specific, actionable message. Everything else keeps the
 * deliberately vague 'Internal server error': an unexpected error's message can
 * contain connection strings, file paths or SQL text, and none of that belongs
 * in a response body. The full error is always written to app.log by the
 * middleware below, which is where the detail should be read from.
 */
export function errorMessageFor(err: unknown, status: number): string {
  if (status === 413) {
    // body-parser's own message is "request entity too large", which does not
    // tell the user what to do about it. This one does.
    return 'The upload is too large for the server to accept (the limit is 50 MB per request). Try adding fewer images at a time.';
  }

  return 'Internal server error';
}

/**
 * The Express error-handling middleware itself.
 *
 * Express identifies error handlers by their FOUR-parameter signature, so
 * `_next` must stay in the list even though it is unused — removing it turns
 * this silently into an ordinary middleware that never runs.
 */
export function globalErrorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logError('Unhandled error', err);

  // If a response is already on the wire (a stream that failed halfway, say)
  // there is nothing left to say to the client; the log line above is the
  // whole of what we can do.
  if (res.headersSent) return;

  const status = errorStatusFor(err);
  res.status(status).json({ error: errorMessageFor(err, status) });
}
