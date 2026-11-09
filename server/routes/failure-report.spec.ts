/*
 * routes/failure-report.spec.ts — "which kind of failure was that?"
 * THE BUG THESE TESTS EXIST FOR. A route that wraps everything in
 * `sendDbError(..., 'Failed to retrieve coins')` reports a database fault
 * even when the database handed over every row and it was `res.json()` that
 * threw, unable to BUILD the response string. That message sends whoever
 * reads it hunting a connection problem that does not exist.
 *
 * So there are three distinct failures hiding behind one message, and the
 * user must be able to tell them apart:
 *
 *   connection — we never reached the database. Nothing is known about the data.
 *   database   — the database answered, and the answer was an error.
 *   delivery   — the data came OUT of the database and we failed afterwards.
 *                This is the only one where we can promise the data is intact.
 *
 * Every assertion below is about that three-way split and about never
 * claiming the stronger thing than we know. It is the same rule that makes
 * `computeMeltValue` return null rather than $0.00, applied to status instead
 * of to numbers.
  */

import { describe, it, expect } from 'vitest';
import {
  buildFailureReport,
  failureStageFor,
  isSerialisationFailure,
  technicalDetail,
} from './failure-report';

/** The real thing, reproduced exactly: V8 refusing to build the string. */
function invalidStringLength(): RangeError {
  return new RangeError('Invalid string length');
}

describe('isSerialisationFailure', () => {
  it('recognises the RangeError thrown when a response exceeds the V8 maximum string length', () => {
    expect(isSerialisationFailure(invalidStringLength())).toBe(true);
  });

  it('recognises it from the message alone, whatever class it arrived as', () => {
    // Errors crossing a realm boundary lose their prototype; the message is
    // the only thing guaranteed to survive.
    expect(isSerialisationFailure(new Error('Invalid string length'))).toBe(true);
  });

  it("recognises Node's ERR_STRING_TOO_LONG code", () => {
    expect(
      isSerialisationFailure(Object.assign(new Error('boom'), { code: 'ERR_STRING_TOO_LONG' }))
    ).toBe(true);
  });

  it('recognises a circular structure, the other way JSON.stringify refuses', () => {
    expect(
      isSerialisationFailure(new TypeError('Converting circular structure to JSON'))
    ).toBe(true);
  });

  it('does NOT claim an ordinary query error is a serialisation failure', () => {
    // The cost of a false positive here is telling the user "your data is
    // safe and the database is working" when the database just told us it
    // is not. That is the original bug with its sign flipped, so this
    // function stays narrow.
    expect(isSerialisationFailure(new Error('Invalid column name Wibble'))).toBe(false);
    expect(isSerialisationFailure(new Error('Connection is closed.'))).toBe(false);
    expect(isSerialisationFailure(null)).toBe(false);
    expect(isSerialisationFailure(undefined)).toBe(false);
  });

  it('recognises a bare string, because logError hands those through too', () => {
    expect(isSerialisationFailure('Invalid string length')).toBe(true);
  });
});

describe('failureStageFor', () => {
  it('calls a dead connection a connection failure', () => {
    const dead = Object.assign(new Error('Connection is closed.'), { code: 'ECONNCLOSED' });
    expect(failureStageFor(dead)).toBe('connection');
  });

  it('calls an ordinary query error a database failure', () => {
    expect(failureStageFor(new Error('Invalid column name Wibble'))).toBe('database');
  });

  it('calls a serialisation error a delivery failure even with nothing else to go on', () => {
    // The sniffing path: a route that has not been split into "fetch" and
    // "send" still reports honestly, because the error itself says so.
    expect(failureStageFor(invalidStringLength())).toBe('delivery');
  });

  it('calls anything a delivery failure once the caller says the data was retrieved', () => {
    // The STRUCTURAL path, and the one that matters most: sendJson() only
    // ever catches throws from res.json(), which by definition happen after
    // the rows are in hand. No sniffing required or wanted.
    expect(failureStageFor(new Error('something exotic'), { retrieved: true })).toBe('delivery');
  });

  it('still says delivery when the data was retrieved and a connection error follows', () => {
    // "The rows came out of the database" is a fact that a later connection
    // blip cannot undo. Reporting 'connection' here would resurrect the lie.
    const dead = Object.assign(new Error('Connection is closed.'), { code: 'ECONNCLOSED' });
    expect(failureStageFor(dead, { retrieved: true })).toBe('delivery');
  });
});

describe('technicalDetail', () => {
  it('names the error class, its message and the route, on one line', () => {
    expect(technicalDetail(invalidStringLength(), 'GET /api/coins')).toBe(
      'RangeError: Invalid string length in GET /api/coins'
    );
  });

  it('copes with something that is not an Error at all', () => {
    expect(technicalDetail('kaboom', 'GET /api/coins')).toBe('kaboom in GET /api/coins');
  });
});

describe('buildFailureReport', () => {
  const base = { context: 'GET /api/coins', subject: 'coin list', fallbackMessage: 'Failed to retrieve coins' };

  it('reports an oversized coin-list response as a delivery failure that names the coin list', () => {
    const report = buildFailureReport(invalidStringLength(), { ...base, retrieved: true });

    expect(report.stage).toBe('delivery');
    expect(report.message).toBe('The coin list could not be sent to the screen.');
    expect(report.reassurance).toContain('Your data is safe and the database is working');
    expect(report.detail).toBe('RangeError: Invalid string length in GET /api/coins');
  });

  it('never repeats the old lie: a delivery failure does not mention retrieving', () => {
    // THE REGRESSION GUARD. 'Failed to retrieve coins' is the exact string
    // that sends a reader looking at SQL Server. It must not appear anywhere
    // in what a delivery failure tells the user.
    const report = buildFailureReport(invalidStringLength(), { ...base, retrieved: true });
    const spoken = `${report.message} ${report.reassurance ?? ''}`;

    expect(spoken).not.toContain('Failed to retrieve coins');
    expect(spoken).not.toMatch(/could not (be )?retriev/i);
    expect(spoken).not.toMatch(/cannot connect/i);
  });

  it('reassures ONLY on a delivery failure — never promises what it does not know', () => {
    const dead = Object.assign(new Error('Connection is closed.'), { code: 'ECONNCLOSED' });

    expect(buildFailureReport(dead, base).reassurance).toBeNull();
    expect(buildFailureReport(new Error('Invalid column name Wibble'), base).reassurance).toBeNull();
  });

  it('keeps the established wording for an unreachable database', () => {
    const dead = Object.assign(new Error('Connection is closed.'), { code: 'ECONNCLOSED' });
    const report = buildFailureReport(dead, base);

    expect(report.stage).toBe('connection');
    expect(report.message).toMatch(/unreachable/i);
  });

  it('falls back to the route-supplied message for a genuine database error', () => {
    const report = buildFailureReport(new Error('Invalid column name Wibble'), base);

    expect(report.stage).toBe('database');
    expect(report.message).toBe('Failed to retrieve coins');
  });

  it('names whatever subject the route gave it', () => {
    const report = buildFailureReport(invalidStringLength(), {
      context: 'GET /api/transactions',
      subject: 'transaction list',
      fallbackMessage: 'Failed to retrieve transactions',
      retrieved: true,
    });

    expect(report.message).toBe('The transaction list could not be sent to the screen.');
  });
});
