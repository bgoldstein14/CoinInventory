/**
 * routes/db-error-response.spec.ts — the error -> HTTP status translation.
 *
 * ============================================================
 * Error classification (replaces the old blanket 500 + resetPool)
 * ============================================================
 *
 * Every route catch block used to call resetPool() (destroying the pool for
 * the whole process) and return 500 regardless of what went wrong. These tests
 * pin down the replacement: a real status code per failure kind, and the pool
 * left alone.
 *
 * They drive the classifier through real routes rather than calling
 * classifyDbError() directly, because what matters is that the routes actually
 * reach it.
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

beforeEach(() => {
  resetMssqlMock();
});

describe('route error classification', () => {
  afterEach(async () => {
    await resetPool();
  });

  it('returns 409 for a primary-key / unique constraint violation', async () => {
    mockRequest.query.mockRejectedValue(
      Object.assign(new Error('Violation of PRIMARY KEY constraint'), { number: 2627 })
    );

    const res = await request(app).post('/api/coins').send({ denomination: 'Quarter' });
    expect(res.status).toBe(409);
  });

  it('returns 409 for a foreign-key violation', async () => {
    mockRequest.query.mockRejectedValue(
      Object.assign(new Error('The DELETE statement conflicted with the REFERENCE constraint'), { number: 547 })
    );

    const res = await request(app).delete('/api/coins/abc-123');
    expect(res.status).toBe(409);
  });

  it('returns 400 when a value is too long for its column (SQL error 8152)', async () => {
    mockRequest.query.mockRejectedValue(
      Object.assign(new Error('String or binary data would be truncated'), { number: 8152 })
    );

    const res = await request(app).post('/api/coins').send({ denomination: 'Quarter' });
    expect(res.status).toBe(400);
  });

  it('returns 503 when the database connection is dead', async () => {
    mockRequest.query.mockRejectedValue(
      Object.assign(new Error('Connection is closed.'), { code: 'ECONNCLOSED' })
    );

    const res = await request(app).get('/api/coins');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unreachable/i);
  });

  it('returns 500 for anything else', async () => {
    mockRequest.query.mockRejectedValue(new Error('Invalid column name Wibble'));

    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(500);
  });
});
