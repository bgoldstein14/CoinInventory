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
 * As in the other spec files, `mssql` is replaced with the shared mock and the
 * handler's queries are satisfied IN CALL ORDER with mockResolvedValueOnce.
 * For this endpoint that order is:
 *
 *   1. SELECT CoinId FROM Coins ...        (the existence check)
 *   2. SELECT ImageId, ImageData, ... FROM CoinImages ...
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import { mockRequest, resetMssqlMock } from '../../test-support/mssql-mock';
import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

describe('GET /api/coins/:id/images', () => {
  it('returns the images in SortOrder with their ImageId', async () => {
    mockRequest.query
      // 1. existence check — the coin is there
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      // 2. the image rows, already ordered by SortOrder by SQL Server
      .mockResolvedValueOnce({
        recordset: [
          { ImageId: 7, ImageData: 'data:image/png;base64,obverse', SortOrder: 0 },
          { ImageId: 9, ImageData: 'data:image/png;base64,reverse', SortOrder: 1 },
          { ImageId: 8, ImageData: 'data:image/png;base64,edge', SortOrder: 2 },
        ],
      });

    const res = await request(app).get('/api/coins/abc-123/images');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);

    // Order must be preserved exactly as the database returned it — note the
    // ImageIds are deliberately NOT in ascending order in the mock above, so
    // this would fail if the handler ever re-sorted by ImageId.
    expect(res.body.map((img: { imageId: number }) => img.imageId)).toEqual([7, 9, 8]);
    expect(res.body.map((img: { sortOrder: number }) => img.sortOrder)).toEqual([0, 1, 2]);
    expect(res.body[0].imageData).toBe('data:image/png;base64,obverse');
    expect(res.body[2].imageData).toBe('data:image/png;base64,edge');
  });

  it('asks SQL Server to do the ordering', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValueOnce({ recordset: [] });

    await request(app).get('/api/coins/abc-123/images');

    // Second query is the image fetch; it must carry the ORDER BY so the
    // handler never has to sort in JavaScript.
    const imageQuery = mockRequest.query.mock.calls[1]?.[0] as string;
    expect(imageQuery).toContain('FROM CoinImages');
    expect(imageQuery).toContain('ORDER BY SortOrder');
  });

  it('returns an empty array (not a 404) for a coin with no images', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'no-photos' }] }) // coin exists
      .mockResolvedValueOnce({ recordset: [] });                       // but has no images

    const res = await request(app).get('/api/coins/no-photos/images');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 404 when the coin does not exist', async () => {
    // The existence check comes back empty, so the handler must not even run
    // the image query.
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/coins/nonexistent/images');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Coin not found');
    expect(mockRequest.query).toHaveBeenCalledTimes(1);
  });

  // ----- SourcePath -----------------------------------------------------

  it('returns each image sourcePath, selecting the column from CoinImages', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValueOnce({
        recordset: [
          {
            ImageId: 1,
            ImageData: 'data:image/jpeg;base64,small',
            SortOrder: 0,
            SourcePath: 'C:\\Coin Pictures\\1921-morgan-obverse.jpg',
          },
        ],
      });

    const res = await request(app).get('/api/coins/abc-123/images');

    expect(res.status).toBe(200);
    expect(res.body[0].sourcePath).toBe('C:\\Coin Pictures\\1921-morgan-obverse.jpg');

    // The column has to actually be in the SELECT list, not invented by the
    // mapper — this is the half of the round trip the read side owns.
    const imageQuery = mockRequest.query.mock.calls[1]?.[0] as string;
    expect(imageQuery).toContain('SourcePath');
  });

  it('reports sourcePath as null for images imported before the column existed', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValueOnce({
        recordset: [
          // SQL NULL, i.e. an image whose original location is unknown...
          { ImageId: 1, ImageData: 'data:image/png;base64,a', SortOrder: 0, SourcePath: null },
          // ...and a row where the column is missing entirely, which is what a
          // database that has not had migration 002 applied looks like.
          { ImageId: 2, ImageData: 'data:image/png;base64,b', SortOrder: 1 },
        ],
      });

    const res = await request(app).get('/api/coins/abc-123/images');

    expect(res.status).toBe(200);
    // Both must normalise to JSON null so the client has one case to handle.
    expect(res.body.map((img: { sourcePath: unknown }) => img.sourcePath)).toEqual([null, null]);
  });
});
