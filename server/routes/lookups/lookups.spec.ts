/**
 * routes/lookups/lookups.spec.ts — HTTP-level tests for the reference tables:
 * categories, metal contents, coin sets, denominations and mint marks.
 *
 * The "without injecting a duplicate static catalog" tests are regression
 * guards: denominations and mint marks used to be merged with a hard-coded
 * list in the server, which produced duplicate dropdown entries. They must
 * return exactly what the database returned, nothing more.
 *
 * *** THE REFERENCE DATA IS REAL NOW. *** These run against the in-memory
 * SQLite database built from db/schema.sql and seeded by db/seed.ts: 1,207
 * denominations, 15 metal contents, 9 mint marks and 2 categories. Where a
 * test needs to assert an EXACT response — which is the whole point of the
 * duplicate-catalog guards — it narrows the table to one row first, rather
 * than canning a recordset that the schema might not even accept.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { queryRows, withTestDb, rebuildTestDatabase } from '../../test-support/sqlite-test-db';
import { app } from '../../server';

// These tests add categories and coin sets and narrow the seeded
// Denominations and MintMarks tables, none of which the ordinary per-test
// reset touches.
beforeEach(async () => {
  await rebuildTestDatabase();
});

// Categories API

describe('GET /api/categories', () => {
  it('returns category names', async () => {
    // Server reads row['CategoryName']. The two the seed ships with are
    // real rows, so only Gold and Silver have to be arranged.
    await withTestDb((database) => {
      database.exec("INSERT INTO Categories (CategoryName) VALUES ('Gold'), ('Silver')");
    });

    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    // ORDER BY CategoryName, so the seeded two interleave with the new ones.
    expect(res.body).toEqual(['20th Cent. Type', 'Gold', 'Odd Type Set', 'Silver']);
  });
});

describe('GET /api/metalcontents', () => {
  it('returns canonical metal-content names', async () => {
    const res = await request(app).get('/api/metalcontents');
    expect(res.status).toBe(200);
    // ORDER BY SortOrder, which is METAL_CONTENT_SEED's display order —
    // NOT alphabetical, which would open the list on Aluminum.
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
    // Still an exact `toEqual`, which is the point of the test: the response
    // is the database rows and nothing else. It gained issuerId, issuerName
    // and faceValue when the maintenance screen was rebuilt to group by
    // issuer — three columns of the same row, not an injected
    // extra entry.
    //
    // The table is narrowed to ONE ROW first. Exact equality against 1,207
    // seeded rows would assert nothing a reader could check; against one it
    // says precisely what the wire shape is.
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
    // Narrowed to one row for the same reason as the denominations guard
    // above: an exact `toEqual` is only readable against a known single row.
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

    // The duplicate-safe part, asserted on the TABLE rather than on the
    // SQL text: CategoryName is the PRIMARY KEY and it is COLLATE NOCASE,
    // so a second insert of 'SILVER' would be a constraint violation and a
    // 500 if the INSERT ... WHERE NOT EXISTS guard were dropped. It is a
    // no-op instead, and the table still holds exactly one row.
    const second = await request(app).post('/api/categories').send({ name: 'SILVER' });
    expect(second.status).toBe(201);

    const stored = await queryRows("SELECT CategoryName FROM Categories WHERE CategoryName = 'silver'");
    expect(stored).toEqual([{ CategoryName: 'silver' }]);

    // The LTRIM/RTRIM half of the same guard, which the PRIMARY KEY does NOT
    // cover: '  gold  ' and 'Gold' are two different strings to the index,
    // so only the query's trimming stops the picker growing a second Gold.
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
    // Server reads row['SetName']. CoinSets is the one lookup table the
    // seed does not fill — it is entirely user-made — so the rows are
    // arranged here.
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
