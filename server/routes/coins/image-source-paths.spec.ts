/**
 * routes/coins/image-source-paths.spec.ts — HTTP tests for
 * POST /api/coins/image-source-paths (routes/coins/image-source-paths.ts).
 *
 * THE BUG THIS ENDPOINT EXISTS TO PREVENT
 * Adding a few new photos to an already-imported folder makes the import
 * screen want to attach every photo in it again, including the hundreds
 * already on their coins. It has no way to tell an already-attached file from
 * a new one, because the only thing that identifies a source file
 * (`CoinImages.SourcePath`) does not otherwise reach the browser:
 * `CoinRecord.imagePaths` carries the downscaled `data:` URLs and nothing
 * else.
 *
 * The per-coin endpoint GET /api/coins/:id/images does return SourcePath, but
 * a review screen routinely covers a hundred-odd coins and that many requests
 * is not an option. Hence one batched POST.
 *
 * THE ASSERTION THAT MATTERS MOST IN THIS FILE
 * "does not select ImageData". ImageData holds the base64 blobs that make up
 * virtually the whole database; pulling a hundred coins' worth of them across
 * to answer a question about file NAMES would be slower than the per-coin
 * requests this endpoint replaces. The column list is therefore part of the
 * contract, not an implementation detail — and it is a contract no returned
 * ROW can reveal, which is why it stays a SQL-text assertion while almost
 * everything else in this file became an assertion about real data.
 *
 * *** THE ROWS ARE REAL NOW. *** They are inserted into an in-memory SQLite
 * database built from db/schema.sql and come back through the parameterised
 * IN list the handler really builds. The previous version satisfied the one
 * query with a canned recordset, so `WHERE SourcePath IS NOT NULL AND CoinId
 * IN (...)` was never executed and could have been anything at all.
 *
 * CoinImages has a FOREIGN KEY to Coins and foreign keys are enforced, so
 * every test inserts its coins before their photographs.
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
    // Within a coin the order is incidental — the handler runs no ORDER BY
    // because the client builds a set out of this (see the route header). It
    // is asserted as an array anyway, since that is what the endpoint
    // actually produces and a silent change is worth noticing.
    expect(res.body.results).toEqual({
      morgan: [
        'D:\\Coin Pictures\\morgan obverse.jpg',
        'D:\\Coin Pictures\\morgan reverse.jpg',
      ],
      peace: ['D:\\Coin Pictures\\peace obverse.jpg'],
    });
  });

  it('returns an empty array for a requested coin that has no recorded paths', async () => {
    // The caller asked about three coins; the database knows paths for one,
    // knows a second coin with no photographs at all, and has never heard of
    // the third. Every requested id must still appear, so the client can
    // treat a missing key as a bug rather than as "no photos".
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
    // The whole point of the endpoint. A row cannot show which columns were
    // NOT fetched, so this is the one thing here that must stay text.
    expect(sql).not.toContain('ImageData');
    expect(sql).not.toContain('SELECT *');
  });

  it('skips rows whose SourcePath is NULL', async () => {
    // Every image imported before the SourcePath column existed has a NULL
    // there. A null in the answer would be compared against a real path and
    // would never match, but it would also make the array lengths lie. The
    // NULL is excluded by the WHERE clause and the whitespace-only one by the
    // handler — two different guards, both exercised for real here.
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

    // The id is DATA: it matches that coin's row...
    expect(res.body.results[nasty]).toEqual(['D:\\pics\\a.jpg']);
    // ...and — the assertion the mock could never make, because it never ran
    // the statement — the Coins table is still standing afterwards.
    expect(await queryRows('SELECT CoinId FROM Coins')).toHaveLength(2);

    // Bound with the CoinImages.CoinId type, exactly like every other
    // handler. The type is now db/column-types.ts's descriptor rather than an
    // `mssql` object; `declared` is the verbatim SQL Server type it replaced.
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
    /*
     * NEW, AND ONLY MEANINGFUL AGAINST A REAL ENGINE. The cap exists because
     * each id becomes one bound parameter in an IN list and the engine has a
     * ceiling on how many a statement may carry. Under the mock the statement
     * was never compiled, so a cap that exceeded the real limit would have
     * gone unnoticed until an import of 500 coins failed in front of a user.
     * This compiles and runs the widest statement the endpoint will ever
     * build.
     */
    const ids = Array.from({ length: MAX_COIN_IDS_PER_REQUEST }, (_, i) => `coin-${i}`);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ids });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.results)).toHaveLength(MAX_COIN_IDS_PER_REQUEST);
    expect(executedSql()).toHaveLength(1);
  });

  it('reports a database failure as a 500 through sendDbError', async () => {
    /*
     * THE FAULT IS INJECTED INTO THE DATABASE, not into a mock's promise.
     * Dropping the table the handler reads makes the real statement fail with
     * a real SQLite error, which db/sql-api.ts translates and
     * routes/db-error-response.ts classifies. "No such table" carries no SQL
     * Server error number, so it lands in the generic 500 branch.
     *
     * The schema has to be put back by hand: resetTestDatabase() only DELETEs
     * from the tables, and would itself fail against a dropped one.
     */
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
    // POST / (create a coin) and POST /image-source-paths are both POSTs under
    // the same router. If the mount order ever let the coin-create handler see
    // this path, the request would 201 with a brand new coin instead.
    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan'] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
    // And no junk coin was created, which is the damage that would be done.
    expect(await queryRows('SELECT CoinId FROM Coins')).toEqual([]);
  });
});
