/**
 * HTTP tests for GET /api/coins/:id/images (POST is in images-post.spec.ts),
 * including each image's `sourcePath`. Query order, used by the 404 test:
 *
 *   1. SELECT CoinId FROM Coins ...        (existence check)
 *   2. SELECT ImageId, ImageData, ... FROM CoinImages ...
 *
 * CoinImages has a foreign key to Coins, so each test inserts the coin first.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { executedSql, findQuery, insertCoin, withTestDb } from '../../test-support/sqlite-test-db';
import { app } from '../../server';

/**
 * Inserts image rows with explicit ImageIds, so ids can disagree with
 * SortOrder as they do in a real database.
 */
async function insertImages(
  rows: Array<{ ImageId?: number; CoinId: string; ImageData?: string | null; SortOrder: number; SourcePath?: string | null }>
): Promise<void> {
  await withTestDb((database) => {
    const insert = database.prepare(
      'INSERT INTO CoinImages (ImageId, CoinId, ImageData, SortOrder, SourcePath) ' +
        'VALUES (@imageId, @coinId, @imageData, @sortOrder, @sourcePath)'
    );
    for (const row of rows) {
      insert.run({
        imageId: row.ImageId ?? null,
        coinId: row.CoinId,
        imageData: row.ImageData ?? null,
        sortOrder: row.SortOrder,
        sourcePath: row.SourcePath ?? null,
      });
    }
  });
}

describe('GET /api/coins/:id/images', () => {
  it('returns the images in SortOrder with their ImageId', async () => {
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1' });
    // ImageIds and insertion order both differ from SortOrder, so this fails
    // if the handler sorts by ImageId or relies on rowid order.
    await insertImages([
      { ImageId: 8, CoinId: 'abc-123', ImageData: 'data:image/png;base64,edge', SortOrder: 2 },
      { ImageId: 7, CoinId: 'abc-123', ImageData: 'data:image/png;base64,obverse', SortOrder: 0 },
      { ImageId: 9, CoinId: 'abc-123', ImageData: 'data:image/png;base64,reverse', SortOrder: 1 },
    ]);

    const res = await request(app).get('/api/coins/abc-123/images');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);

    expect(res.body.map((img: { imageId: number }) => img.imageId)).toEqual([7, 9, 8]);
    expect(res.body.map((img: { sortOrder: number }) => img.sortOrder)).toEqual([0, 1, 2]);
    expect(res.body[0].imageData).toBe('data:image/png;base64,obverse');
    expect(res.body[2].imageData).toBe('data:image/png;base64,edge');
  });

  it('asks the database to do the ordering', async () => {
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1' });

    await request(app).get('/api/coins/abc-123/images');

    // The ORDER BY must be in SQL; a returned row can't show who sorted, so assert the text.
    const imageQuery = findQuery('FROM CoinImages');
    expect(imageQuery?.sql).toContain('ORDER BY SortOrder');
  });

  it('returns an empty array (not a 404) for a coin with no images', async () => {
    await insertCoin({ CoinId: 'no-photos', Denomination: '$1' });

    const res = await request(app).get('/api/coins/no-photos/images');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 404 when the coin does not exist', async () => {
    // A missing coin: the image query must not run.
    const res = await request(app).get('/api/coins/nonexistent/images');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Coin not found');
    expect(executedSql()).toHaveLength(1);
  });

  // ----- SourcePath -----------------------------------------------------

  it('returns each image sourcePath, selecting the column from CoinImages', async () => {
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1' });
    await insertImages([
      {
        ImageId: 1,
        CoinId: 'abc-123',
        ImageData: 'data:image/jpeg;base64,small',
        SortOrder: 0,
        SourcePath: 'C:\\Coin Pictures\\1921-morgan-obverse.jpg',
      },
    ]);

    const res = await request(app).get('/api/coins/abc-123/images');

    expect(res.status).toBe(200);
    // The value round-tripped: stored, selected, mapped.
    expect(res.body[0].sourcePath).toBe('C:\\Coin Pictures\\1921-morgan-obverse.jpg');
  });

  it('reports sourcePath as null for images imported before the column existed', async () => {
    // SQL NULL (the column always exists now that the schema is built at
    // its current shape).
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1' });
    await insertImages([
      { ImageId: 1, CoinId: 'abc-123', ImageData: 'data:image/png;base64,a', SortOrder: 0, SourcePath: null },
      { ImageId: 2, CoinId: 'abc-123', ImageData: 'data:image/png;base64,b', SortOrder: 1, SourcePath: null },
    ]);

    const res = await request(app).get('/api/coins/abc-123/images');

    expect(res.status).toBe(200);
    // NULL becomes JSON null, not undefined or 'null'.
    expect(res.body.map((img: { sourcePath: unknown }) => img.sourcePath)).toEqual([null, null]);
    for (const image of res.body) expect(image).toHaveProperty('sourcePath');
  });

  it('returns only the requested coin\'s images', async () => {
    // Another coin's photo in the table catches a missing `WHERE CoinId = @id`.
    await insertCoin({ CoinId: 'mine', Denomination: '$1' });
    await insertCoin({ CoinId: 'theirs', Denomination: '$1' });
    await insertImages([
      { CoinId: 'mine', ImageData: 'data:image/png;base64,mine', SortOrder: 0 },
      { CoinId: 'theirs', ImageData: 'data:image/png;base64,theirs', SortOrder: 0 },
    ]);

    const res = await request(app).get('/api/coins/mine/images');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].imageData).toBe('data:image/png;base64,mine');
  });
});

/*
 * Referenced photos. After reading a coin's photos and saving them straight
 * back, the database must still hold no picture: the file-streaming URL the
 * client gets must not be written into ImageData.
 */
describe('referenced photographs', () => {
  const ORIGINAL = 'C:\\Coin Pictures\\1921 morgan.jpg';

  it('renders a row with no picture as a link to its original file', async () => {
    await insertCoin({ CoinId: 'ref-1', Denomination: '$1' });
    await insertImages([
      { CoinId: 'ref-1', ImageData: null, SortOrder: 0, SourcePath: ORIGINAL },
    ]);

    const res = await request(app).get('/api/coins/ref-1/images');

    expect(res.status).toBe(200);
    expect(res.body[0].sourcePath).toBe(ORIGINAL);
    // Loadable by <img>, pointing at the original via the query string.
    expect(res.body[0].imageData).toContain('/api/images/file?path=');
    expect(res.body[0].imageData).toContain(encodeURIComponent(ORIGINAL));
    expect(res.body[0].imageData).not.toContain('base64');
  });

  it('leaves the database carrying no picture after a save round trip', async () => {
    await insertCoin({ CoinId: 'ref-2', Denomination: '$1' });
    await insertImages([
      { CoinId: 'ref-2', ImageData: null, SortOrder: 0, SourcePath: ORIGINAL },
    ]);

    // What the client does: read, then save with the same array.
    const read = await request(app).get('/api/coins/ref-2/images');
    const saved = await request(app)
      .put('/api/coins/ref-2')
      .send({ imagePaths: read.body.map((image: { imageData: string }) => image.imageData) });

    expect(saved.status).toBeLessThan(300);

    const rows = await withTestDb((database) =>
      database
        .prepare('SELECT ImageData, SourcePath FROM CoinImages WHERE CoinId = ?')
        .all('ref-2')
    );

    expect(rows).toHaveLength(1);
    // Referenced means no picture in the database at all.
    expect((rows[0] as { ImageData: string | null }).ImageData).toBeNull();
    expect((rows[0] as { SourcePath: string }).SourcePath).toBe(ORIGINAL);
  });

  it('keeps stored photographs stored — the two modes do not bleed', async () => {
    await insertCoin({ CoinId: 'both', Denomination: '$1' });
    await insertImages([
      { CoinId: 'both', ImageData: 'data:image/png;base64,kept', SortOrder: 0, SourcePath: ORIGINAL },
      { CoinId: 'both', ImageData: null, SortOrder: 1, SourcePath: 'C:\\pics\\b.jpg' },
    ]);

    const res = await request(app).get('/api/coins/both/images');

    expect(res.body[0].imageData).toBe('data:image/png;base64,kept');
    expect(res.body[1].imageData).toContain('/api/images/file?path=');
  });
});
