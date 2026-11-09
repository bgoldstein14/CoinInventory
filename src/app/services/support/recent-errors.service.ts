import { Injectable, signal } from '@angular/core';

/**
 * RecentErrorsService — a short tail of the errors the USER actually saw.
 *
 * ---- WHY THIS IS NOT "JUST READ THE LOG" ----
 * "Recent errors" and "the log" are different things:
 *
 *   the log      what the SERVER saw, in server/logs/
 *   this buffer  what the BROWSER saw — failed saves, caught exceptions,
 *                the red toasts
 *
 * Plenty of the second never reaches the first. LoggingService deliberately
 * stops POSTing for thirty seconds after a failed send (see its header), and
 * the backend being unreachable is precisely when the interesting errors
 * happen. A report built only from the server log would be missing the half
 * the user is complaining about.
 *
 * ---- WHY IT IS CAPPED, AND WHY REPEATS COLLAPSE ----
 * A desktop app session can last for days, so an unbounded array here is a
 * memory leak. And a retry loop or a broken render can throw the same error
 * hundreds of times a second — without collapsing, the buffer fills with one
 * message and every other error the user saw is pushed out, which loses
 * exactly the context the report exists to carry.
 *
 * ---- NOTHING IS SENT FROM HERE ----
 * This only remembers. The buffer is read when, and only when, the user
 * opens "Report a problem" — it is never transmitted on its own.
 */

/** One error, as the report will present it. */
export interface RecordedError {
  timestamp: string;
  message: string;
  details?: string;
  /** How many times in a row this same error occurred. Absent means once. */
  repeats?: number;
}

/**
 * How many distinct errors are kept.
 *
 * Fifty is comfortably more than the report shows (twenty), which means the
 * buffer can absorb a burst and still have the earlier, more interesting
 * entries in it when the user gets round to pressing the button.
 */
export const RECENT_ERROR_LIMIT = 50;

@Injectable({ providedIn: 'root' })
export class RecentErrorsService {
  /**
   * Oldest first — the order the report renders from, and the natural order
   * for "what happened, in sequence".
   *
   * A signal so a future UI can show "3 recent errors" on the Help button
   * without polling.
   */
  readonly errors = signal<RecordedError[]>([]);

  /**
   * Remember an error.
   *
   * Never throws and never logs: this is called from GlobalErrorHandler,
   * i.e. from inside the thing that handles failures. A failure here would
   * be a failure handling a failure.
   */
  record(message: string, details?: string): void {
    const text = (message ?? '').trim();
    if (text.length === 0) return;   // a blank row helps nobody

    const current = this.errors();
    const newest = current[current.length - 1];

    // Collapse an immediate repeat rather than appending. Only the MOST
    // RECENT entry is considered: 'A B A' is three separate things that
    // happened and the report should say so.
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

  /**
   * A COPY, for sending.
   *
   * Returning the live array would let a later record() mutate a payload
   * that is already in flight, and would let any caller edit the service's
   * state by accident.
   */
  snapshot(): RecordedError[] {
    return this.errors().map(entry => ({ ...entry }));
  }
}
