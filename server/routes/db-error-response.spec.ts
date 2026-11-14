/**
 * routes/db-error-response.spec.ts — the error -> HTTP status translation.
 *
 * These tests pin a real status code per failure kind, and the pool left
 * alone — a blanket 500 plus resetPool() in every catch block destroys the
 * pool for the whole process over an ordinary bad request.
 *
 * They drive the classifier through real routes rather than calling
 * classifyDbError() directly, because what matters is that the routes actually
 * reach it.
 *
 * *** AND THE FAILURES ARE NOW REAL. *** Every case below makes the database
 * genuinely fail — a duplicate primary key, an unsatisfied foreign key, a
 * value too long for its declared width, a file SQLite cannot open, a missing
 * table. Previously each one was a hand-written error object carrying the SQL
 * Server `number` the test wanted to see, which proved the classifier's
 * `switch` and nothing about whether the engine ever produces that number.
 * The chain being tested now runs end to end: SQLite result code ->
 * db/sql-api.ts's translation -> db/errors.ts -> classifyDbError -> status.
 */

import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import os from 'node:os';

import {
  insertCoin,
  queryRows,
  rebuildTestDatabase,
  withTestDb,
} from '../test-support/sqlite-test-db';
import { app } from '../server';
import { DB_PATH_ENV_VAR, resetPool } from '../db';

/** Set by a test that broke the schema, so afterEach can rebuild it. */
let databaseNeedsRebuilding = false;

afterEach(async () => {
  if (databaseNeedsRebuilding) {
    databaseNeedsRebuilding = false;
    await rebuildTestDatabase();
  }
});

describe('route error classification', () => {
  it('returns 409 for a primary-key / unique constraint violation', async () => {
    // A real duplicate: Coins.CoinId is the primary key, and the route lets
    // the caller supply the id. SQLite answers SQLITE_CONSTRAINT_PRIMARYKEY
    // (1555), which db/sql-api.ts re-dresses as 2627.
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Quarter' });

    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'abc-123', denomination: 'Quarter' });

    expect(res.status).toBe(409);
    expect(res.body.stage).toBe('database');
    // The transaction rolled back: still exactly one coin.
    expect(await queryRows('SELECT CoinId FROM Coins')).toHaveLength(1);
  });

  it('returns 409 for a foreign-key violation', async () => {
    /*
     * THE ROUTE THAT RAISES THIS CHANGED, AND THE OLD ONE CANNOT RAISE IT ANY
     * MORE. This test used to drive DELETE /api/coins/:id, on the premise
     * that deleting a coin with children fails. Against the real schema it
     * does not: CoinImages declares ON DELETE CASCADE on CoinId, so that
     * delete succeeds by design (see
     * db/schema.sql, and the "deletes coin (images cascade)" comment in
     * routes/coins/writes.ts).
     *
     * The foreign key that genuinely bites is FK_Coins_Denomination, which
     * has no cascade and no SET NULL: a coin may not point at a denomination
     * that does not exist. SQLITE_CONSTRAINT_FOREIGNKEY (787) -> 547 -> 409.
     */
    const res = await request(app)
      .post('/api/coins')
      .send({ denomination: 'Quarter', denominationId: 999999 });

    expect(res.status).toBe(409);
    expect(await queryRows('SELECT CoinId FROM Coins')).toEqual([]);
  });

  it('returns 400 when a value is too long for its column (SQL error 8152)', async () => {
    // Coins.Year is NVARCHAR(50). SQLite would store 51 characters without
    // complaint — the width is enforced by db/bind-values.ts, which raises
    // the 8152 SQL Server used to raise. That makes this test MORE important
    // than it was, not less: the binding table is now the only thing
    // enforcing the width.
    const res = await request(app)
      .post('/api/coins')
      .send({ denomination: 'Quarter', year: 'x'.repeat(51) });

    expect(res.status).toBe(400);
    expect(await queryRows('SELECT CoinId FROM Coins')).toEqual([]);
  });

  it('returns 503 when the database connection is dead', async () => {
    /*
     * A database that will not open, for real. The old version of this test
     * rejected with `{ code: 'ECONNCLOSED' }`, an mssql socket code that
     * cannot occur now: there is no socket. Pointing the data layer at a path
     * that is a DIRECTORY produces SQLITE_CANTOPEN (extended 526, low byte
     * 14), which is the vocabulary db/errors.ts actually recognises.
     *
     * db/pool.ts retries the open three times before giving up, so this is
     * the slowest test in the file.
     */
    await resetPool();
    process.env[DB_PATH_ENV_VAR] = os.tmpdir();
    databaseNeedsRebuilding = true;

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unreachable/i);
    expect(res.body.stage).toBe('connection');
  });

  it('returns 500 for anything else', async () => {
    // A query against a table that is not there. "no such table" is
    // SQLITE_ERROR (1), which is neither a constraint nor a connection
    // failure, so it must fall through to the generic 500 — the branch that
    // used to be reached with `new Error('Invalid column name Wibble')`.
    await withTestDb((database) => database.exec('DROP TABLE Categories'));
    databaseNeedsRebuilding = true;

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(500);
    expect(res.body.stage).toBe('database');
    expect(res.body.detail).toMatch(/no such table/i);
  });
});
