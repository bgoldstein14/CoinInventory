/**
 * HTTP tests for categories, metal contents, coin sets, denominations and
 * mint marks, against the seeded in-memory database. The "no duplicate static
 * catalog" tests guard against merging a hard-coded list into the response;
 * they narrow the table to one row so the exact comparison is readable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { queryRows, withTestDb, rebuildTestDatabase } from '../../test-support/sqlite-test-db';
import { app } from '../../server';

// These tests change lookup tables the per-test reset doesn't touch.
beforeEach(async () => {
  await rebuildTestDatabase();
});

// Categories API

describe('GET /api/categories', () => {
  it('returns category names', async () => {
    // The seed ships two categories; Gold and Silver are added.
    await withTestDb((database) => {
      database.exec("INSERT INTO Categories (CategoryName) VALUES ('Gold'), ('Silver')");
    });

    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    // Ordered by name, so seeded and new rows interleave.
    expect(res.body).toEqual(['20th Cent. Type', 'Gold', 'Odd Type Set', 'Silver']);
  });
});

describe('GET /api/metalcontents', () => {
  it('returns canonical metal-content names', async () => {
    const res = await request(app).get('/api/metalcontents');
    expect(res.status).toBe(200);
    // SortOrder (the seed's display order), not alphabetical.
    expect(res.body).toEqual([
      'Gold',
      'Silver',
      'Platinum',
      'Palladium',
      'Copper',
      'Nickel',
      'Copper-Nickel',
      'Bronze',
      'Brass',
      'Zinc',
      'Steel',
      'Aluminum',
      'Nickel-Brass',
      'Clad',
      'Other',
    ]);
  });
});

describe('GET /api/denominations', () => {
  it('returns the frontend-compatible denomination shape', async () => {
    const res = await request(app).get('/api/denominations');
    expect(res.status).toBe(200);

    const quarter = res.body.find(
      (d: { label: string; issuerName: string }) => d.label === '25¢' && d.issuerName === 'United States'
    );
    expect(quarter).toMatchObject({
      denominationId: expect.any(Number),
      label: '25¢',
      country: 'US',
      isActive: true,
    });
  });

  it('returns the database denomination rows without injecting a duplicate static catalog', async () => {
    // Exact equality against one row: the response is the row's columns and
    // nothing injected.
    const [mexico] = await queryRows("SELECT IssuerId FROM Issuers WHERE Name = 'Mexico'");
    const [reales] = await queryRows(
      "SELECT DenominationId FROM Denominations WHERE Label = '8 Reales' AND IssuerId = @id",
      { id: Number(mexico['IssuerId']) }
    );
    await withTestDb((database) => {
      database
        .prepare('DELETE FROM Denominations WHERE DenominationId <> @id')
        .run({ id: Number(reales['DenominationId']) });
    });

    const res = await request(app).get('/api/denominations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        denominationId: Number(reales['DenominationId']),
        label: '8 Reales',
        country: 'MX',
        issuerId: Number(mexico['IssuerId']),
        issuerName: 'Mexico',
        faceValue: 8,
        sortOrder: 60,
        isActive: true,
      },
    ]);
  });
});

describe('GET /api/mintmarks', () => {
  it('returns the frontend-compatible mint mark shape', async () => {
    const res = await request(app).get('/api/mintmarks');
    expect(res.status).toBe(200);

    const denver = res.body.find((mark: { label: string }) => mark.label === 'D');
    expect(denver).toMatchObject({
      mintMarkId: expect.any(Number),
      label: 'D',
      description: 'Denver/Dahlonega',
      isActive: true,
    });
  });

  it('returns the database mint-mark rows without injecting a duplicate static catalog', async () => {
    // Narrowed to one row, as above.
    await withTestDb((database) => {
      database.exec("DELETE FROM MintMarks WHERE Label <> 'D'");
    });
    const [denver] = await queryRows("SELECT MintMarkId FROM MintMarks WHERE Label = 'D'");

    const res = await request(app).get('/api/mintmarks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        mintMarkId: Number(denver['MintMarkId']),
        label: 'D',
        description: 'Denver/Dahlonega',
        isActive: true,
      },
    ]);
  });
});

describe('POST /api/categories', () => {
  it('returns 400 for missing name', async () => {
    const res = await request(app).post('/api/categories').send({});
    expect(res.status).toBe(400);
  });

  it('creates a category and returns 201', async () => {
    const res = await request(app)
      .post('/api/categories')
      .send({ name: 'Platinum' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Platinum');

    expect(await queryRows("SELECT CategoryName FROM Categories WHERE CategoryName = 'Platinum'")).toEqual([
      { CategoryName: 'Platinum' },
    ]);
  });

  it('normalizes whitespace and uses a duplicate-safe query', async () => {
    const res = await request(app)
      .post('/api/categories')
      .send({ name: '  silver  ' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('silver');

    // Checked on the table: a second 'SILVER' is a no-op, not a primary key
    // violation (CategoryName is COLLATE NOCASE).
    const second = await request(app).post('/api/categories').send({ name: 'SILVER' });
    expect(second.status).toBe(201);

    const stored = await queryRows("SELECT CategoryName FROM Categories WHERE CategoryName = 'silver'");
    expect(stored).toEqual([{ CategoryName: 'silver' }]);

    // The trimming half, which the primary key doesn't cover.
    await withTestDb((database) => {
      database.exec("INSERT INTO Categories (CategoryName) VALUES ('  gold  ')");
    });
    const third = await request(app).post('/api/categories').send({ name: 'Gold' });
    expect(third.status).toBe(201);

    const golds = await queryRows(
      "SELECT CategoryName FROM Categories WHERE LOWER(LTRIM(RTRIM(CategoryName))) = 'gold'"
    );
    expect(golds).toHaveLength(1);
  });
});

describe('DELETE /api/categories/:name', () => {
  it('returns 404 for non-existent category', async () => {
    const res = await request(app).delete('/api/categories/Nonexistent');
    expect(res.status).toBe(404);
  });
});

// Coin Sets API

describe('GET /api/coin-sets', () => {
  it('returns set names', async () => {
    // CoinSets isn't seeded, so rows are arranged here.
    await withTestDb((database) => {
      database.exec("INSERT INTO CoinSets (SetName) VALUES ('Morgan Set'), ('Peace Set')");
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
    const res = await request(app)
      .post('/api/coin-sets')
      .send({ name: 'Walking Liberty Set' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Walking Liberty Set');

    expect(await queryRows('SELECT SetName FROM CoinSets')).toEqual([{ SetName: 'Walking Liberty Set' }]);
  });
});
