/**
 * process-safety.ts — the last-resort diagnostic backstop for the whole
 * Node process.
 *
 * An uncaught exception raised deep inside the mssql/tedious socket callbacks
 * kills the process without ever reaching the logger: app.log simply stops
 * mid-session with no error line, which is invisible for weeks. The handlers
 * installed here make sure that cannot happen silently.
 *
 * They are a diagnostic backstop, NOT a licence to stop handling errors
 * properly — the actual guard against that crash is the pool 'error' listener
 * in db/pool.ts.
 */

import { logError } from './logger';

/**
 * Registers the two process-level handlers.
 *
 * Called once from server.ts at module load, so they are active for the whole
 * lifetime of the process (including during tests).
 */
export function installProcessSafetyNet(): void {
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    // A promise rejected and nobody attached a .catch(). Node would normally
    // print a warning (or, in newer Node versions, terminate). Log it in full.
    logError('UNHANDLED PROMISE REJECTION — a promise rejected with no catch handler', reason);
    // Keep a reference in the log so it is obvious which promise was involved.
    void promise;
  });

  process.on('uncaughtException', (err: Error) => {
    // Something threw outside any try/catch, which would otherwise kill the
    // server. Log the full message + stack and deliberately KEEP RUNNING, so
    // the user's session survives and there is a record of what happened.
    logError('UNCAUGHT EXCEPTION — the server is staying up; please report this log entry', err);
  });
}
