/**
 * Tests for the app wiring: the health endpoint, whose response shape the
 * launcher (setup/start-coin-inventory.ps1) depends on. Per-resource tests live
 * next to their routes. Runs against the real in-memory SQLite database.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { rebuildTestDatabase } from './test-support/sqlite-test-db';
import { app } from './server';
import { DB_PATH_ENV_VAR, resetPool } from './db';
import os from 'node:os';

/**
 * Runs `work` with the data layer pointed at a directory, which SQLite can't
 * open (SQLITE_CANTOPEN), to simulate an unreachable database. db/pool.ts
 * retries the open three times, so this is slow.
 */
async function unreachableDatabase<T>(work: () => Promise<T>): Promise<T> {
  await resetPool();
  process.env[DB_PATH_ENV_VAR] = os.tmpdir();
  try {
    return await work();
  } finally {
    // Restores ':memory:' and opens a sound database for the next test.
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
