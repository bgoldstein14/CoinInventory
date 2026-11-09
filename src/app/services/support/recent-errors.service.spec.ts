/**
 * recent-errors.service.spec.ts
 *
 * ---- WHY A RING BUFFER AND NOT "READ THE LOG" ----
 * The owner's requirement names "recent errors" separately from "the log",
 * and they are genuinely different things. The log is what the SERVER saw.
 * This is what the USER saw: the toasts, the failed saves, the unhandled
 * exceptions Angular caught. Plenty of those never reach the backend at all
 * — LoggingService deliberately backs off for thirty seconds after a failed
 * POST, and the most interesting errors are exactly the ones that happen
 * when the backend is unreachable.
 *
 * So the browser keeps its own short tail. Capped, because this runs for the
 * whole session and an unbounded array in a long-lived desktop app is a
 * memory leak with extra steps.
 */

import { describe, it, expect } from 'vitest';

import { RECENT_ERROR_LIMIT, RecentErrorsService } from './recent-errors.service';

describe('RecentErrorsService', () => {
  it('starts empty', () => {
    expect(new RecentErrorsService().snapshot()).toEqual([]);
  });

  it('records a message with a timestamp', () => {
    const service = new RecentErrorsService();
    service.record('saving the coin failed');

    const [entry] = service.snapshot();
    expect(entry.message).toBe('saving the coin failed');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps details when they are given', () => {
    const service = new RecentErrorsService();
    service.record('save failed', '500 Internal Server Error');
    expect(service.snapshot()[0].details).toBe('500 Internal Server Error');
  });

  it('keeps them oldest first, which is the order the report wants', () => {
    const service = new RecentErrorsService();
    service.record('first');
    service.record('second');
    expect(service.snapshot().map(e => e.message)).toEqual(['first', 'second']);
  });

  /**
   * A retry loop or a broken render can throw the same error hundreds of
   * times a second. Without collapsing, the ring buffer fills with one
   * message and every other error the user saw is pushed out — losing
   * exactly the context that makes the report useful.
   */
  it('collapses an immediately repeated error into a count', () => {
    const service = new RecentErrorsService();
    service.record('connection lost');
    service.record('connection lost');
    service.record('connection lost');

    const entries = service.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0].repeats).toBe(3);
  });

  it('does not collapse a repeat that is not the most recent entry', () => {
    const service = new RecentErrorsService();
    service.record('A');
    service.record('B');
    service.record('A');
    expect(service.snapshot().map(e => e.message)).toEqual(['A', 'B', 'A']);
  });

  it('caps the buffer, dropping the oldest', () => {
    const service = new RecentErrorsService();
    for (let i = 0; i < RECENT_ERROR_LIMIT + 10; i++) service.record(`error ${i}`);

    const entries = service.snapshot();
    expect(entries).toHaveLength(RECENT_ERROR_LIMIT);
    expect(entries[0].message).toBe(`error 10`);
    expect(entries[entries.length - 1].message).toBe(`error ${RECENT_ERROR_LIMIT + 9}`);
  });

  it('ignores an empty message rather than recording a blank row', () => {
    const service = new RecentErrorsService();
    service.record('');
    service.record('   ');
    expect(service.snapshot()).toEqual([]);
  });

  it('can be cleared', () => {
    const service = new RecentErrorsService();
    service.record('x');
    service.clear();
    expect(service.snapshot()).toEqual([]);
  });

  it('exposes a signal so the dialog can show a live count', () => {
    const service = new RecentErrorsService();
    expect(service.errors()).toEqual([]);
    service.record('x');
    expect(service.errors()).toHaveLength(1);
  });

  /**
   * The snapshot is handed to JSON.stringify and posted. Returning the live
   * array would let a later record() mutate a payload that is already in
   * flight — and would let a caller mutate the service's state by accident.
   */
  it('returns a copy, not the live array', () => {
    const service = new RecentErrorsService();
    service.record('x');
    const snapshot = service.snapshot();
    snapshot.push({ timestamp: 'now', message: 'injected' });
    expect(service.snapshot()).toHaveLength(1);
  });
});
