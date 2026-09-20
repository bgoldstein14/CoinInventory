/**
 * routes/coins/reads.spec.ts — HTTP tests for the read-only coin endpoints
 * (routes/coins/reads.ts).
 *
 * The mock rows below use the CamelCase SQL Server column names on purpose:
 * translating those into the camelCase JSON the Angular app expects is exactly
 * what rowToCoin() in db/row-mappers.ts is being tested for here.
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
      .mockResolvedValueOnce({ recordset: [] })  // coins
      .mockResolvedValueOnce({ recordset: [] })  // images
      .mockResolvedValueOnce({ recordset: [] }); // tags

    const res = await request(app).get('/api/coins');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns coins with images and tags joined', async () => {
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
      Dealer: 'Heritage',
      Weight: 0.7734,
      MetalContent: 'Silver',
      CoinSet: null,
      PmWeightGrams: 24.06,
      PmPercent: 90,
    };

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [coinRow] })
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123', ImageData: 'data:image/png;base64,abc' }] })
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123', Tag: 'key-date' }] });

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
    expect(coin.tags).toEqual(['key-date']);
    expect(coin.dealer).toBe('Heritage');
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

  it('returns a single coin with images and tags', async () => {
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
      Dealer: null,
      Weight: null,
      MetalContent: null,
      CoinSet: null,
    };

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [coinRow] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'xyz-789', Tag: 'rare' }] });

    const res = await request(app).get('/api/coins/xyz-789');
    expect(res.status).toBe(200);
    expect(res.body.denomination).toBe('1¢');
    expect(res.body.coinType).toBe('Lincoln');
    expect(res.body.year).toBe('1909');
    expect(res.body.hasCacSticker).toBe(false);
    expect(res.body.imagePaths).toEqual([]);
    expect(res.body.tags).toEqual(['rare']);
  });
});
