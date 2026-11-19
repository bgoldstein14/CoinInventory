/*
 * The three failure stages (see routes/failure-report.ts): connection,
 * database, and delivery (data retrieved, then the send failed). Only delivery
 * may promise the data is intact; every test checks we never claim more than
 * we know.
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
 * A handle-level failure as SQLite reports it: 526 (SQLITE_CANTOPEN_ISDIR),
 * an extended code whose low byte is 14, so db/errors.ts's masking is tested.
 * The message matches what node:sqlite produces.
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
    // Errors crossing a realm lose their prototype; only the message survives.
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
    // A false positive would claim the data is safe after a database error, so this stays narrow.
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
    // The sniffing fallback, for routes not using sendJson().
    expect(failureStageFor(invalidStringLength())).toBe('delivery');
  });

  it('calls anything a delivery failure once the caller says the data was retrieved', () => {
    // The structural path: sendJson() only catches throws from res.json().
    expect(failureStageFor(new Error('something exotic'), { retrieved: true })).toBe('delivery');
  });

  it('still says delivery when the data was retrieved and a connection error follows', () => {
    // A later connection blip doesn't undo that the rows were retrieved.
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
    // Regression guard: a delivery failure must not say 'Failed to retrieve coins'.
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
      context: 'GET /api/spot-prices/latest',
      subject: 'spot prices',
      fallbackMessage: 'Failed to retrieve spot prices',
      retrieved: true,
    });

    expect(report.message).toBe('The spot prices could not be sent to the screen.');
  });
});

/*
 * Errors the real database produces, so the chain SQLite code ->
 * db/sql-api.ts -> db/errors.ts -> this module is tested end to end.
 */
describe('errors the real database produces', () => {
  it('sorts a real constraint violation into the database stage, not the connection one', async () => {
    // A duplicate primary key: SQLite's 1555 becomes 2627, a query problem.
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

    // The route's own message, with no promise about the data.
    const report = buildFailureReport(err, {
      context: 'POST /api/coins',
      subject: 'coin',
      fallbackMessage: 'Failed to create coin',
    });
    expect(report.message).toBe('Failed to create coin');
    expect(report.reassurance).toBeNull();
  });

  it('sorts a real dead handle into the connection stage', async () => {
    // Closing the handle is the nearest equivalent of a dropped connection
    // (ERR_INVALID_STATE). Uses the connection directly, since withDb() would
    // retry and succeed.
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
      // The next test needs a working handle.
      await rebuildTestDatabase();
    }
  });
});
