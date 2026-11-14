/*
 * routes/delivery-failure.spec.ts — a response that cannot be serialised,
 * end to end. failure-report.spec.ts pins the DECISION; this file pins the
 * WIRING, that the routes actually reach it, by driving a real Express app
 * through supertest.
 *
 * *** THIS FILE IS NOT ABOUT THE DATABASE, AND THAT IS THE POINT. *** The
 * rows below are real rows out of the real in-memory SQLite database; the
 * failure happens AFTERWARDS, inside `res.json()`, with the data already in
 * hand. The distinction is structural (`sendJson()` wraps only the send) and
 * the engine has nothing to do with it.
 *
 * HOW THE FAILURE IS REPRODUCED
 * `JSON.stringify` is made to throw for the one payload under test — the
 * same error V8 raises (`RangeError: Invalid string length`), from the same
 * place (inside JSON.stringify, inside res.json). Building an actual
 * half-gigabyte response is not an option; this reproduces the throw
 * faithfully and in milliseconds.
 *
 * The previous version did it by giving a canned row a `Notes` value whose
 * `toJSON()` threw. That is no longer possible and should not be faked: a
 * TEXT column hands back a string, so no object with a `toJSON()` can ever
 * come out of the database. Intercepting JSON.stringify keeps the throw in
 * the place the real one happens instead of moving it into the data, and the
 * interception is scoped to the payload being tested so that the route's own
 * error response still serialises.
 *
 * WHAT MUST BE TRUE AFTERWARDS
 *   - the response does NOT say the database failed
 *   - it says the data is safe, because by then the rows had been read
 *   - the technical detail is present for whoever wants it
 *   - and a genuinely dead connection is still reported as a dead connection,
 *     so the new honesty has not simply replaced one blanket answer with
 *     another.
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
 * Makes `res.json()` throw — and ONLY for the response carrying `id`.
 *
 * Scoping it that way matters: the error response the route then builds goes
 * through the same JSON.stringify, and a blanket throw would fail that too
 * and hide the very body these tests read.
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

    // THE WHOLE POINT. 'Failed to retrieve coins' is what a single catch
    // block says while the database is busy handing over every row.
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

    // A separate field, not spliced into the sentence the user reads.
    expect(res.body.detail).toBe('RangeError: Invalid string length in GET /api/coins');
    expect(res.body.error).not.toContain('RangeError');
  });

  /*
   * THIS TEST EXISTS BECAUSE THE ONES ABOVE WERE NOT ENOUGH.
   *
   * Replacing `sendJson(...)` in the route with the old bare `res.json(coins)`
   * left every test above GREEN. The reason: they all throw
   * `RangeError: Invalid string length`, which isSerialisationFailure()
   * RECOGNISES BY MESSAGE, so the sniffing backstop classified it as a
   * delivery failure even with the structural split removed.
   *
   * The split is still the load-bearing part — the backstop only knows the
   * handful of messages it has been taught — so the test has to use a send
   * failure the sniffer CANNOT recognise. A plain Error with an unremarkable
   * message is exactly that: nothing about it says "serialisation", and only
   * the fact that it was thrown from inside sendJson() proves the rows had
   * already been read.
   *
   * Delete the sendJson() call in routes/coins/reads.ts and this test fails
   * with 'Failed to retrieve coins' — the original lie, verbatim.
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

  // A third case drove GET /api/transactions and checked the response named
  // the 'transaction list'. The route is gone with the Transactions table.
  // What it added over the two cases above was ONE thing — that the subject
  // string the route passes reaches the message — and that is pinned
  // directly, with no route involved, by "names whatever subject the route
  // gave it" in failure-report.spec.ts.
});

describe('a genuinely broken connection is still reported as one', () => {
  it('GET /api/coins says unreachable, and promises nothing about the data', async () => {
    // A database that will not open, for real: the path is a directory, so
    // SQLite answers SQLITE_CANTOPEN. (The old `{ code: 'ECONNCLOSED' }` was
    // an mssql socket code and cannot occur — there is no socket now.)
    await resetPool();
    process.env[DB_PATH_ENV_VAR] = os.tmpdir();
    databaseNeedsRebuilding = true;

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(503);
    expect(res.body.stage).toBe('connection');
    expect(res.body.error).toMatch(/unreachable/i);
    // No reassurance: we never reached the database, so we know nothing.
    expect(res.body.error).not.toMatch(/your data is safe/i);
  });

  it('an ordinary query error is a database failure, not a delivery one', async () => {
    // A real "no such table", which is what the invented
    // 'Invalid column name Wibble' stood in for.
    await withTestDb((database) => database.exec('DROP TABLE Categories'));
    databaseNeedsRebuilding = true;

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(500);
    expect(res.body.stage).toBe('database');
    expect(res.body.error).not.toMatch(/your data is safe/i);
  });
});
