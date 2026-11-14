/**
 * routes/data/data.spec.ts — HTTP-level tests for the non-coin data routes:
 * transactions, spot prices and settings.
 *
 * *** NOTHING HERE IS CANNED ANY MORE. *** Rows are inserted into a real
 * in-memory SQLite database built from db/schema.sql and read back through
 * the real query the route runs. Where a test used to queue a recordset on a
 * hand-written mock it now arranges the row, and where it used to assert that
 * the mock was or was not called it now asserts on the statements the data
 * layer actually executed (executedSql) or on the rows that ended up in the
 * table (queryRows).
 *
 * TWO THINGS THE MOCK USED TO HIDE, both visible below:
 *   - Transactions.CoinId is a FOREIGN KEY to Coins with no cascade on
 *     insert, so a transaction cannot be created for a coin that does not
 *     exist. The mock accepted one happily.
 *   - SpotPrices.SpotPriceId is assigned by the database, not by the test, so
 *     the assertion is now "the id the route reported is the id of the row
 *     that exists" rather than a number the mock was told to return.
 *
 * (There is no test for POST /api/log: it writes to app.log and always answers
 * 204, so there is nothing to assert that the logger's own behaviour does not
 * already cover.)
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import {
  executedSql,
  insertCoin,
  queryRows,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';

// Transactions API

describe('GET /api/transactions', () => {
  it('returns all transactions', async () => {
    // Server reads CamelCase column names: TransactionId, CoinId, TransactionType, TransactionDate, Amount, Dealer, Notes
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1' });
    await withTestDb((database) => {
      database
        .prepare(
          `INSERT INTO Transactions
             (TransactionId, CoinId, TransactionType, TransactionDate, Amount, Dealer, Notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('tx-1', 'abc-123', 'purchase', '2024-03-01', 150.0, 'Heritage', 'Won auction');
    });

    const res = await request(app).get('/api/transactions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].coinId).toBe('abc-123');
    expect(res.body[0].type).toBe('purchase');
  });

  it('filters by coinId', async () => {
    // Two coins, one transaction each: a filter that is ignored would return
    // both, which the mock could never have shown.
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1' });
    await insertCoin({ CoinId: 'other-9', Denomination: '25¢' });
    await withTestDb((database) => {
      const insert = database.prepare(
        `INSERT INTO Transactions (TransactionId, CoinId, TransactionType, TransactionDate, Amount)
         VALUES (?, ?, 'purchase', '2024-03-01', 10)`
      );
      insert.run('tx-mine', 'abc-123');
      insert.run('tx-theirs', 'other-9');
    });

    const res = await request(app).get('/api/transactions?coinId=abc-123');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('tx-mine');
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
    // The coin has to exist: Transactions.CoinId REFERENCES Coins (CoinId).
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1' });

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

    // The row really landed, with the values the request carried.
    const rows = await queryRows('SELECT * FROM Transactions WHERE TransactionId = @id', {
      id: 'tx-2',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]['CoinId']).toBe('abc-123');
    expect(rows[0]['TransactionType']).toBe('sale');
    expect(rows[0]['TransactionDate']).toBe('2024-06-15');
    expect(rows[0]['Amount']).toBe(250.0);
  });

  it('refuses a transaction for a coin that does not exist', async () => {
    /*
     * NEW, AND ONLY POSSIBLE AGAINST A REAL ENGINE. The mock accepted this
     * INSERT and answered 201, so the suite's idea of this endpoint was
     * "anything goes". The schema says otherwise — FK_Transactions_Coin —
     * and the foreign key is enforced (db/driver.ts turns the pragma on), so
     * the real answer is the 409 that routes/db-error-response.ts gives a
     * constraint violation.
     */
    const res = await request(app)
      .post('/api/transactions')
      .send({ id: 'tx-orphan', coinId: 'no-such-coin', type: 'sale', date: '2024-06-15', amount: 1 });

    expect(res.status).toBe(409);
    expect(await queryRows('SELECT * FROM Transactions')).toEqual([]);
  });
});

describe('DELETE /api/transactions/:id', () => {
  it('returns 404 for non-existent transaction', async () => {
    const res = await request(app).delete('/api/transactions/nonexistent');
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
    // Server reads CamelCase column names: Gold, Silver, Platinum, Copper, Source, FetchedAt
    // Two rows, so "latest" has to mean something: the route orders by
    // FetchedAt DESC, which is lexicographic over ISO-8601 text.
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

    // SpotPriceId comes from the RETURNING clause, so the id the route
    // reported must be the id of the row that now exists. (The mock simply
    // asserted the number 1, which proved only that the mock said 1.)
    const rows = await queryRows('SELECT * FROM SpotPrices');
    expect(rows).toHaveLength(1);
    expect(res.body.id).toBe(rows[0]['SpotPriceId']);
    expect(res.body.fetchedAt).toBe(rows[0]['FetchedAt']);
    expect(rows[0]['Gold']).toBe(2400);
    expect(rows[0]['Copper']).toBe(4.2);
  });

  // "A zero is not a price"
  // A precious metal never trades at zero, so a zero means "no price". This
  // endpoint is the one place that matters most, because /spot-prices/latest
  // reads the newest row back and the client applies it at start-up: a single
  // all-zero row would blank every melt value on every subsequent launch.

  it('refuses an all-zero price set without touching the database', async () => {
    const res = await request(app)
      .post('/api/spot-prices')
      .send({ gold: 0, silver: 0, platinum: 0, copper: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/zero/i);
    // The important half: no INSERT was attempted. executedSql() is every
    // statement the data layer ran during this test, so an empty list means
    // the guard fired before the database was opened at all.
    expect(executedSql()).toEqual([]);
  });

  it('refuses a body with no prices at all', async () => {
    // Missing is no more a price than zero is, and Number(undefined) is NaN
    // rather than 0, so this needs its own check.
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
    // Deliberately all-zero and not any-zero. The four metals are fetched as
    // independent symbols, so silver succeeding while platinum fails is
    // normal, and a user may only care about gold. The zeros simply mean "no
    // price for that metal".
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
    /*
     * NEW. The ON CONFLICT ... DO UPDATE upsert was untestable against the
     * mock: nothing in it had a primary key, so the second PUT could not have
     * conflicted with the first and a plain INSERT would have passed. Here
     * AppSettings.SettingKey really is the primary key, so an implementation
     * that lost the ON CONFLICT clause would answer 409 instead of 200.
     */
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
