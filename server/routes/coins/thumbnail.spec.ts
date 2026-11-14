/**
 * routes/coins/thumbnail.spec.ts — tests for GET /api/coins/:id/thumbnail,
 * the endpoint the main grid's Photo column renders.
 *
 * WHAT IS BEING PROTECTED
 * Inlining every photograph of every coin into GET /api/coins makes
 * JSON.stringify throw "Invalid string length" once a collection is large
 * enough, and the app will not load. So thumbnails come one HTTP response at
 * a time, as BINARY, which is the property these tests pin:
 *
 *   - ONE image per response. No shape of this endpoint can concatenate a
 *     collection's photographs into a single string, which is what makes the
 *     outage unreachable from here.
 *   - BINARY, not base64 — a third smaller on the wire than the stored text.
 *   - ONE ROW READ. `ORDER BY SortOrder LIMIT 1`, so a coin with twenty
 *     photographs still costs one row, and the row it costs is the same one
 *     the gallery calls the main photo.
 *   - The coin id is BOUND, never interpolated.
 *
 * *** THE ROWS ARE REAL NOW. *** They are inserted into an in-memory SQLite
 * database built from db/schema.sql and read back through the query the route
 * actually runs. The previous version of this file queued one canned
 * recordset per `query()` call, so "reads the lowest SortOrder" could only be
 * asserted by reading the SQL text — the mock returned whatever row the test
 * handed it regardless of what the statement said. Here the row the route
 * gets back is the row the ORDER BY picked.
 *
 * CoinImages has a FOREIGN KEY to Coins and foreign keys are enforced, so
 * every test inserts its coin before its photographs.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import {
  executedSql,
  insertCoin,
  rebuildTestDatabase,
  withTestDb,
  queryRows,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';

/** A tiny but genuine JPEG payload, as the database stores it. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

/** A coin with the bare minimum the Coins table insists on, plus its photos. */
async function givenCoinWithImages(
  coinId: string,
  images: Array<{ data: string | null; sortOrder: number }>
): Promise<void> {
  await insertCoin({ CoinId: coinId, Denomination: '$1', Year: '1921' });
  await withTestDb((database) => {
    const insert = database.prepare(
      'INSERT INTO CoinImages (CoinId, ImageData, SortOrder) ' +
        'VALUES (@coinId, @imageData, @sortOrder)'
    );
    for (const image of images) {
      insert.run({ coinId, imageData: image.data, sortOrder: image.sortOrder });
    }
  });
}

describe('GET /api/coins/:id/thumbnail', () => {
  it('returns the coin\'s first photograph as binary image bytes', async () => {
    await givenCoinWithImages('morgan-1921', [{ data: JPEG_DATA_URL, sortOrder: 0 }]);

    const res = await request(app).get('/api/coins/morgan-1921/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    // The DECODED bytes, not the base64 text. A response that still carried
    // the `data:image/jpeg;base64,` prefix would fail here, which is the
    // point: `<img src>` cannot display a text/plain base64 blob.
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);
  });

  it('honours the MIME type recorded in the stored data URL', async () => {
    await givenCoinWithImages('c1', [{ data: PNG_DATA_URL, sortOrder: 0 }]);

    const res = await request(app).get('/api/coins/c1/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(Buffer.from(res.body)).toEqual(PNG_BYTES);
  });

  it('reads exactly ONE row, the lowest SortOrder, and never the whole set', async () => {
    /*
     * THE ROW CHOICE IS NOW PROVED BY THE ROW THAT COMES BACK, not by the SQL
     * text. The PNG is inserted FIRST (so it gets the lower ImageId) but sits
     * at SortOrder 1; the JPEG is inserted second at SortOrder 0. A handler
     * that dropped the ORDER BY, or ordered by ImageId, or took the last row,
     * would serve the PNG. Only `ORDER BY SortOrder LIMIT 1` serves the JPEG.
     */
    await givenCoinWithImages('c1', [
      { data: PNG_DATA_URL, sortOrder: 1 },
      { data: JPEG_DATA_URL, sortOrder: 0 },
    ]);

    const res = await request(app).get('/api/coins/c1/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);

    // ONE statement, and it carries the cost control. LIMIT 1 is the SQLite
    // spelling of what used to be TOP 1; without it a coin with twenty
    // photographs drags twenty multi-hundred-kilobyte blobs out of the
    // database to display one of them. A row cannot show that the other
    // nineteen were left behind, so this stays a text assertion.
    const statements = executedSql();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('LIMIT 1');
    expect(statements[0]).toContain('ORDER BY SortOrder');
    expect(statements[0]).toContain('WHERE CoinId = @id');
  });

  it('binds the coin id rather than interpolating it', async () => {
    const hostile = "'; DROP TABLE Coins; --";
    await givenCoinWithImages(hostile, [{ data: JPEG_DATA_URL, sortOrder: 0 }]);

    const res = await request(app).get(`/api/coins/${encodeURIComponent(hostile)}/thumbnail`);

    // The id is DATA, so it finds that coin's photograph...
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);

    const statements = executedSql();
    expect(statements[0]).not.toContain('DROP TABLE');

    // ...and — the assertion the mock could never make — the Coins table is
    // still there afterwards. Under the old fake nothing executed the SQL, so
    // an injected statement would have been invisible.
    const survivors = await queryRows('SELECT CoinId FROM Coins');
    expect(survivors).toHaveLength(1);
  });

  it('answers 404 when the coin has no photographs', async () => {
    await givenCoinWithImages('no-photos', []);

    const res = await request(app).get('/api/coins/no-photos/thumbnail');

    // 404, not an empty 200: `<img>` needs to fail so the grid's broken-image
    // fallback shows, and a zero-byte 200 renders as a broken icon anyway
    // while costing a cache entry.
    expect(res.status).toBe(404);
  });

  it('answers 404 rather than 500 when the stored row is empty', async () => {
    await givenCoinWithImages('broken', [{ data: '', sortOrder: 0 }]);

    const res = await request(app).get('/api/coins/broken/thumbnail');

    // An empty or corrupt ImageData is a gap in the data, not a server fault.
    // A 500 here would light up the error log on every grid paint.
    expect(res.status).toBe(404);
  });

  it('answers 404 when the stored row decodes to no bytes at all', async () => {
    /*
     * A SEPARATE CASE FROM THE EMPTY STRING ABOVE, and it needs its own test
     * because it reaches a different guard.
     *
     * `Buffer.from(x, 'base64')` NEVER THROWS. Handed something that is not
     * base64 it silently stops at the first unusable character and returns
     * whatever it had — here, nothing. So "did this decode?" cannot be
     * answered with a try/catch; it has to be answered by checking the
     * length, and without that check this would be a 200 with a zero-byte
     * body claiming to be a JPEG.
      */
    await givenCoinWithImages('corrupt', [
      { data: 'data:image/jpeg;base64,!!!!', sortOrder: 0 },
    ]);

    const res = await request(app).get('/api/coins/corrupt/thumbnail');

    expect(res.status).toBe(404);
  });

  it('answers 404 for a non-string stored value', async () => {
    // ImageData is NULLABLE in db/schema.sql, so this is a row the database
    // genuinely permits rather than a driver quirk the mock imagined.
    await givenCoinWithImages('null-data', [{ data: null, sortOrder: 0 }]);

    const res = await request(app).get('/api/coins/null-data/thumbnail');

    expect(res.status).toBe(404);
  });

  it('accepts a bare base64 string with no data: prefix', async () => {
    // Rows imported before the data-URL convention settled hold raw base64.
    await givenCoinWithImages('legacy', [
      { data: JPEG_BYTES.toString('base64'), sortOrder: 0 },
    ]);

    const res = await request(app).get('/api/coins/legacy/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);
  });

  it('asks the browser to revalidate rather than caching a stale photograph', async () => {
    await givenCoinWithImages('c1', [{ data: JPEG_DATA_URL, sortOrder: 0 }]);

    const res = await request(app).get('/api/coins/c1/thumbnail');

    // `no-cache` does NOT mean "do not cache": it means "cache it, but ask me
    // before reusing it". With the ETag Express attaches, scrolling back up
    // the grid costs a 304 with no body instead of the photograph again —
    // while a photo the user just changed still updates immediately.
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['etag']).toBeTruthy();
  });

  it('reports a database failure as a 500 without leaking internals', async () => {
    /*
     * THE FAULT IS INJECTED INTO THE DATABASE, not into a mock's promise.
     * Dropping the table the handler reads makes the real statement fail with
     * a real SQLite error, which db/sql-api.ts translates and
     * routes/db-error-response.ts classifies — the whole path a canned
     * `mockRejectedValueOnce` skipped. "No such table" carries no SQL Server
     * error number, so it lands in the generic 500 branch.
     *
     * The schema has to be put back by hand: resetTestDatabase() only DELETEs
     * from the tables, and would itself fail against a dropped one.
     */
    try {
      await withTestDb((database) => database.exec('DROP TABLE CoinImages'));

      const res = await request(app).get('/api/coins/c1/thumbnail');

      expect(res.status).toBe(500);
      // The SENTENCE SHOWN TO THE USER names nothing internal. (The separate
      // `detail` field deliberately does carry the technical line — see the
      // DbErrorBody comment in routes/db-error-response.ts — so the check is
      // on `error`, which is what the UI displays.)
      expect(res.body.error).toBe('Failed to retrieve thumbnail');
      expect(res.body.error).not.toContain('CoinImages');
    } finally {
      await rebuildTestDatabase();
    }
  });
});
