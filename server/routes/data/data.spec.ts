/**
 * routes/data/data.spec.ts — HTTP-level tests for the non-coin data routes:
 * transactions, spot prices and settings.
 *
 * (There is no test for POST /api/log: it writes to app.log and always answers
 * 204, so there is nothing to assert that the logger's own behaviour does not
 * already cover.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import { mockRequest, resetMssqlMock } from '../../test-support/mssql-mock';
import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

// ============================================================
// Transactions API
// ============================================================

describe('GET /api/transactions', () => {
  it('returns all transactions', async () => {
    // Server reads CamelCase column names: TransactionId, CoinId, TransactionType, TransactionDate, Amount, Dealer, Notes
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        TransactionId: 'tx-1',
        CoinId: 'abc-123',
        TransactionType: 'purchase',
        TransactionDate: '2024-03-01',
        Amount: 150.00,
        Dealer: 'Heritage',
        Notes: 'Won auction',
      }],
    });

    const res = await request(app).get('/api/transactions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].coinId).toBe('abc-123');
    expect(res.body[0].type).toBe('purchase');
  });

  it('filters by coinId', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/transactions?coinId=abc-123');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/transactions', () => {
  it('returns 400 for missing required fields', async () => {
    const res = await request(app)
      .post('/api/transactions')
      .send({ amount: 100 });
    expect(res.status).toBe(400);
  });

  it('creates a transaction', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/transactions')
      .send({
        id: 'tx-2',
        coinId: 'abc-123',
        type: 'sale',
        date: '2024-06-15',
        amount: 250.00,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('tx-2');
  });
});

describe('DELETE /api/transactions/:id', () => {
  it('returns 404 for non-existent transaction', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).delete('/api/transactions/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Spot Prices API
// ============================================================

describe('GET /api/spot-prices/latest', () => {
  it('returns zeros when no prices exist', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/spot-prices/latest');
    expect(res.status).toBe(200);
    expect(res.body.gold).toBe(0);
    expect(res.body.silver).toBe(0);
  });

  it('returns latest spot prices', async () => {
    // Server reads CamelCase column names: Gold, Silver, Platinum, Copper, Source, FetchedAt
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        Gold: 2350.50,
        Silver: 28.75,
        Platinum: 1025.00,
        Copper: 4.15,
        Source: 'metals.live',
        FetchedAt: '2024-03-01T12:00:00Z',
      }],
    });

    const res = await request(app).get('/api/spot-prices/latest');
    expect(res.status).toBe(200);
    expect(res.body.gold).toBe(2350.50);
    expect(res.body.silver).toBe(28.75);
    expect(res.body.source).toBe('metals.live');
  });
});

describe('POST /api/spot-prices', () => {
  it('saves spot prices', async () => {
    // Server reads SpotPriceId and FetchedAt from OUTPUT INSERTED
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ SpotPriceId: 1, FetchedAt: '2024-03-01T12:00:00Z' }],
    });

    const res = await request(app)
      .post('/api/spot-prices')
      .send({ gold: 2400, silver: 30, platinum: 1050, copper: 4.2, source: 'metals.live' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
  });
});

// ============================================================
// Settings API
// ============================================================

describe('GET /api/settings/:key', () => {
  it('returns 404 for non-existent setting', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/settings/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns a JSON-parsed setting value', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ SettingValue: '["col1","col2"]' }],
    });

    const res = await request(app).get('/api/settings/visibleColumns');
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('visibleColumns');
    expect(res.body.value).toEqual(['col1', 'col2']);
  });

  it('returns a plain string setting value', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ SettingValue: 'dark' }],
    });

    const res = await request(app).get('/api/settings/theme');
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('dark');
  });
});

describe('PUT /api/settings/:key', () => {
  it('upserts a setting', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/settings/visibleColumns')
      .send({ value: ['coinType', 'grade', 'value'] });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('visibleColumns');
  });
});
