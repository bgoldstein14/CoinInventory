/**
 * routes/coins/images.spec.ts — HTTP tests for the coin image sub-resource
 * (routes/coins/images.ts).
 *
 * The focus here is GET /api/coins/:id/images, the on-demand endpoint the
 * detail panel and gallery use so that GET /api/coins no longer has to ship
 * every base64 image of every coin on every app load. It now also returns each
 * image's `sourcePath` — where the original full-resolution file lives on the
 * host machine — which is what lets the UI offer a link to the real photo.
 *
 * POST /api/coins/:id/images is covered by its sibling images-post.spec.ts;
 * the two were split only to keep each file a readable length.
 *
 * *** THE ROWS ARE REAL NOW. *** They go into an in-memory SQLite database
 * built from db/schema.sql and come back through the statement the handler
 * actually runs. The previous version of this file satisfied the handler's
 * queries IN CALL ORDER with `mockResolvedValueOnce`, which meant the test's
 * idea of how many queries the handler runs had to be kept in step by hand,
 * and meant "returns them in SortOrder" could not be distinguished from
 * "returns whatever the test queued". That order is still worth naming,
 * because the 404 test asserts the second query never happens:
 *
 *   1. SELECT CoinId FROM Coins ...        (the existence check)
 *   2. SELECT ImageId, ImageData, ... FROM CoinImages ...
 *
 * CoinImages has a FOREIGN KEY to Coins and foreign keys are enforced, so
 * every test inserts its coin before its photographs.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { executedSql, findQuery, insertCoin, withTestDb } from '../../test-support/sqlite-test-db';
import { app } from '../../server';

/**
 * Inserts image rows with EXPLICIT ImageIds.
 *
 * `ImageId` is INTEGER PRIMARY KEY AUTOINCREMENT, so left to itself it would
 * hand out ids in insertion order and the "did the handler re-sort by
 * ImageId?" question below could not be asked. Supplying the ids is allowed
 * and is what lets a row's id disagree with its SortOrder, exactly as it does
 * in a real database where images have been added and deleted over time.
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
    // The ImageIds are deliberately NOT in ascending order against SortOrder,
    // and the rows are inserted in an order that matches neither, so this
    // fails if the handler ever re-sorts by ImageId or leans on rowid order.
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

    // Second query is the image fetch; it must carry the ORDER BY so the
    // handler never has to sort in JavaScript. A returned row cannot tell
    // "the database ordered these" from "JavaScript ordered these", so this
    // one stays a text assertion.
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
    // The existence check comes back empty, so the handler must not even run
    // the image query.
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
    // The value made the whole round trip — stored, selected, mapped. Under
    // the old mock this proved only that the mapper copied a field the test
    // itself had invented, which is why the SQL text had to be checked too.
    expect(res.body[0].sourcePath).toBe('C:\\Coin Pictures\\1921-morgan-obverse.jpg');
  });

  it('reports sourcePath as null for images imported before the column existed', async () => {
    /*
     * ONE CASE HERE, NOT TWO. The old version of this test also fed in a row
     * with the SourcePath KEY MISSING ENTIRELY, standing for a database that
     * had not had migration 002 applied. That database cannot exist any more:
     * db/schema.sql builds every table at its current shape on every open, so
     * the column is always there and a row always has the key. The `?? null`
     * in the handler still earns its place for SQL NULL, which is what this
     * row is.
     */
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1' });
    await insertImages([
      { ImageId: 1, CoinId: 'abc-123', ImageData: 'data:image/png;base64,a', SortOrder: 0, SourcePath: null },
      { ImageId: 2, CoinId: 'abc-123', ImageData: 'data:image/png;base64,b', SortOrder: 1, SourcePath: null },
    ]);

    const res = await request(app).get('/api/coins/abc-123/images');

    expect(res.status).toBe(200);
    // SQL NULL must normalise to JSON null, not to undefined (which would
    // drop the key) and not to the string 'null'.
    expect(res.body.map((img: { sourcePath: unknown }) => img.sourcePath)).toEqual([null, null]);
    for (const image of res.body) expect(image).toHaveProperty('sourcePath');
  });

  it('returns only the requested coin\'s images', async () => {
    /*
     * NEW, AND ONLY POSSIBLE AGAINST A REAL DATABASE. The mock answered the
     * image query with whatever the test queued, so `WHERE CoinId = @id`
     * could have been missing altogether and every test above would still
     * have passed. With real rows, another coin's photograph in the table is
     * enough to catch it.
     */
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
 * REFERENCED PHOTOGRAPHS — "the database holds the location, not the picture".
 *
 * THE PROPERTY THESE TESTS EXIST FOR: after a full round trip — read the
 * coin's photographs, send them straight back as an ordinary save — the
 * database must still hold NO picture. The client's `<img src>` needs a
 * string it can load, so a referenced row is rendered as this server's own
 * file-streaming URL; the risk is that the URL is then written back into
 * ImageData on the next save and the mode quietly becomes "stored".
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
    // Loadable by an <img>, and pointing at the original rather than
    // carrying it: the path is in the query string, not a base64 payload.
    expect(res.body[0].imageData).toContain('/api/images/file?path=');
    expect(res.body[0].imageData).toContain(encodeURIComponent(ORIGINAL));
    expect(res.body[0].imageData).not.toContain('base64');
  });

  it('leaves the database carrying no picture after a save round trip', async () => {
    await insertCoin({ CoinId: 'ref-2', Denomination: '$1' });
    await insertImages([
      { CoinId: 'ref-2', ImageData: null, SortOrder: 0, SourcePath: ORIGINAL },
    ]);

    // Exactly what the client does: read the photographs, then save the coin
    // with the array it was given.
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
    // THE MUTATION THIS CATCHES: storing the reference URL (or anything
    // else) in ImageData. Referenced means the database does not carry the
    // picture — not "carries a smaller picture".
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
