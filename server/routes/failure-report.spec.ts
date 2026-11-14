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
  insertCoin,
  rebuildTestDatabase,
  withTestDb,
} from '../test-support/sqlite-test-db';
import { DB_BINDINGS, getPool, sqlErrorNumber, withDb } from '../db';
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

/**
 * A handle-level failure, in the vocabulary SQLite actually speaks.
 *
 * This used to be `{ code: 'ECONNCLOSED' }`, one of the mssql socket codes.
 * Those are gone with the driver and db/errors.ts no longer recognises them:
 * a dead database is now a SQLite RESULT CODE, and 526 is
 * SQLITE_CANTOPEN_ISDIR — an extended code whose low byte is 14
 * (SQLITE_CANTOPEN), which is the masking db/errors.ts does. Using an
 * extended code here rather than a bare 14 keeps that masking under test.
 *
 * The message is the one `node:sqlite` really produces, so the message-based
 * backstop in isConnectionError() sees the same text in the test as in
 * production.
 */
function deadConnection(): Error {
  return Object.assign(new Error('unable to open database file'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 526,
  });
}

/** Runs something that must fail, and hands back the error it threw. */
async function errorFrom(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  throw new Error('that statement was expected to fail, and did not');
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
    expect(isSerialisationFailure(new Error('unable to open database file'))).toBe(false);
    expect(isSerialisationFailure(null)).toBe(false);
    expect(isSerialisationFailure(undefined)).toBe(false);
  });

  it('recognises a bare string, because logError hands those through too', () => {
    expect(isSerialisationFailure('Invalid string length')).toBe(true);
  });
});

describe('failureStageFor', () => {
  it('calls a dead connection a connection failure', () => {
    const dead = deadConnection();
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
    const dead = deadConnection();
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
    const dead = deadConnection();

    expect(buildFailureReport(dead, base).reassurance).toBeNull();
    expect(buildFailureReport(new Error('Invalid column name Wibble'), base).reassurance).toBeNull();
  });

  it('keeps the established wording for an unreachable database', () => {
    const dead = deadConnection();
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

/*
 * ===== AGAINST ERRORS THE REAL DATABASE ACTUALLY THROWS =====
 *
 * Everything above hands this module an error object a human wrote. That is
 * the right way to test a pure function exhaustively, and it is also the one
 * thing those tests CANNOT establish: that the errors the engine produces
 * look anything like the ones the test imagined. Under the mssql mock nobody
 * ever checked, and the link was the first thing the engine change could have
 * broken — the whole chain is SQLite result code -> db/sql-api.ts's
 * translation into a SQL Server number -> db/errors.ts -> this module.
 *
 * So these two drive it from the other end: break the database for real, and
 * ask what stage the resulting error is sorted into.
 */
describe('errors the real database produces', () => {
  it('sorts a real constraint violation into the database stage, not the connection one', async () => {
    // A genuine duplicate primary key. SQLite raises
    // SQLITE_CONSTRAINT_PRIMARYKEY (1555); db/sql-api.ts re-dresses it as
    // 2627, which is also what makes isConnectionError() refuse it outright
    // (an error with a SQL Server number is by definition a query problem).
    await insertCoin({ CoinId: 'dup-1', Denomination: '$1' });

    const err = await errorFrom(() =>
      withDb((db) =>
        db
          .request()
          .input('id', DB_BINDINGS.coinId, 'dup-1')
          .query('INSERT INTO Coins (CoinId) VALUES (@id)')
      )
    );

    expect(sqlErrorNumber(err)).toBe(2627);
    expect(failureStageFor(err)).toBe('database');

    // And the user is told the route's own message, with nothing promised
    // about their data.
    const report = buildFailureReport(err, {
      context: 'POST /api/coins',
      subject: 'coin',
      fallbackMessage: 'Failed to create coin',
    });
    expect(report.message).toBe('Failed to create coin');
    expect(report.reassurance).toBeNull();
  });

  it('sorts a real dead handle into the connection stage', async () => {
    // The handle is closed underneath the data layer, which is as close as a
    // single-file engine gets to "the connection dropped". `node:sqlite`
    // raises ERR_INVALID_STATE / 'database is not open'.
    //
    // Note this goes through the DbConnection directly rather than through
    // withDb(): withDb retries a connection-class failure once, and the
    // retry would open a fresh in-memory database and succeed, which is the
    // behaviour db/pool.ts is supposed to have.
    const connection = await getPool();
    try {
      await withTestDb((database) => database.close());

      const err = await errorFrom(() => connection.request().query('SELECT 1'));

      expect(failureStageFor(err)).toBe('connection');
      expect(buildFailureReport(err, {
        context: 'GET /api/coins',
        subject: 'coin list',
        fallbackMessage: 'Failed to retrieve coins',
      }).message).toMatch(/unreachable/i);
    } finally {
      // The handle is gone; the next test needs a sound one.
      await rebuildTestDatabase();
    }
  });
});
