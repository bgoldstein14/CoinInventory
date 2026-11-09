/*
 * routes/delivery-failure.spec.ts — a response that cannot be serialised,
 * end to end. failure-report.spec.ts pins the DECISION; this file pins the
 * WIRING, that the routes actually reach it, by driving a real Express app
 * through supertest.
 *
 * HOW THE FAILURE IS REPRODUCED
 * A coin row carries a `Notes` value whose `toJSON()` throws
 * `RangeError: Invalid string length` — the same error V8 raises, from the
 * same place (inside JSON.stringify, inside res.json). Building an actual
 * half-gigabyte string in a unit test is not an option; this reproduces the
 * throw faithfully and in milliseconds.
 *
 * WHAT MUST BE TRUE AFTERWARDS
 *   - the response does NOT say the database failed
 *   - it says the data is safe, because by then the rows had been read
 *   - the technical detail is present for whoever wants it
 *   - and a genuinely dead connection is still reported as a dead connection,
 *     so the new honesty has not simply replaced one blanket answer with
 *     another.
  */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../test-support/mssql-mock');
  return createMssqlMock();
});

import { mockRequest, resetMssqlMock } from '../test-support/mssql-mock';
import { app } from '../server';
import { resetPool } from '../db';

/** A value JSON.stringify cannot turn into text. */
function unserialisableNotes(): unknown {
  return {
    toJSON() {
      throw new RangeError('Invalid string length');
    },
  };
}

beforeEach(() => {
  resetMssqlMock();
});

afterEach(async () => {
  await resetPool();
});

describe('GET /api/coins when the rows arrive but the response cannot be built', () => {
  /** Queue: 1. the coins, 2. the image COUNT(*) aggregate. */
  function queueUnserialisableCoinList(): void {
    mockRequest.query
      .mockResolvedValueOnce({
        recordset: [{ CoinId: 'coin-1', Denomination: 'Quarter', Notes: unserialisableNotes() }],
        rowsAffected: [1],
      })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });
  }

  it('does not tell the user the database failed', async () => {
    queueUnserialisableCoinList();

    const res = await request(app).get('/api/coins');

    // THE WHOLE POINT. 'Failed to retrieve coins' is what a single catch
    // block says while the database is busy handing over every row.
    expect(res.body.error).not.toContain('Failed to retrieve coins');
    expect(res.body.error).not.toMatch(/unreachable/i);
  });

  it('says plainly what failed and that the data is safe', async () => {
    queueUnserialisableCoinList();

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(500);
    expect(res.body.stage).toBe('delivery');
    expect(res.body.error).toContain('The coin list could not be sent to the screen.');
    expect(res.body.error).toMatch(/your data is safe and the database is working/i);
  });

  it('carries the technical detail without shouting it', async () => {
    queueUnserialisableCoinList();

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
   * failure the sniffer CANNOT recognise. A `toJSON()` that throws a plain
   * Error with an unremarkable message is exactly that: nothing about it says
   * "serialisation", and only the fact that it was thrown from inside
   * sendJson() proves the rows had already been read.
   *
   * Delete the sendJson() call in routes/coins/reads.ts and this test fails
   * with 'Failed to retrieve coins' — the original lie, verbatim.
    */
  it('still says delivery when the send failure is one no sniffer could recognise', async () => {
    mockRequest.query
      .mockResolvedValueOnce({
        recordset: [
          {
            CoinId: 'coin-1',
            Notes: {
              toJSON() {
                throw new Error('a custom serialiser blew up');
              },
            },
          },
        ],
        rowsAffected: [1],
      })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).get('/api/coins');

    expect(res.body.stage).toBe('delivery');
    expect(res.body.error).not.toContain('Failed to retrieve coins');
    expect(res.body.error).toContain('The coin list could not be sent to the screen.');
  });
});

describe('the other read routes report delivery failures the same way', () => {
  it('GET /api/coins/:id names the coin, not the database', async () => {
    mockRequest.query
      .mockResolvedValueOnce({
        recordset: [{ CoinId: 'coin-1', Notes: unserialisableNotes() }],
        rowsAffected: [1],
      })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).get('/api/coins/coin-1');

    expect(res.body.stage).toBe('delivery');
    expect(res.body.error).not.toContain('Failed to retrieve coin');
    expect(res.body.error).toMatch(/your data is safe/i);
  });

  it('GET /api/transactions names the transaction list', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ TransactionId: 1, TransactionDate: '2026-01-01', Notes: unserialisableNotes() }],
      rowsAffected: [1],
    });

    const res = await request(app).get('/api/transactions');

    expect(res.body.stage).toBe('delivery');
    expect(res.body.error).toContain('transaction list');
    expect(res.body.error).toMatch(/your data is safe/i);
  });
});

describe('a genuinely broken connection is still reported as one', () => {
  it('GET /api/coins says unreachable, and promises nothing about the data', async () => {
    mockRequest.query.mockRejectedValue(
      Object.assign(new Error('Connection is closed.'), { code: 'ECONNCLOSED' })
    );

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(503);
    expect(res.body.stage).toBe('connection');
    expect(res.body.error).toMatch(/unreachable/i);
    // No reassurance: we never reached the database, so we know nothing.
    expect(res.body.error).not.toMatch(/your data is safe/i);
  });

  it('an ordinary query error is a database failure, not a delivery one', async () => {
    mockRequest.query.mockRejectedValue(new Error('Invalid column name Wibble'));

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(500);
    expect(res.body.stage).toBe('database');
    expect(res.body.error).not.toMatch(/your data is safe/i);
  });
});
