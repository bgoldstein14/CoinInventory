/**
 * Error -> HTTP status translation, driven through real routes with real
 * database failures (duplicate key, foreign key, over-long value, unopenable
 * file, missing table), so the chain from SQLite code to status is tested end
 * to end. The pool must be left alone on ordinary errors.
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
    // A real duplicate primary key (SQLite 1555 -> 2627).
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Quarter' });

    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'abc-123', denomination: 'Quarter' });

    expect(res.status).toBe(409);
    expect(res.body.stage).toBe('database');
    // Rolled back: still one coin.
    expect(await queryRows('SELECT CoinId FROM Coins')).toHaveLength(1);
  });

  it('returns 409 for a foreign-key violation', async () => {
    // CoinImages cascades on coin delete, so a foreign key failure comes from
    // FK_Coins_Denomination instead: a coin may not reference a missing
    // denomination (787 -> 547 -> 409).
    const res = await request(app)
      .post('/api/coins')
      .send({ denomination: 'Quarter', denominationId: 999999 });

    expect(res.status).toBe(409);
    expect(await queryRows('SELECT CoinId FROM Coins')).toEqual([]);
  });

  it('returns 400 when a value is too long for its column (SQL error 8152)', async () => {
    // Coins.Year is NVARCHAR(50); db/bind-values.ts enforces it (8152 -> 400).
    const res = await request(app)
      .post('/api/coins')
      .send({ denomination: 'Quarter', year: 'x'.repeat(51) });

    expect(res.status).toBe(400);
    expect(await queryRows('SELECT CoinId FROM Coins')).toEqual([]);
  });

  it('returns 503 when the database connection is dead', async () => {
    // A directory path gives SQLITE_CANTOPEN. db/pool.ts retries three times,
    // so this is slow.
    await resetPool();
    process.env[DB_PATH_ENV_VAR] = os.tmpdir();
    databaseNeedsRebuilding = true;

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unreachable/i);
    expect(res.body.stage).toBe('connection');
  });

  it('returns 500 for anything else', async () => {
    // "no such table" is SQLITE_ERROR: neither constraint nor connection, so 500.
    await withTestDb((database) => database.exec('DROP TABLE Categories'));
    databaseNeedsRebuilding = true;

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(500);
    expect(res.body.stage).toBe('database');
    expect(res.body.detail).toMatch(/no such table/i);
  });
});
