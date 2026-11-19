/**
 * HTTP tests for POST /api/coins/:id/images (images.spec.ts covers GET).
 *
 *   - `sourcePath` is stored in CoinImages.SourcePath, bound at NVARCHAR(400).
 *   - The legacy bare-string body keeps working.
 *   - The batch rolls back as a unit (a partial commit plus a retry would
 *     duplicate images); checked with a real failure mid-batch.
 *
 * Statement order, for the tests that count statements:
 *   1. SELECT CoinId FROM Coins ...              (existence check)
 *   2. SELECT IFNULL(MAX(SortOrder), -1) ...     (where to append from)
 *   3..n INSERT INTO CoinImages ... RETURNING ImageId
 *
 * ImageIds are never reused (sqlite_sequence survives the per-test reset), so
 * tests compare against stored ids rather than literals.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import {
  capturedInputs,
  executedQueries,
  executedSql,
  insertCoin,
  queryRows,
  rebuildTestDatabase,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';

// POST /api/coins/:id/images

/** The coin every test posts to (the foreign key is enforced). */
async function givenCoin(coinId = 'abc-123'): Promise<void> {
  await insertCoin({ CoinId: coinId, Denomination: '$1', Year: '1921' });
}

/** All the `sourcePath` parameters bound during the request, in order. */
function boundSourcePaths(): unknown[] {
  return capturedInputs()
    .filter((entry) => entry.name === 'sourcePath')
    .map((entry) => entry.value);
}

/** The coin's image rows as the database now holds them, in display order. */
function storedImages(coinId = 'abc-123'): Promise<Record<string, unknown>[]> {
  return queryRows(
    'SELECT ImageId, ImageData, SortOrder, SourcePath FROM CoinImages ' +
      'WHERE CoinId = @coinId ORDER BY SortOrder',
    { coinId }
  );
}

describe('POST /api/coins/:id/images', () => {
  it('round-trips sourcePath into the INSERT, bound at the schema length', async () => {
    await givenCoin();

    const res = await request(app)
      .post('/api/coins/abc-123/images')
      .send({
        images: [
          {
            imageData: 'data:image/jpeg;base64,downscaled',
            sourcePath: 'C:\\Coin Pictures\\1921-morgan-obverse.jpg',
          },
        ],
      });

    expect(res.status).toBe(201);

    // Stored with the path intact.
    const rows = await storedImages();
    expect(rows).toHaveLength(1);
    expect(rows[0]['SourcePath']).toBe('C:\\Coin Pictures\\1921-morgan-obverse.jpg');
    expect(rows[0]['ImageData']).toBe('data:image/jpeg;base64,downscaled');

    // The returned ids are the ones assigned, so DELETE can use them.
    expect(res.body.imageIds).toEqual([rows[0]['ImageId']]);

    // Bound as NVARCHAR(400), matching db/schema.sql.
    const sourcePathInput = capturedInputs().find((entry) => entry.name === 'sourcePath');
    expect(sourcePathInput?.value).toBe('C:\\Coin Pictures\\1921-morgan-obverse.jpg');
    expect(sourcePathInput?.type).toMatchObject({
      storage: 'text',
      maxLength: 400,
      declared: 'NVARCHAR(400)',
    });
  });

  it('trims a padded sourcePath and stores an empty one as NULL', async () => {
    await givenCoin();

    const res = await request(app)
      .post('/api/coins/abc-123/images')
      .send({
        images: [
          { imageData: 'data:image/png;base64,a', sourcePath: '  C:\\pics\\a.png  ' },
          { imageData: 'data:image/png;base64,b', sourcePath: '   ' },
        ],
      });

    expect(res.status).toBe(201);
    expect(boundSourcePaths()).toEqual(['C:\\pics\\a.png', null]);

    // One "unknown" in the database (NULL, not '').
    const rows = await storedImages();
    expect(rows.map((row) => row['SourcePath'])).toEqual(['C:\\pics\\a.png', null]);
  });

  // ----- Legacy bare-string bodies -----------------------------------------

  it('still accepts the legacy string form of `images`, storing a null sourcePath', async () => {
    await givenCoin();

    const res = await request(app)
      .post('/api/coins/abc-123/images')
      .send({ images: ['data:image/png;base64,obverse', 'data:image/png;base64,reverse'] });

    expect(res.status).toBe(201);

    const rows = await storedImages();
    expect(rows.map((row) => row['ImageData'])).toEqual([
      'data:image/png;base64,obverse',
      'data:image/png;base64,reverse',
    ]);
    expect(res.body.imageIds).toEqual(rows.map((row) => row['ImageId']));

    // A bare string means the original's location is unknown -> NULL.
    expect(boundSourcePaths()).toEqual([null, null]);
    expect(rows.map((row) => row['SourcePath'])).toEqual([null, null]);
  });

  it('still accepts the legacy single-image `image` / `imageData` keys', async () => {
    await givenCoin();

    const res = await request(app)
      .post('/api/coins/abc-123/images')
      .send({ image: 'data:image/png;base64,single' });

    expect(res.status).toBe(201);

    const rows = await storedImages();
    expect(rows).toHaveLength(1);
    expect(rows[0]['ImageData']).toBe('data:image/png;base64,single');
    expect(res.body.imageIds).toEqual([rows[0]['ImageId']]);
    expect(boundSourcePaths()).toEqual([null]);
  });

  it("appends after the coin's existing images by continuing SortOrder", async () => {
    // Existing images are 0..2, so the new one is SortOrder 3.
    await givenCoin();
    await withTestDb((database) => {
      const insert = database.prepare(
        'INSERT INTO CoinImages (CoinId, ImageData, SortOrder) ' +
          'VALUES (@coinId, @imageData, @sortOrder)'
      );
      for (let order = 0; order <= 2; order++) {
        insert.run({
          coinId: 'abc-123',
          imageData: `data:image/png;base64,old${order}`,
          sortOrder: order,
        });
      }
    });

    await request(app)
      .post('/api/coins/abc-123/images')
      .send({ images: ['data:image/png;base64,new'] });

    const sortOrders = capturedInputs()
      .filter((entry) => entry.name === 'sortOrder')
      .map((entry) => entry.value);
    expect(sortOrders).toEqual([3]);

    const rows = await storedImages();
    expect(rows.map((row) => row['SortOrder'])).toEqual([0, 1, 2, 3]);
    expect(rows[3]['ImageData']).toBe('data:image/png;base64,new');
  });

  it('returns 404 when the coin does not exist, without opening a transaction', async () => {
    const res = await request(app)
      .post('/api/coins/nonexistent/images')
      .send({ images: ['data:image/png;base64,a'] });

    expect(res.status).toBe(404);

    // Transaction control isn't reported to the query observer, so check
    // the consequence: only the existence check ran.
    expect(executedSql()).toHaveLength(1);
    expect(executedSql()[0]).toContain('FROM Coins');
    expect(await queryRows('SELECT * FROM CoinImages')).toEqual([]);
  });

  // ----- Transactional batch -----------------------------------------------

  it('inserts the batch inside a transaction and commits once', async () => {
    await givenCoin();

    await request(app)
      .post('/api/coins/abc-123/images')
      .send({ images: ['data:image/png;base64,a', 'data:image/png;base64,b'] });

    // Committed: visible to another reader.
    const rows = await storedImages();
    expect(rows.map((row) => row['ImageData'])).toEqual([
      'data:image/png;base64,a',
      'data:image/png;base64,b',
    ]);

    // The inserts shared the transaction; the existence check is outside by design.
    const inTransaction = executedQueries.map((event) => event.inTransaction);
    expect(inTransaction).toEqual([false, true, true, true]);
  });

  it('rolls the whole batch back when one INSERT fails mid-way', async () => {
    // A BEFORE INSERT trigger fails image 2 with a NOT NULL violation (515,
    // which maps to 500). The trigger is removed by rebuilding the database.
    await givenCoin();

    try {
      await withTestDb((database) =>
        database.exec(
          "CREATE TRIGGER fail_on_second BEFORE INSERT ON CoinImages " +
            "WHEN NEW.ImageData = 'data:image/png;base64,b' " +
            "BEGIN INSERT INTO CoinImages (CoinId, SortOrder) VALUES (NULL, 0); END"
        )
      );

      const res = await request(app)
        .post('/api/coins/abc-123/images')
        .send({
          images: [
            'data:image/png;base64,a',
            'data:image/png;base64,b',
            'data:image/png;base64,c',
          ],
        });

      expect(res.status).toBe(500);

      // Image 1 was inserted then undone, so a retry won't duplicate it.
      expect(await queryRows('SELECT * FROM CoinImages')).toEqual([]);

      // Existence check + MAX(SortOrder) + 2 INSERT attempts; the third never runs.
      expect(executedSql()).toHaveLength(4);
    } finally {
      await rebuildTestDatabase();
    }
  });
});
