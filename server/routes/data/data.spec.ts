/**
 * HTTP tests for the non-coin data routes (spot prices and settings), against
 * real rows in the in-memory database. POST /api/log isn't tested here: it
 * always answers 204 and the logger has its own tests.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import {
  executedSql,
  queryRows,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';

// Transactions API: removed. The endpoints must be gone; purchase/sale fields
// are covered in routes/coins/writes.spec.ts.

describe('the transaction endpoints no longer exist', () => {
  it('no longer answers GET /api/transactions with a transaction list', async () => {
    // Not a 404: the SPA fallback handles any unmatched GET (and its response
    // depends on whether dist/ exists). So assert that no database query ran,
    // and check the body's shape rather than its content type.
    const res = await request(app).get('/api/transactions');

    expect(executedSql()).toEqual([]);
    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body).not.toHaveProperty('transactions');
  });

  it('404s on POST /api/transactions', async () => {
    // A surviving POST would be a second, unvalidated write path.
    const res = await request(app)
      .post('/api/transactions')
      .send({ coinId: 'abc-123', type: 'sale', date: '2024-06-15', amount: 10 });
    expect(res.status).toBe(404);
  });
});

// Spot Prices API

describe('GET /api/spot-prices/latest', () => {
  it('returns zeros when no prices exist', async () => {
    const res = await request(app).get('/api/spot-prices/latest');
    expect(res.status).toBe(200);
    expect(res.body.gold).toBe(0);
    expect(res.body.silver).toBe(0);
  });

  it('returns latest spot prices', async () => {
    // Two rows: "latest" is ORDER BY FetchedAt DESC (ISO text sorts by time).
    await withTestDb((database) => {
      const insert = database.prepare(
        `INSERT INTO SpotPrices (Gold, Silver, Platinum, Copper, Source, FetchedAt)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      insert.run(1900.0, 20.0, 900.0, 3.0, 'older', '2024-02-01T12:00:00.000Z');
      insert.run(2350.5, 28.75, 1025.0, 4.15, 'metals.live', '2024-03-01T12:00:00.000Z');
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
    const res = await request(app)
      .post('/api/spot-prices')
      .send({ gold: 2400, silver: 30, platinum: 1050, copper: 4.2, source: 'metals.live' });
    expect(res.status).toBe(201);

    // The reported id is the id of the stored row.
    const rows = await queryRows('SELECT * FROM SpotPrices');
    expect(rows).toHaveLength(1);
    expect(res.body.id).toBe(rows[0]['SpotPriceId']);
    expect(res.body.fetchedAt).toBe(rows[0]['FetchedAt']);
    expect(rows[0]['Gold']).toBe(2400);
    expect(rows[0]['Copper']).toBe(4.2);
  });

  // A zero is not a price: an all-zero row would break melt values on every
  // launch, since the client applies the latest row at start-up.

  it('refuses an all-zero price set without touching the database', async () => {
    const res = await request(app)
      .post('/api/spot-prices')
      .send({ gold: 0, silver: 0, platinum: 0, copper: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/zero/i);
    // No statement ran: the guard fires before the database is touched.
    expect(executedSql()).toEqual([]);
  });

  it('refuses a body with no prices at all', async () => {
    // Missing counts as zero (Number(undefined) is NaN, so it needs its own check).
    const res = await request(app).post('/api/spot-prices').send({});

    expect(res.status).toBe(400);
    expect(executedSql()).toEqual([]);
  });

  it('refuses non-numeric junk the same way', async () => {
    const res = await request(app)
      .post('/api/spot-prices')
      .send({ gold: 'n/a', silver: null, platinum: '', copper: undefined });

    expect(res.status).toBe(400);
    expect(executedSql()).toEqual([]);
  });

  it('ACCEPTS a partial set where only one metal has a price', async () => {
    // All-zero, not any-zero: partial sets are normal.
    const res = await request(app)
      .post('/api/spot-prices')
      .send({ gold: 2400, silver: 0, platinum: 0, copper: 0 });

    expect(res.status).toBe(201);
    const rows = await queryRows('SELECT Gold, Silver FROM SpotPrices');
    expect(rows).toHaveLength(1);
    expect(rows[0]['Gold']).toBe(2400);
    expect(rows[0]['Silver']).toBe(0);
  });

  it('refuses a negative set, which is no more a price than zero', async () => {
    const res = await request(app)
      .post('/api/spot-prices')
      .send({ gold: -1, silver: -2, platinum: 0, copper: 0 });

    expect(res.status).toBe(400);
    expect(executedSql()).toEqual([]);
  });
});

// Settings API

describe('GET /api/settings/:key', () => {
  it('returns 404 for non-existent setting', async () => {
    const res = await request(app).get('/api/settings/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns a JSON-parsed setting value', async () => {
    await withTestDb((database) => {
      database
        .prepare('INSERT INTO AppSettings (SettingKey, SettingValue) VALUES (?, ?)')
        .run('visibleColumns', '["col1","col2"]');
    });

    const res = await request(app).get('/api/settings/visibleColumns');
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('visibleColumns');
    expect(res.body.value).toEqual(['col1', 'col2']);
  });

  it('returns a plain string setting value', async () => {
    await withTestDb((database) => {
      database
        .prepare('INSERT INTO AppSettings (SettingKey, SettingValue) VALUES (?, ?)')
        .run('theme', 'dark');
    });

    const res = await request(app).get('/api/settings/theme');
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('dark');
  });
});

describe('PUT /api/settings/:key', () => {
  it('upserts a setting', async () => {
    const res = await request(app)
      .put('/api/settings/visibleColumns')
      .send({ value: ['coinType', 'grade', 'value'] });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('visibleColumns');

    const rows = await queryRows('SELECT SettingValue FROM AppSettings WHERE SettingKey = @key', {
      key: 'visibleColumns',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]['SettingValue']).toBe('["coinType","grade","value"]');
  });

  it('overwrites an existing value rather than failing on the primary key', async () => {
    // SettingKey is the primary key, so losing ON CONFLICT would give a 409.
    await request(app).put('/api/settings/theme').send({ value: 'light' });
    const res = await request(app).put('/api/settings/theme').send({ value: 'dark' });

    expect(res.status).toBe(200);
    const rows = await queryRows('SELECT SettingValue FROM AppSettings WHERE SettingKey = @key', {
      key: 'theme',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]['SettingValue']).toBe('dark');
  });
});
