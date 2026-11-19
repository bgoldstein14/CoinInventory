/**
 * HTTP tests for POST /api/coins/image-source-paths, which lets the import
 * screen skip files already attached to coins (one batched request instead of
 * one per coin).
 *
 * The key assertion is "does not select ImageData": those blobs are most of
 * the database, and a row can't show which columns weren't fetched, so it
 * stays a SQL-text assertion. CoinImages has a foreign key to Coins, so coins
 * are inserted first.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import {
  capturedInputs,
  executedSql,
  insertCoin,
  queryRows,
  rebuildTestDatabase,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';
import { MAX_COIN_IDS_PER_REQUEST } from './image-source-paths';

/** Inserts the coins named, then one image row per entry given. */
async function givenImages(
  rows: Array<{ CoinId: string; SourcePath: string | null; SortOrder?: number }>,
  extraCoins: string[] = []
): Promise<void> {
  const coinIds = new Set([...rows.map((row) => row.CoinId), ...extraCoins]);
  for (const coinId of coinIds) {
    await insertCoin({ CoinId: coinId, Denomination: '$1' });
  }
  await withTestDb((database) => {
    const insert = database.prepare(
      'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) ' +
        'VALUES (@coinId, @imageData, @sortOrder, @sourcePath)'
    );
    rows.forEach((row, index) => {
      insert.run({
        coinId: row.CoinId,
        imageData: 'data:image/jpeg;base64,x',
        sortOrder: row.SortOrder ?? index,
        sourcePath: row.SourcePath,
      });
    });
  });
}

/** Every value bound by the request, in binding order. */
function boundValues(): unknown[] {
  return capturedInputs().map((entry) => entry.value);
}

describe('POST /api/coins/image-source-paths', () => {
  it('groups the source paths by coin id', async () => {
    await givenImages([
      { CoinId: 'morgan', SourcePath: 'D:\\Coin Pictures\\morgan obverse.jpg', SortOrder: 0 },
      { CoinId: 'morgan', SourcePath: 'D:\\Coin Pictures\\morgan reverse.jpg', SortOrder: 1 },
      { CoinId: 'peace', SourcePath: 'D:\\Coin Pictures\\peace obverse.jpg', SortOrder: 0 },
    ]);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan', 'peace'] });

    expect(res.status).toBe(200);
    // Order within a coin is incidental (no ORDER BY), but asserted as returned.
    expect(res.body.results).toEqual({
      morgan: [
        'D:\\Coin Pictures\\morgan obverse.jpg',
        'D:\\Coin Pictures\\morgan reverse.jpg',
      ],
      peace: ['D:\\Coin Pictures\\peace obverse.jpg'],
    });
  });

  it('returns an empty array for a requested coin that has no recorded paths', async () => {
    // Every requested id appears: one with paths, one with no photos, one unknown.
    await givenImages([{ CoinId: 'morgan', SourcePath: 'D:\\pics\\a.jpg' }], ['peace']);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan', 'peace', 'mercury'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual({
      morgan: ['D:\\pics\\a.jpg'],
      peace: [],
      mercury: [],
    });
  });

  it('does NOT select ImageData — only the two columns it needs', async () => {
    await givenImages([{ CoinId: 'morgan', SourcePath: 'D:\\pics\\a.jpg' }]);

    await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan'] });

    const sql = executedSql()[0] as string;
    expect(sql).toContain('FROM CoinImages');
    expect(sql).toContain('CoinId');
    expect(sql).toContain('SourcePath');
    // The point of the endpoint; must stay a text assertion.
    expect(sql).not.toContain('ImageData');
    expect(sql).not.toContain('SELECT *');
  });

  it('skips rows whose SourcePath is NULL', async () => {
    // NULL is excluded by the WHERE clause, whitespace-only by the handler.
    await givenImages([
      { CoinId: 'morgan', SourcePath: null },
      { CoinId: 'morgan', SourcePath: 'D:\\pics\\a.jpg' },
      { CoinId: 'morgan', SourcePath: '   ' },
    ]);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan'] });

    expect(res.body.results).toEqual({ morgan: ['D:\\pics\\a.jpg'] });
  });

  it('binds every coin id as a parameter rather than inlining it', async () => {
    const nasty = "morgan'; DROP TABLE Coins; --";
    await givenImages([{ CoinId: nasty, SourcePath: 'D:\\pics\\a.jpg' }], ['peace']);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: [nasty, 'peace'] });

    const sql = executedSql()[0] as string;
    expect(sql).not.toContain('DROP TABLE');
    expect(boundValues()).toEqual([nasty, 'peace']);

    // The id is data: it matches that coin's row...
    expect(res.body.results[nasty]).toEqual(['D:\\pics\\a.jpg']);
    // ...and the Coins table still exists.
    expect(await queryRows('SELECT CoinId FROM Coins')).toHaveLength(2);

    // Bound with the CoinImages.CoinId type.
    expect(capturedInputs()[0]?.type).toMatchObject({
      storage: 'text',
      maxLength: 36,
      declared: 'NVARCHAR(36)',
    });
  });

  it('de-duplicates the requested coin ids', async () => {
    await givenImages([], ['morgan', 'peace']);

    await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan', 'morgan', 'peace', 'morgan'] });

    expect(boundValues()).toEqual(['morgan', 'peace']);
  });

  it('answers an empty request without touching the database', async () => {
    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual({});
    expect(executedSql()).toEqual([]);
  });

  it('drops non-string entries rather than binding them', async () => {
    await givenImages([], ['morgan']);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan', 42, null, { id: 'x' }] });

    expect(res.status).toBe(200);
    expect(boundValues()).toEqual(['morgan']);
    expect(res.body.results).toEqual({ morgan: [] });
  });

  it('rejects a body with no coinIds array', async () => {
    const res = await request(app).post('/api/coins/image-source-paths').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('coinIds');
    expect(executedSql()).toEqual([]);
  });

  it('rejects more coin ids than the cap allows', async () => {
    const tooMany = Array.from({ length: MAX_COIN_IDS_PER_REQUEST + 1 }, (_, i) => `coin-${i}`);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: tooMany });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(MAX_COIN_IDS_PER_REQUEST));
    expect(executedSql()).toEqual([]);
  });

  it('answers a full-cap request in one statement', async () => {
    // Runs the widest statement the endpoint can build (MAX_COIN_IDS_PER_REQUEST
    // bound parameters), so a cap above the engine's limit would fail here.
    const ids = Array.from({ length: MAX_COIN_IDS_PER_REQUEST }, (_, i) => `coin-${i}`);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ids });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.results)).toHaveLength(MAX_COIN_IDS_PER_REQUEST);
    expect(executedSql()).toHaveLength(1);
  });

  it('reports a database failure as a 500 through sendDbError', async () => {
    // A real database fault (dropped table -> generic 500). The schema is
    // rebuilt by hand, since resetTestDatabase() only clears tables.
    try {
      await withTestDb((database) => database.exec('DROP TABLE CoinImages'));

      const res = await request(app)
        .post('/api/coins/image-source-paths')
        .send({ coinIds: ['morgan'] });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to retrieve image source paths');
    } finally {
      await rebuildTestDatabase();
    }
  });

  it('is not swallowed by POST /api/coins', async () => {
    // Mount order: POST / (create) must not handle this path.
    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan'] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    // No junk coin was created.
    expect(await queryRows('SELECT CoinId FROM Coins')).toEqual([]);
  });
});
