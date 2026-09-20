/**
 * routes/coins/writes.spec.ts — HTTP tests for creating, updating and deleting
 * a coin (routes/coins/writes.ts) plus the transaction unwinding in
 * routes/coins/write-helpers.ts.
 *
 * Three of the tests below are regression guards, not ordinary coverage:
 *
 *   - "sends max-length ... without truncation" — parameter lengths must match
 *     the schema exactly, or the user's data is silently trimmed.
 *   - "updates only the supplied fields ..."    — the partial-update rule that
 *     a previous refactor broke, blanking out the user's data.
 *   - "reports the ORIGINAL error even when rollback() itself throws" — a
 *     failing rollback must not hide the error that actually caused the save
 *     to fail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import {
  capturedInputs,
  mockRequest,
  mockTransaction,
  resetMssqlMock,
} from '../../test-support/mssql-mock';

import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

describe('PUT /api/coins/:id parameter binding', () => {
  it('sends max-length Year, Grade, Dealer and CoinSet values through without truncation', async () => {
    const longYear = 'Y'.repeat(50);
    const longGrade = 'G'.repeat(50);
    const longDealer = 'D'.repeat(200);
    const longCoinSet = 'S'.repeat(100);

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ year: longYear, grade: longGrade, dealer: longDealer, coinSet: longCoinSet });

    expect(res.status).toBe(200);

    const byName = new Map(capturedInputs.map((entry) => [entry.name, entry]));

    expect(byName.get('year')?.value).toBe(longYear);
    expect(byName.get('year')?.type).toMatchObject({ length: 50 });
    expect(byName.get('grade')?.value).toBe(longGrade);
    expect(byName.get('grade')?.type).toMatchObject({ length: 50 });
    expect(byName.get('dealer')?.value).toBe(longDealer);
    expect(byName.get('dealer')?.type).toMatchObject({ length: 200 });
    expect(byName.get('coinSet')?.value).toBe(longCoinSet);
    expect(byName.get('coinSet')?.type).toMatchObject({ length: 100 });
  });
});

describe('POST /api/coins', () => {
  it('returns 400 when denomination is missing', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({ coinType: 'Washington' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('denomination');
  });

  it('creates a coin and returns 201 with id', async () => {
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'test-id',
        denomination: 'Quarter',
        coinType: 'Washington',
        year: '2024',
        imagePaths: ['data:image/png;base64,img1'],
        tags: ['test'],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('test-id');
  });
});

describe('PUT /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app)
      .put('/api/coins/nonexistent')
      .send({ coinType: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates a coin and returns 200', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan', denomination: '$1' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('abc-123');
  });

  it('updates only the supplied fields so partial edits do not blank unrelated data', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan' });

    const sqlText = mockRequest.query.mock.calls.at(-1)?.[0] as string;
    expect(sqlText).toContain('CoinType = @coinType');
    expect(sqlText).not.toContain('Denomination = @denomination');
    expect(sqlText).not.toContain('Year = @year');
  });
});

describe('DELETE /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).delete('/api/coins/nonexistent');
    expect(res.status).toBe(404);
  });

  it('deletes a coin and returns 204', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app).delete('/api/coins/abc-123');
    expect(res.status).toBe(204);
  });
});

// ============================================================
// Transaction rollback safety
// ============================================================

describe('transaction rollback', () => {
  it('reports the ORIGINAL error even when rollback() itself throws', async () => {
    // Fail the UPDATE...
    const originalError = Object.assign(new Error('Violation of UNIQUE KEY constraint'), { number: 2601 });
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] }) // existence check
      .mockRejectedValue(originalError);                             // the UPDATE

    // ...and make the rollback fail too, which is exactly what happens when the
    // connection already died. The old code rethrew the rollback error and lost
    // the real cause; we must still classify on the original error (409).
    mockTransaction.rollback.mockRejectedValue(new Error('No transaction is active'));

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ certNumber: '12345' });

    expect(mockTransaction.rollback).toHaveBeenCalled();
    expect(res.status).toBe(409);
  });
});
