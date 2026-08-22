import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const { mockRecordset, mockRowsAffected, mockRequest, mockTransaction, mockPool } = vi.hoisted(() => {
  const mockRecordset: Record<string, unknown>[] = [];
  const mockRowsAffected = [1];
  const mockRequest = {
    input: vi.fn().mockReturnThis(),
    query: vi.fn().mockResolvedValue({ recordset: mockRecordset, rowsAffected: mockRowsAffected }),
  };
  const mockTransaction = {
    begin: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
  const mockPool = {
    request: vi.fn(() => ({ ...mockRequest, input: vi.fn().mockReturnThis(), query: mockRequest.query })),
  };
  return { mockRecordset, mockRowsAffected, mockRequest, mockTransaction, mockPool };
});

vi.mock('mssql', () => {
  const NVarChar = (len?: number) => ({ type: 'nvarchar', length: len });
  (NVarChar as unknown as { MAX: string }).MAX = 'max';

  class MockTransaction {
    begin = mockTransaction.begin;
    commit = mockTransaction.commit;
    rollback = mockTransaction.rollback;
  }

  class MockRequest {
    input = vi.fn().mockReturnThis();
    query = mockRequest.query;
  }

  return {
    default: {
      connect: vi.fn().mockResolvedValue(mockPool),
      NVarChar,
      Int: { type: 'int' },
      Bit: { type: 'bit' },
      Date: { type: 'date' },
      Decimal: () => ({ type: 'decimal' }),
      Transaction: MockTransaction,
      Request: MockRequest,
      MAX: 'max',
    },
  };
});

// Now import the app
import { app } from './server';

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordset.length = 0;
  mockRowsAffected[0] = 1;
  mockRequest.query.mockResolvedValue({ recordset: mockRecordset, rowsAffected: mockRowsAffected });
});

// ============================================================
// Coins API
// ============================================================

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
    const coinRow = {
      id: 'abc-123',
      name: '1921 Morgan Dollar',
      denomination: '$1',
      year: 1921,
      type: 'Morgan',
      category: 'Silver Dollars',
      country: 'USA',
      grade: 'MS-65',
      cert_company: 'PCGS',
      cert_number: '12345678',
      variety: null,
      mint_mark: 'S',
      composition: '90% Silver',
      purchase_date: '2024-01-15',
      purchase_price: 150.00,
      current_value: 200.00,
      notes: 'Nice toning',
      source: 'manual',
      has_cac_sticker: true,
      sold_price: null,
      sold_date: null,
      dealer: 'Heritage',
      weight: 0.7734,
      metal_content: 'Silver',
      coin_set: null,
    };

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [coinRow] })
      .mockResolvedValueOnce({ recordset: [{ coin_id: 'abc-123', image_data: 'data:image/png;base64,abc' }] })
      .mockResolvedValueOnce({ recordset: [{ coin_id: 'abc-123', tag: 'key-date' }] });

    const res = await request(app).get('/api/coins');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const coin = res.body[0];
    expect(coin.id).toBe('abc-123');
    expect(coin.name).toBe('1921 Morgan Dollar');
    expect(coin.grade).toBe('MS-65');
    expect(coin.hasCacSticker).toBe(true);
    expect(coin.imagePaths).toEqual(['data:image/png;base64,abc']);
    expect(coin.tags).toEqual(['key-date']);
    expect(coin.dealer).toBe('Heritage');
    expect(coin.weight).toBe(0.7734);
    expect(coin.metalContent).toBe('Silver');
  });
});

describe('GET /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/coins/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns a single coin with images and tags', async () => {
    const coinRow = {
      id: 'xyz-789',
      name: '1909-S VDB Lincoln Cent',
      denomination: '1¢',
      year: 1909,
      type: 'Lincoln',
      category: null,
      country: 'USA',
      grade: 'VF-30',
      cert_company: 'NGC',
      cert_number: '99999',
      variety: 'VDB',
      mint_mark: 'S',
      composition: 'Copper',
      purchase_date: null,
      purchase_price: 1200,
      current_value: 1500,
      notes: null,
      source: 'quicken',
      has_cac_sticker: 0,
      sold_price: null,
      sold_date: null,
      dealer: null,
      weight: null,
      metal_content: null,
      coin_set: null,
    };

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [coinRow] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [{ coin_id: 'xyz-789', tag: 'rare' }] });

    const res = await request(app).get('/api/coins/xyz-789');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('1909-S VDB Lincoln Cent');
    expect(res.body.hasCacSticker).toBe(false);
    expect(res.body.imagePaths).toEqual([]);
    expect(res.body.tags).toEqual(['rare']);
  });
});

describe('POST /api/coins', () => {
  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({ denomination: '$1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  it('creates a coin and returns 201 with id', async () => {
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'test-id',
        name: 'Test Coin',
        denomination: '$1',
        year: 2024,
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
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates a coin and returns 200', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ id: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ name: 'Updated Morgan', denomination: '$1' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('abc-123');
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
// Categories API
// ============================================================

describe('GET /api/categories', () => {
  it('returns category names', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ name: 'Gold' }, { name: 'Silver' }],
    });

    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['Gold', 'Silver']);
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
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ name: 'Morgan Set' }, { name: 'Peace Set' }],
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

// ============================================================
// Transactions API
// ============================================================

describe('GET /api/transactions', () => {
  it('returns all transactions', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        id: 'tx-1',
        coin_id: 'abc-123',
        type: 'purchase',
        date: '2024-03-01',
        amount: 150.00,
        dealer: 'Heritage',
        notes: 'Won auction',
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
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        gold: 2350.50,
        silver: 28.75,
        platinum: 1025.00,
        copper: 4.15,
        source: 'metals.live',
        fetched_at: '2024-03-01T12:00:00Z',
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
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ id: 1, fetched_at: '2024-03-01T12:00:00Z' }],
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
      recordset: [{ setting_value: '["col1","col2"]' }],
    });

    const res = await request(app).get('/api/settings/visibleColumns');
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('visibleColumns');
    expect(res.body.value).toEqual(['col1', 'col2']);
  });

  it('returns a plain string setting value', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ setting_value: 'dark' }],
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
      .send({ value: ['name', 'grade', 'value'] });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('visibleColumns');
  });
});
