/**
 * GET /api/coins/:id/thumbnail, the grid's Photo column. Thumbnails come one
 * binary response at a time so a collection's photos are never concatenated
 * into one string. Checks: one image per response, binary (not base64), one
 * row read (`ORDER BY SortOrder LIMIT 1`), and a bound coin id.
 *
 * Rows are real; CoinImages has a foreign key to Coins, so each test inserts
 * the coin first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    // Decoded bytes, not the base64 text: <img src> can't display the latter.
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
    // The PNG is inserted first (lower ImageId) at SortOrder 1, the JPEG second
    // at SortOrder 0. Only ordering by SortOrder serves the JPEG.
    await givenCoinWithImages('c1', [
      { data: PNG_DATA_URL, sortOrder: 1 },
      { data: JPEG_DATA_URL, sortOrder: 0 },
    ]);

    const res = await request(app).get('/api/coins/c1/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);

    // One statement with LIMIT 1, so a coin with many photos reads one blob.
    // A row can't show the others were skipped, so this checks the text.
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

    // The id is data, so it finds that coin's photo...
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);

    const statements = executedSql();
    expect(statements[0]).not.toContain('DROP TABLE');

    // ...and the Coins table still exists afterwards.
    const survivors = await queryRows('SELECT CoinId FROM Coins');
    expect(survivors).toHaveLength(1);
  });

  it('answers 404 when the coin has no photographs', async () => {
    await givenCoinWithImages('no-photos', []);

    const res = await request(app).get('/api/coins/no-photos/thumbnail');

    // 404, not an empty 200, so the grid's broken-image fallback shows.
    expect(res.status).toBe(404);
  });

  it('answers 404 rather than 500 when the stored row is empty', async () => {
    await givenCoinWithImages('broken', [{ data: '', sortOrder: 0 }]);

    const res = await request(app).get('/api/coins/broken/thumbnail');

    // Empty or corrupt ImageData is a gap in the data, not a 500.
    expect(res.status).toBe(404);
  });

  it('answers 404 when the stored row decodes to no bytes at all', async () => {
    // A separate case: Buffer.from(x, 'base64') never throws, so non-base64
    // decodes to zero bytes and only the length check catches it.
    await givenCoinWithImages('corrupt', [
      { data: 'data:image/jpeg;base64,!!!!', sortOrder: 0 },
    ]);

    const res = await request(app).get('/api/coins/corrupt/thumbnail');

    expect(res.status).toBe(404);
  });

  it('answers 404 for a non-string stored value', async () => {
    // ImageData is nullable in the schema.
    await givenCoinWithImages('null-data', [{ data: null, sortOrder: 0 }]);

    const res = await request(app).get('/api/coins/null-data/thumbnail');

    expect(res.status).toBe(404);
  });

  it('accepts a bare base64 string with no data: prefix', async () => {
    // Older rows hold raw base64 with no data-URL prefix.
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

    // no-cache means "revalidate": with the ETag, scrolling back is a 304,
    // and a changed photo updates immediately.
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['etag']).toBeTruthy();
  });

  it('reports a database failure as a 500 without leaking internals', async () => {
    // A real database fault: dropping the table makes the query fail with a
    // real SQLite error (no SQL Server number, so 500). The schema is rebuilt
    // by hand afterwards, since resetTestDatabase() only clears tables.
    try {
      await withTestDb((database) => database.exec('DROP TABLE CoinImages'));

      const res = await request(app).get('/api/coins/c1/thumbnail');

      expect(res.status).toBe(500);
      // The user-facing `error` names nothing internal (`detail` carries the technical line).
      expect(res.body.error).toBe('Failed to retrieve thumbnail');
      expect(res.body.error).not.toContain('CoinImages');
    } finally {
      await rebuildTestDatabase();
    }
  });
});

/*
 * Referenced photos (ImageData NULL, SourcePath set): the route streams the
 * original file. Uses a real temp file, since a stubbed fs would pass
 * whether or not the disk was read.
 */
describe('GET /api/coins/:id/thumbnail — referenced photographs', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(join(tmpdir(), 'coin-thumb-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  /** A coin whose one photo is a path only. */
  async function givenReferencedCoin(coinId: string, sourcePath: string | null): Promise<void> {
    await insertCoin({ CoinId: coinId, Denomination: '$1', Year: '1921' });
    await withTestDb((database) => {
      database
        .prepare(
          'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) ' +
            'VALUES (@coinId, NULL, 0, @sourcePath)'
        )
        .run({ coinId, sourcePath });
    });
  }

  it('streams the original file when the row holds a path and no picture', async () => {
    const original = join(tempDir, 'morgan-obverse.jpg');
    await fs.promises.writeFile(original, JPEG_BYTES);
    await givenReferencedCoin('ref-1', original);

    const res = await request(app).get('/api/coins/ref-1/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);
  });

  it('404s when the referenced original has been moved or deleted', async () => {
    // No stored copy to fall back on; a 404 shows the ordinary empty cell.
    await givenReferencedCoin('ref-2', join(tempDir, 'gone.jpg'));

    const res = await request(app).get('/api/coins/ref-2/thumbnail');

    expect(res.status).toBe(404);
  });

  it('refuses to serve a path that is not an image file', async () => {
    // Same extension allow-list as GET /api/images/file.
    const notAnImage = join(tempDir, 'secrets.env');
    await fs.promises.writeFile(notAnImage, 'TOKEN=hunter2');
    await givenReferencedCoin('ref-3', notAnImage);

    const res = await request(app).get('/api/coins/ref-3/thumbnail');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('hunter2');
  });

  it('still 404s when the row has neither a picture nor a path', async () => {
    await givenReferencedCoin('ref-4', null);

    const res = await request(app).get('/api/coins/ref-4/thumbnail');

    expect(res.status).toBe(404);
  });
});
