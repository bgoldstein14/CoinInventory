/**
 * routes/coins/reads.spec.ts — HTTP tests for the read-only coin endpoints
 * (routes/coins/reads.ts).
 *
 * The mock rows below use the CamelCase SQL Server column names on purpose:
 * translating those into the camelCase JSON the Angular app expects is exactly
 * what rowToCoin() in db/row-mappers.ts is being tested for here.
 *
 * The mssql mock answers queries IN CALL ORDER, so the number of queued
 * recordsets must match the number of queries the handler runs:
 *
 *   GET /api/coins      ->  1. coins   2. images   3. image counts
 *   GET /api/coins/:id  ->  1. coin    2. images
 *
 * Both sequences used to carry a tags query at the end. The tag feature was
 * removed, so each is one query shorter now.
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

describe('GET /api/coins', () => {
  it('returns an empty array when no coins exist', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [] })  // 1. coins
      .mockResolvedValueOnce({ recordset: [] })  // 2. images
      .mockResolvedValueOnce({ recordset: [] }); // 3. image counts

    const res = await request(app).get('/api/coins');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns coins with images joined', async () => {
    // Mock data uses CamelCase database column names (CoinId, Denomination, CoinType, etc.)
    const coinRow = {
      CoinId: 'abc-123',
      Denomination: '$1',
      Year: '1921',
      CoinType: 'Morgan',
      Category: 'Silver Dollars',
      Country: 'USA',
      Grade: 'MS-65',
      CertCompany: 'PCGS',
      CertNumber: '12345678',
      Variety: null,
      MintMark: 'S',
      Composition: '90% Silver',
      PurchaseDate: '2024-01-15',
      PurchasePrice: 150.00,
      CurrentValue: 200.00,
      Notes: 'Nice toning',
      Source: 'manual',
      HasCacSticker: true,
      SoldPrice: null,
      SoldDate: null,
      Weight: 0.7734,
      MetalContent: 'Silver',
      CoinSet: null,
      PmWeightGrams: 24.06,
      PmPercent: 90,
    };

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [coinRow] })                                              // 1. coins
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123', ImageData: 'data:image/png;base64,abc' }] }) // 2. images
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123', ImageCount: 1 }] });                // 3. image counts

    const res = await request(app).get('/api/coins');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const coin = res.body[0];
    expect(coin.id).toBe('abc-123');
    expect(coin.denomination).toBe('$1');
    expect(coin.coinType).toBe('Morgan');
    expect(coin.year).toBe('1921');
    expect(coin.grade).toBe('MS-65');
    expect(coin.hasCacSticker).toBe(true);
    expect(coin.imagePaths).toEqual(['data:image/png;base64,abc']);
    // The tag feature is gone, so the key must not come back at all.
    expect(coin).not.toHaveProperty('tags');
    // The coin-level dealer field is gone too, so the key must not come back
    // even if an old database still has the column. (Transaction rows keep
    // their own dealer; that is served by GET /api/transactions.)
    expect(coin).not.toHaveProperty('dealer');
    expect(coin.weight).toBe(0.7734);
    expect(coin.metalContent).toBe('Silver');
    expect(coin.pmWeightGrams).toBe(24.06);
    expect(coin.pmPercent).toBe(90);
  });
});

describe('GET /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/coins/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns a single coin with its images', async () => {
    // Mock data uses CamelCase database column names
    const coinRow = {
      CoinId: 'xyz-789',
      Denomination: '1¢',
      Year: '1909',
      CoinType: 'Lincoln',
      Category: null,
      Country: 'USA',
      Grade: 'VF-30',
      CertCompany: 'NGC',
      CertNumber: '99999',
      Variety: 'VDB',
      MintMark: 'S',
      Composition: 'Copper',
      PurchaseDate: null,
      PurchasePrice: 1200,
      CurrentValue: 1500,
      Notes: null,
      Source: 'quicken',
      HasCacSticker: 0,
      SoldPrice: null,
      SoldDate: null,
      Weight: null,
      MetalContent: null,
      CoinSet: null,
    };

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [coinRow] }) // 1. coin
      .mockResolvedValueOnce({ recordset: [] });       // 2. images

    const res = await request(app).get('/api/coins/xyz-789');
    expect(res.status).toBe(200);
    expect(res.body.denomination).toBe('1¢');
    expect(res.body.coinType).toBe('Lincoln');
    expect(res.body.year).toBe('1909');
    expect(res.body.hasCacSticker).toBe(false);
    expect(res.body.imagePaths).toEqual([]);
    expect(res.body).not.toHaveProperty('tags');

    // Exactly two queries, and neither of them touches the dropped table.
    expect(mockRequest.query).toHaveBeenCalledTimes(2);
    for (const call of mockRequest.query.mock.calls) {
      expect(call[0] as string).not.toContain('CoinTags');
    }
  });
});
