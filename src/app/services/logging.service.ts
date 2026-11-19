import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LogEntry } from '../types/coin.model';
// From http-utils, not api.service, to keep HttpClient out of this module's
// import graph (breaks unit tests without the JIT compiler).
import { describeHttpError, resolveApiBaseUrl } from './http-utils';

/**
 * Centralised logging: every entry goes to the browser console and is also
 * posted to the backend, which writes it to server/logs/app.log.
 */
@Injectable({ providedIn: 'root' })
export class LoggingService {
  // Constructor injection so tests can use `new LoggingService(mockHttp)`
  // without an injection context.
  constructor(private http: HttpClient) {}

  /**
   * Absolute API base URL: under `ng serve` a relative '/api/log' would hit the
   * dev server on port 4200, which has no such route.
   */
  private readonly baseUrl = resolveApiBaseUrl();

  /**
   * Timestamp (ms) before which backend posts are skipped after a failure.
   * A temporary backoff rather than a permanent off switch, so one transient
   * failure doesn't disable backend logging for the session.
   */
  private suppressBackendUntil = 0;

  /** How long to back off after a failed log POST. */
  private static readonly BACKOFF_MS = 30_000;

  /** Recursion guard: a failing send must never trigger another send. */
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
    // Console always, as the fallback when the backend is unreachable.
    const consoleMsg = details ? `[${level}] ${message} | ${details}` : `[${level}] ${message}`;

    if (level === 'ERROR') {
      console.error(consoleMsg);
    } else if (level === 'WARN') {
      console.warn(consoleMsg);
    } else {
      console.log(consoleMsg);
    }

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
      // HTTP observables are cold; subscribe() triggers the request.
      this.http.post(`${this.baseUrl}/api/log`, logEntry).subscribe({
        next: () => {
          this.suppressBackendUntil = 0;
        },
        error: (err) => {
          // Console-only here: calling this.error() would recurse.
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
