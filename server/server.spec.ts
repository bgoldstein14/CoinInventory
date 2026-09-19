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
import { buildDbConfig } from './db';

beforeEach(() => {
  vi.clearAllMocks();
  mockRecordset.length = 0;
  mockRowsAffected[0] = 1;
  mockRequest.query.mockResolvedValue({ recordset: mockRecordset, rowsAffected: mockRowsAffected });
});

describe('buildDbConfig', () => {
  it('normalizes SQL Server host/port values when server includes a comma', () => {
    const previousServer = process.env.DB_SERVER;
    const previousPort = process.env.DB_PORT;
    const previousUser = process.env.DB_USER;

    try {
      process.env.DB_SERVER = 'localhost,1433';
      process.env.DB_PORT = '1433';
      delete process.env.DB_USER;

      const config = buildDbConfig();
      expect(config.server).toBe('localhost');
      expect(config.port).toBe(1433);
    } finally {
      if (previousServer === undefined) delete process.env.DB_SERVER;
      else process.env.DB_SERVER = previousServer;

      if (previousPort === undefined) delete process.env.DB_PORT;
      else process.env.DB_PORT = previousPort;

      if (previousUser === undefined) delete process.env.DB_USER;
      else process.env.DB_USER = previousUser;
    }
  });
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
