/*
 * A response that can't be serialized, end to end through Express.
 * failure-report.spec.ts tests the decision; this tests the routes reach it.
 *
 * The rows are real; the failure is injected into JSON.stringify for the one
 * payload under test (the same RangeError V8 throws), so the route's own error
 * response still serializes. Afterwards the response must not blame the
 * database, must say the data is safe, and must include the technical detail;
 * a dead connection must still be reported as one.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import os from 'node:os';

import {
  insertCoin,
  rebuildTestDatabase,
  withTestDb,
} from '../test-support/sqlite-test-db';
import { app } from '../server';
import { DB_PATH_ENV_VAR, resetPool } from '../db';

/** Captured before anything can replace it. */
const realStringify = JSON.stringify;

/** Does this payload contain the record we are failing the send for? */
function payloadNames(value: unknown, id: string): boolean {
  const rows = Array.isArray(value) ? value : [value];
  return rows.some(
    (row) => typeof row === 'object' && row !== null && (row as Record<string, unknown>)['id'] === id
  );
}

/**
 * Makes res.json() throw only for the response carrying `id`, so the
 * route's error response still serializes.
 */
function breakTheSend(id: string, makeError: () => Error): void {
  vi.spyOn(JSON, 'stringify').mockImplementation(((
    value: unknown,
    replacer?: unknown,
    space?: unknown
  ) => {
    if (payloadNames(value, id)) throw makeError();
    return (realStringify as (v: unknown, r?: unknown, s?: unknown) => string)(
      value,
      replacer,
      space
    );
  }) as unknown as typeof JSON.stringify);
}

/** A value JSON.stringify cannot turn into text. */
function invalidStringLength(): RangeError {
  return new RangeError('Invalid string length');
}

/** Set by a test that broke the database on purpose. */
let databaseNeedsRebuilding = false;

afterEach(async () => {
  vi.restoreAllMocks();
  if (databaseNeedsRebuilding) {
    databaseNeedsRebuilding = false;
    await rebuildTestDatabase();
  }
});

describe('GET /api/coins when the rows arrive but the response cannot be built', () => {
  /** One real coin, and a send that will fail once the list is in hand. */
  async function unsendableCoinList(makeError: () => Error = invalidStringLength): Promise<void> {
    await insertCoin({ CoinId: 'coin-1', Denomination: 'Quarter', Notes: 'a note' });
    breakTheSend('coin-1', makeError);
  }

  it('does not tell the user the database failed', async () => {
    await unsendableCoinList();

    const res = await request(app).get('/api/coins');

    // A single catch block would say this while the rows were already retrieved.
    expect(res.body.error).not.toContain('Failed to retrieve coins');
    expect(res.body.error).not.toMatch(/unreachable/i);
  });

  it('says plainly what failed and that the data is safe', async () => {
    await unsendableCoinList();

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(500);
    expect(res.body.stage).toBe('delivery');
    expect(res.body.error).toContain('The coin list could not be sent to the screen.');
    expect(res.body.error).toMatch(/your data is safe and the database is working/i);
  });

  it('carries the technical detail without shouting it', async () => {
    await unsendableCoinList();

    const res = await request(app).get('/api/coins');

    // A separate field, not part of the user-facing sentence.
    expect(res.body.detail).toBe('RangeError: Invalid string length in GET /api/coins');
    expect(res.body.error).not.toContain('RangeError');
  });

  /*
   * The tests above throw a RangeError that isSerialisationFailure()
   * recognises by message, so they pass even without sendJson(). This one
   * throws an unremarkable Error, which only the sendJson() structure can
   * classify as delivery. Removing sendJson() from routes/coins/reads.ts fails it.
   */
  it('still says delivery when the send failure is one no sniffer could recognise', async () => {
    await unsendableCoinList(() => new Error('a custom serialiser blew up'));

    const res = await request(app).get('/api/coins');

    expect(res.body.stage).toBe('delivery');
    expect(res.body.error).not.toContain('Failed to retrieve coins');
    expect(res.body.error).toContain('The coin list could not be sent to the screen.');
  });
});

describe('the other read routes report delivery failures the same way', () => {
  it('GET /api/coins/:id names the coin, not the database', async () => {
    await insertCoin({ CoinId: 'coin-1', Denomination: 'Quarter' });
    breakTheSend('coin-1', invalidStringLength);

    const res = await request(app).get('/api/coins/coin-1');

    expect(res.body.stage).toBe('delivery');
    expect(res.body.error).not.toContain('Failed to retrieve coin');
    expect(res.body.error).toMatch(/your data is safe/i);
  });

});

describe('a genuinely broken connection is still reported as one', () => {
  it('GET /api/coins says unreachable, and promises nothing about the data', async () => {
    // A directory path gives SQLITE_CANTOPEN.
    await resetPool();
    process.env[DB_PATH_ENV_VAR] = os.tmpdir();
    databaseNeedsRebuilding = true;

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(503);
    expect(res.body.stage).toBe('connection');
    expect(res.body.error).toMatch(/unreachable/i);
    // No reassurance: we never reached the database.
    expect(res.body.error).not.toMatch(/your data is safe/i);
  });

  it('an ordinary query error is a database failure, not a delivery one', async () => {
    // A real "no such table".
    await withTestDb((database) => database.exec('DROP TABLE Categories'));
    databaseNeedsRebuilding = true;

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(500);
    expect(res.body.stage).toBe('database');
    expect(res.body.error).not.toMatch(/your data is safe/i);
  });
});
