import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LogEntry } from '../types/coin.model';
// Imported from './http-utils', NOT from './api.service'. Importing these
// helpers from api.service would pull the ApiService class -- and through it
// Angular's HttpClient/XHR backend -- into this module's graph, which breaks
// unit tests that do not bootstrap the JIT compiler.
import { describeHttpError, resolveApiBaseUrl } from './http-utils';

/**
 * Centralised logging.
 *
 * Every log line goes to the browser console immediately, and is also sent
 * to the backend so it lands in server/logs/app.log alongside the server's
 * own entries. Having both halves of the story in one file is what makes
 * it possible to debug "the save failed" reports after the fact.
 */
@Injectable({ providedIn: 'root' })
export class LoggingService {
  // Constructor injection (deliberately NOT inject()) so that tests can
  // create the service directly with `new LoggingService(mockHttpClient)`
  // without standing up an Angular injection context -- doing so would
  // resolve the real HttpClient and drag in the XHR backend.
  constructor(private http: HttpClient) {}

  /**
   * ABSOLUTE base URL for the API, never a relative '/api/log'. In
   * development the app is served by `ng serve` on port 4200, so a relative
   * URL posts to the Angular dev server — which has no /api/log route — and
   * frontend logs are silently dropped in exactly the setup most debugging
   * happens in. `resolveApiBaseUrl()` is shared with ApiService so both
   * agree on where the backend lives.
   */
  private readonly baseUrl = resolveApiBaseUrl();

  /**
   * When the backend log endpoint fails we stop hammering it -- but only
   * TEMPORARILY. This holds the timestamp (ms) before which we will not
   * retry.
   *
   * Do not replace it with a latched `backendAvailable = false`: one
   * transient hiccup would then disable backend logging for the rest of the
   * session, and the moment something goes wrong is the moment the logs
   * matter most.
   */
  private suppressBackendUntil = 0;

  /** How long to back off after a failed log POST. */
  private static readonly BACKOFF_MS = 30_000;

  /**
   * Guards against infinite recursion. If sending a log entry fails and the
   * failure handler itself logs, we could loop forever. The handler below
   * only writes to the console, but this flag makes the guarantee explicit
   * and survives future edits.
   */
  private sending = false;

  info(message: string, details?: string): void {
    this.log('INFO', message, details);
  }

  warn(message: string, details?: string): void {
    this.log('WARN', message, details);
  }

  error(message: string, details?: string): void {
    this.log('ERROR', message, details);
  }

  private log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: string): void {
    // Console first, unconditionally. This must never be skipped -- it is
    // the fallback when the backend is unreachable.
    const consoleMsg = details ? `[${level}] ${message} | ${details}` : `[${level}] ${message}`;

    if (level === 'ERROR') {
      console.error(consoleMsg);
    } else if (level === 'WARN') {
      console.warn(consoleMsg);
    } else {
      console.log(consoleMsg);
    }

    // Skip the network call while we are backing off, or if we are already
    // inside a send (recursion guard).
    if (this.sending || Date.now() < this.suppressBackendUntil) {
      return;
    }

    const logEntry: Partial<LogEntry> = {
      level,
      message,
      details,
      source: 'frontend',
      timestamp: new Date().toISOString()
    };

    this.sending = true;
    try {
      // HTTP observables are cold -- without subscribe() nothing is sent.
      this.http.post(`${this.baseUrl}/api/log`, logEntry).subscribe({
        next: () => {
          // A success clears any outstanding backoff immediately.
          this.suppressBackendUntil = 0;
        },
        error: (err) => {
          // Back off for a while, then allow retries again. Deliberately
          // console-only: routing this through this.error() would recurse.
          this.suppressBackendUntil = Date.now() + LoggingService.BACKOFF_MS;
          console.warn(
            `[LoggingService] Backend logging unavailable (${describeHttpError(err)}); ` +
            `console only for the next ${LoggingService.BACKOFF_MS / 1000}s.`
          );
        }
      });
    } finally {
      this.sending = false;
    }
  }
}
