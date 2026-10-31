/**
 * server.spec.ts — tests for the app wiring itself.
 *
 * The per-resource tests live next to the code they cover:
 *
 *   db/connection.spec.ts              config, pool, crash regression, withDb
 *   db/coin-fields.spec.ts             COIN_FIELDS vs setup-database.sql
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
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('./test-support/mssql-mock');
  return createMssqlMock();
});

import { mockRequest, resetMssqlMock } from './test-support/mssql-mock';
import { app } from './server';
import { resetPool } from './db';

beforeEach(() => {
  resetMssqlMock();
});

// ============================================================
// Health check
// ============================================================

describe('GET /api/health', () => {
  it('reports ok when SELECT 1 succeeds', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ '': 1 }], rowsAffected: [1] });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'connected' });
  });

  it('reports 503 when the database is unreachable', async () => {
    // Both the first call and the single automatic retry must fail.
    const connErr = Object.assign(new Error('Connection is closed.'), { code: 'ECONNCLOSED' });
    mockRequest.query.mockRejectedValue(connErr);

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.database).toBe('disconnected');
    expect(typeof res.body.message).toBe('string');

    await resetPool();
  });
});
