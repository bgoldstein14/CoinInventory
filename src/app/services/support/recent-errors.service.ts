import { Injectable, signal } from '@angular/core';

/**
 * A short in-memory list of errors the user saw in the browser (failed saves,
 * caught exceptions, error toasts), for "Report a problem". Separate from the
 * server log because many of these never reach the backend, e.g. while it is
 * unreachable. Capped, with immediate repeats collapsed into a count. Nothing
 * is sent from here; the buffer is read only when the user opens the report.
 */

/** One error, as the report will present it. */
export interface RecordedError {
  timestamp: string;
  message: string;
  details?: string;
  /** How many times in a row this error occurred; absent means once. */
  repeats?: number;
}

/** Distinct errors kept; more than the report shows (20), to absorb bursts. */
export const RECENT_ERROR_LIMIT = 50;

@Injectable({ providedIn: 'root' })
export class RecentErrorsService {
  /** Oldest first. */
  readonly errors = signal<RecordedError[]>([]);

  /** Records an error. Never throws or logs: it is called from GlobalErrorHandler. */
  record(message: string, details?: string): void {
    const text = (message ?? '').trim();
    if (text.length === 0) return;   // a blank row helps nobody

    const current = this.errors();
    const newest = current[current.length - 1];

    // Collapse only an immediate repeat: 'A B A' stays three entries.
    if (newest && newest.message === text && newest.details === details) {
      const collapsed: RecordedError = {
        ...newest,
        timestamp: new Date().toISOString(),
        repeats: (newest.repeats ?? 1) + 1
      };
      this.errors.set([...current.slice(0, -1), collapsed]);
      return;
    }

    const next = [...current, { timestamp: new Date().toISOString(), message: text, details }];
    this.errors.set(next.length > RECENT_ERROR_LIMIT ? next.slice(-RECENT_ERROR_LIMIT) : next);
  }

  clear(): void {
    this.errors.set([]);
  }

  /** A copy, so later records can't mutate a payload already in flight. */
  snapshot(): RecordedError[] {
    return this.errors().map(entry => ({ ...entry }));
  }
}
