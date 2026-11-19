/**
 * Last-resort process handlers, so an unhandled rejection or uncaught
 * exception is logged to app.log instead of ending the process silently.
 * A diagnostic backstop, not a substitute for handling errors.
 */

import { logError } from './logger';

/** Registers the process-level handlers. Called once from server.ts at module load. */
export function installProcessSafetyNet(): void {
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    // Log a promise rejection that had no catch handler.
    logError('UNHANDLED PROMISE REJECTION — a promise rejected with no catch handler', reason);
    void promise;
  });

  process.on('uncaughtException', (err: Error) => {
    // Log it and keep running, so the session survives with a record of what happened.
    logError('UNCAUGHT EXCEPTION — the server is staying up; please report this log entry', err);
  });
}
