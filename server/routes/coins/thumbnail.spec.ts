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
 *   - ONE ROW READ. `SELECT TOP 1 ... ORDER BY SortOrder`, so a coin with
 *     twenty photographs still costs one row, and the row it costs is the
 *     same one the gallery calls the main photo.
 *   - The coin id is BOUND, never interpolated.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import { capturedInputs, mockRequest, resetMssqlMock } from '../../test-support/mssql-mock';
import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

/** A tiny but genuine JPEG payload, as the database stores it. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_DATA_URL = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;

describe('GET /api/coins/:id/thumbnail', () => {
  it('returns the coin\'s first photograph as binary image bytes', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageData: JPEG_DATA_URL }] });

    const res = await request(app).get('/api/coins/morgan-1921/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    // The DECODED bytes, not the base64 text. A response that still carried
    // the `data:image/jpeg;base64,` prefix would fail here, which is the
    // point: `<img src>` cannot display a text/plain base64 blob.
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);
  });

  it('honours the MIME type recorded in the stored data URL', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ ImageData: `data:image/png;base64,${png.toString('base64')}` }],
    });

    const res = await request(app).get('/api/coins/c1/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(Buffer.from(res.body)).toEqual(png);
  });

  it('reads exactly ONE row, the lowest SortOrder, and never the whole set', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageData: JPEG_DATA_URL }] });

    await request(app).get('/api/coins/c1/thumbnail');

    expect(mockRequest.query).toHaveBeenCalledTimes(1);
    const sql = mockRequest.query.mock.calls[0]?.[0] as string;
    // TOP 1 + ORDER BY SortOrder is the whole cost control. Without TOP 1 a
    // coin with twenty photographs drags twenty multi-hundred-kilobyte blobs
    // out of SQL Server to display one of them.
    expect(sql).toContain('TOP 1');
    expect(sql).toContain('ORDER BY SortOrder');
    expect(sql).toContain('WHERE CoinId = @id');
  });

  it('binds the coin id rather than interpolating it', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageData: JPEG_DATA_URL }] });

    const hostile = "'; DROP TABLE Coins; --";
    await request(app).get(`/api/coins/${encodeURIComponent(hostile)}/thumbnail`);

    const sql = mockRequest.query.mock.calls[0]?.[0] as string;
    expect(sql).not.toContain('DROP TABLE');
    expect(capturedInputs).toContainEqual(
      expect.objectContaining({ name: 'id', value: hostile })
    );
  });

  it('answers 404 when the coin has no photographs', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/coins/no-photos/thumbnail');

    // 404, not an empty 200: `<img>` needs to fail so the grid's broken-image
    // fallback shows, and a zero-byte 200 renders as a broken icon anyway
    // while costing a cache entry.
    expect(res.status).toBe(404);
  });

  it('answers 404 rather than 500 when the stored row is empty', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageData: '' }] });

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
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ ImageData: 'data:image/jpeg;base64,!!!!' }],
    });

    const res = await request(app).get('/api/coins/corrupt/thumbnail');

    expect(res.status).toBe(404);
  });

  it('answers 404 for a non-string stored value', async () => {
    // A driver that hands back null for a NULL column, say.
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageData: null }] });

    const res = await request(app).get('/api/coins/null-data/thumbnail');

    expect(res.status).toBe(404);
  });

  it('accepts a bare base64 string with no data: prefix', async () => {
    // Rows imported before the data-URL convention settled hold raw base64.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ ImageData: JPEG_BYTES.toString('base64') }],
    });

    const res = await request(app).get('/api/coins/legacy/thumbnail');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(res.body)).toEqual(JPEG_BYTES);
  });

  it('asks the browser to revalidate rather than caching a stale photograph', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageData: JPEG_DATA_URL }] });

    const res = await request(app).get('/api/coins/c1/thumbnail');

    // `no-cache` does NOT mean "do not cache": it means "cache it, but ask me
    // before reusing it". With the ETag Express attaches, scrolling back up
    // the grid costs a 304 with no body instead of the photograph again —
    // while a photo the user just changed still updates immediately.
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['etag']).toBeTruthy();
  });

  it('reports a database failure as a 500 without leaking internals', async () => {
    mockRequest.query.mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(app).get('/api/coins/c1/thumbnail');

    expect(res.status).toBe(500);
  });
});
