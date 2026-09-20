/**
 * routes/lookups/lookups.spec.ts — HTTP-level tests for the reference tables:
 * categories, metal contents, coin sets, denominations and mint marks.
 *
 * The "without injecting a duplicate static catalog" tests are regression
 * guards: denominations and mint marks used to be merged with a hard-coded
 * list in the server, which produced duplicate dropdown entries. They must
 * return exactly what the database returned, nothing more.
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
// Categories API
// ============================================================

describe('GET /api/categories', () => {
  it('returns category names', async () => {
    // Server reads row['CategoryName']
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ CategoryName: 'Gold' }, { CategoryName: 'Silver' }],
    });

    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['Gold', 'Silver']);
  });
});

describe('GET /api/metalcontents', () => {
  it('returns canonical metal-content names', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ MetalContentName: 'Gold' }, { MetalContentName: 'Silver' }, { MetalContentName: 'Copper-Nickel' }],
    });

    const res = await request(app).get('/api/metalcontents');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['Gold', 'Silver', 'Copper-Nickel']);
  });
});

describe('GET /api/denominations', () => {
  it('returns the frontend-compatible denomination shape', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ DenominationId: 1, Label: 'Quarter', Country: 'United States', SortOrder: 1 }],
    });

    const res = await request(app).get('/api/denominations');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      denominationId: 1,
      label: 'Quarter',
      country: 'United States',
      isActive: true,
    });
  });

  it('returns the database denomination rows without injecting a duplicate static catalog', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ DenominationId: 9, Label: '25¢', Country: 'US', SortOrder: 9 }],
    });

    const res = await request(app).get('/api/denominations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ denominationId: 9, label: '25¢', country: 'US', sortOrder: 9, isActive: true }]);
  });
});

describe('GET /api/mintmarks', () => {
  it('returns the frontend-compatible mint mark shape', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ MintMarkId: 2, Label: 'D', Description: 'Denver Mint' }],
    });

    const res = await request(app).get('/api/mintmarks');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      mintMarkId: 2,
      label: 'D',
      description: 'Denver Mint',
      isActive: true,
    });
  });

  it('returns the database mint-mark rows without injecting a duplicate static catalog', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ MintMarkId: 3, Label: 'D', Description: 'Denver / Dahlonega' }],
    });

    const res = await request(app).get('/api/mintmarks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ mintMarkId: 3, label: 'D', description: 'Denver / Dahlonega', isActive: true }]);
  });
});

describe('POST /api/categories', () => {
  it('returns 400 for missing name', async () => {
    const res = await request(app).post('/api/categories').send({});
    expect(res.status).toBe(400);
  });

  it('creates a category and returns 201', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/categories')
      .send({ name: 'Platinum' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Platinum');
  });

  it('normalizes whitespace and uses a duplicate-safe query', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/categories')
      .send({ name: '  silver  ' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('silver');
    expect(String(mockRequest.query.mock.calls[0][0])).toContain('LOWER(LTRIM(RTRIM(CategoryName)))');
  });
});

describe('DELETE /api/categories/:name', () => {
  it('returns 404 for non-existent category', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).delete('/api/categories/Nonexistent');
    expect(res.status).toBe(404);
  });
});

// ============================================================
// Coin Sets API
// ============================================================

describe('GET /api/coin-sets', () => {
  it('returns set names', async () => {
    // Server reads row['SetName']
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ SetName: 'Morgan Set' }, { SetName: 'Peace Set' }],
    });

    const res = await request(app).get('/api/coin-sets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['Morgan Set', 'Peace Set']);
  });
});

describe('POST /api/coin-sets', () => {
  it('returns 400 for missing name', async () => {
    const res = await request(app).post('/api/coin-sets').send({});
    expect(res.status).toBe(400);
  });

  it('creates a coin set', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coin-sets')
      .send({ name: 'Walking Liberty Set' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Walking Liberty Set');
  });
});
