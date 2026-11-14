/**
 * server.spec.ts — tests for the app wiring itself.
 *
 * The per-resource tests live next to the code they cover:
 *
 *   db/connection.spec.ts              config, pool, crash regression, withDb
 *   db/coin-fields.spec.ts             COIN_FIELDS vs db/schema.sql
 *   routes/coins/reads.spec.ts         /api/coins (GET)
 *   routes/coins/writes.spec.ts        /api/coins (POST/PUT/DELETE)
 *   routes/lookups/lookups.spec.ts     /api/categories, /api/mintmarks, ...
 *   routes/data/data.spec.ts           /api/transactions, /api/settings, ...
 *   routes/db-error-response.spec.ts   error -> HTTP status translation
 *
 * What is left here is the health endpoint, which is the one route that
 * belongs to the server as a whole rather than to any resource: the launcher
 * (setup/start-coin-inventory.ps1) polls it to decide when to open the browser,
 * so its exact response shape is part of the contract.
 *
 * Both tests run against the REAL in-memory SQLite database. The healthy case
 * runs the real `SELECT 1`, and the unhealthy case breaks the database for
 * real rather than teaching a mock to reject — see unreachableDatabase().
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { rebuildTestDatabase } from './test-support/sqlite-test-db';
import { app } from './server';
import { DB_PATH_ENV_VAR, resetPool } from './db';
import os from 'node:os';

/**
 * Runs `work` with the data layer pointed at something SQLite genuinely
 * cannot open: a path that is an existing DIRECTORY, which fails with
 * SQLITE_CANTOPEN (extended code 526, low byte 14) on every attempt.
 *
 * This replaces the old `mockRequest.query.mockRejectedValue({ code:
 * 'ECONNCLOSED' })`. There is no socket and no mssql driver any more, so
 * ECONNCLOSED cannot occur; a database file that will not open is the real
 * shape of "the database is unreachable" on SQLite, and it exercises
 * db/errors.ts's result-code masking rather than a string the test invented.
 *
 * The open is retried three times inside db/pool.ts before it gives up, which
 * is why this is the slowest test in the file.
 */
async function unreachableDatabase<T>(work: () => Promise<T>): Promise<T> {
  await resetPool();
  process.env[DB_PATH_ENV_VAR] = os.tmpdir();
  try {
    return await work();
  } finally {
    // rebuildTestDatabase() puts COIN_INVENTORY_DB_PATH back to ':memory:'
    // and opens a sound database for whatever runs next.
    await rebuildTestDatabase();
  }
}

// Health check

describe('GET /api/health', () => {
  it('reports ok when SELECT 1 succeeds', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'connected' });
  });

  it('reports 503 when the database is unreachable', async () => {
    const res = await unreachableDatabase(() => request(app).get('/api/health'));

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.database).toBe('disconnected');
    expect(typeof res.body.message).toBe('string');
  });
});
