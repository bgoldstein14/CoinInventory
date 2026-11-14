/**
 * routes/coins/images-post.spec.ts — HTTP tests for POST /api/coins/:id/images
 * (the "add images to an existing coin" half of routes/coins/images.ts).
 *
 * Split out of images.spec.ts, which covers the GET, purely to keep both files
 * a readable length.
 *
 * Almost everything here is a regression guard rather than ordinary coverage:
 *
 *   - `sourcePath` must round-trip into CoinImages.SourcePath, bound at the
 *     schema's NVARCHAR(400) so a long path is not silently truncated.
 *   - The LEGACY bare-string body must keep working. The Angular client has not
 *     migrated yet, so if these tests fail the frontend is broken too.
 *   - The insert batch must roll back AS A UNIT. Autocommitting each INSERT
 *     commits the earlier images when a later one fails; the caller sees a
 *     500, retries, and ends up with duplicates to delete by hand.
 *
 * *** THE ROWS ARE REAL NOW, AND THE ROLLBACK IS A REAL ROLLBACK. *** The
 * previous version of this file satisfied the handler's queries IN CALL ORDER
 * with `mockResolvedValueOnce` and asserted that `mockTransaction.rollback`
 * had been called — which proved the handler called a function, not that
 * anything was undone. Here the batch is written to an in-memory SQLite
 * database inside a genuine BEGIN IMMEDIATE, a genuine SQLite error is
 * injected half way through, and the test reads the table afterwards to see
 * that it is empty.
 *
 * The handler's statement order is still worth naming, because two tests
 * count statements to show that work did NOT happen:
 *
 *   1. SELECT CoinId FROM Coins ...              (the existence check)
 *   2. SELECT IFNULL(MAX(SortOrder), -1) ...     (where to append from)
 *   3..n INSERT INTO CoinImages ... RETURNING ImageId
 *
 * ON IMAGE IDS. `ImageId` is INTEGER PRIMARY KEY AUTOINCREMENT, so the ids
 * are real, monotonic and NEVER REUSED — `sqlite_sequence` survives the
 * per-test `DELETE FROM CoinImages`, so the ids keep climbing from one test
 * in this file to the next. No test may therefore expect a literal id; they
 * are checked against what actually landed in the table.
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

/** The coin every test posts to. Images need it: the FOREIGN KEY is enforced. */
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

    // The row is IN THE TABLE with the path intact — which subsumes the old
    // "the statement mentions SourcePath" check, because a statement that
    // did not name the column could not have stored the value.
    const rows = await storedImages();
    expect(rows).toHaveLength(1);
    expect(rows[0]['SourcePath']).toBe('C:\\Coin Pictures\\1921-morgan-obverse.jpg');
    expect(rows[0]['ImageData']).toBe('data:image/jpeg;base64,downscaled');

    // The ids handed back are the ids that were actually assigned, which is
    // what makes DELETE /api/coins/:id/images/:imageId usable.
    expect(res.body.imageIds).toEqual([rows[0]['ImageId']]);

    // ...and the value bound as NVARCHAR(400), matching db/schema.sql. A
    // shorter binding would refuse the user's path (db/bind-values.ts raises
    // the 8152 equivalent, which becomes an HTTP 400); a longer one would let
    // a path through that the declared column does not promise to hold.
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

    // One "unknown" value in the database, not two ('' and NULL) — and now
    // read back out of it rather than inferred from the binding.
    const rows = await storedImages();
    expect(rows.map((row) => row['SourcePath'])).toEqual(['C:\\pics\\a.png', null]);
  });

  // ----- THE COMPATIBILITY PATH ----------------------------------------
  // The Angular client still sends bare base64 strings. If these tests ever
  // start failing, the frontend is broken too.

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

    // A bare string means "I don't know where the original is" -> SQL NULL,
    // exactly like every row that predates the SourcePath column.
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
    // The coin already has images 0..2, so the new one must be SortOrder 3 —
    // and the MAX(SortOrder) that decides this is now read out of real rows
    // instead of being handed to the handler by the test.
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

    /*
     * BEGIN / COMMIT / ROLLBACK go through DbConnection.control() and are NOT
     * reported to the query observer, so "did it open a transaction?" is not
     * directly observable the way `mockTransaction.begin` used to be. What is
     * observable is the consequence, and it is the stronger statement: the
     * handler stopped after the existence check and did no work at all.
     */
    expect(executedSql()).toHaveLength(1);
    expect(executedSql()[0]).toContain('FROM Coins');
    expect(await queryRows('SELECT * FROM CoinImages')).toEqual([]);
  });

  // ----- THE TRANSACTION FIX -------------------------------------------
  // Each INSERT used to run in its own autocommit statement, so failing
  // halfway through a batch committed the earlier images anyway. The caller
  // saw a 500, retried, and ended up with duplicates.

  it('inserts the batch inside a transaction and commits once', async () => {
    await givenCoin();

    await request(app)
      .post('/api/coins/abc-123/images')
      .send({ images: ['data:image/png;base64,a', 'data:image/png;base64,b'] });

    // Committed: the rows are visible to a reader that is not the writer.
    const rows = await storedImages();
    expect(rows.map((row) => row['ImageData'])).toEqual([
      'data:image/png;base64,a',
      'data:image/png;base64,b',
    ]);

    // And they were written INSIDE the transaction. `inTransaction` is
    // recorded per statement by db/sql-api.ts, so this says which statements
    // shared one atomic unit — the existence check deliberately does not
    // (it decides whether to do any work at all; see the route's comment).
    const inTransaction = executedQueries.map((event) => event.inTransaction);
    expect(inTransaction).toEqual([false, true, true, true]);
  });

  it('rolls the whole batch back when one INSERT fails mid-way', async () => {
    /*
     * THE FAILURE IS INJECTED INTO THE DATABASE, not into a mock's promise.
     * A BEFORE INSERT trigger fires on image 2 and violates a NOT NULL
     * constraint, which is a genuine run-time SQLite error on a statement the
     * route really executed. (NOT NULL maps to SQL Server's 515, which
     * routes/db-error-response.ts deliberately leaves out of both its 400 and
     * its 409 sets, so it surfaces as the 500 the old test expected.)
     *
     * The trigger has to be torn down by rebuilding the database:
     * resetTestDatabase() clears rows, not schema objects.
     */
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

      // *** THE ASSERTION THE MOCK COULD NOT MAKE. *** Image 1 inserted
      // successfully and was then UNDONE. Nothing is left behind, so the
      // caller's retry re-inserts all three rather than duplicating the first.
      expect(await queryRows('SELECT * FROM CoinImages')).toEqual([]);

      // 1 existence check + 1 MAX(SortOrder) + 2 INSERT attempts = 4. The
      // third image is never attempted.
      expect(executedSql()).toHaveLength(4);
    } finally {
      await rebuildTestDatabase();
    }
  });
});
