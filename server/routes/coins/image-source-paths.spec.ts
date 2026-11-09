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
 * contract, not an implementation detail.
 *
 * As in the sibling spec files, `mssql` is replaced with the shared mock and
 * the handler's queries are satisfied in call order with mockResolvedValueOnce.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import { capturedInputs, mockRequest, resetMssqlMock } from '../../test-support/mssql-mock';
import { app } from '../../server';
import { MAX_COIN_IDS_PER_REQUEST } from './image-source-paths';

beforeEach(() => {
  resetMssqlMock();
});

describe('POST /api/coins/image-source-paths', () => {
  it('groups the source paths by coin id', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        { CoinId: 'morgan', SourcePath: 'D:\\Coin Pictures\\morgan obverse.jpg' },
        { CoinId: 'morgan', SourcePath: 'D:\\Coin Pictures\\morgan reverse.jpg' },
        { CoinId: 'peace', SourcePath: 'D:\\Coin Pictures\\peace obverse.jpg' },
      ],
    });

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan', 'peace'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual({
      morgan: [
        'D:\\Coin Pictures\\morgan obverse.jpg',
        'D:\\Coin Pictures\\morgan reverse.jpg',
      ],
      peace: ['D:\\Coin Pictures\\peace obverse.jpg'],
    });
  });

  it('returns an empty array for a requested coin that has no recorded paths', async () => {
    // The caller asked about three coins; the database knows paths for one.
    // Every requested id must still appear, so the client can treat a missing
    // key as a bug rather than as "no photos".
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ CoinId: 'morgan', SourcePath: 'D:\\pics\\a.jpg' }],
    });

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
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan'] });

    const sql = mockRequest.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('FROM CoinImages');
    expect(sql).toContain('CoinId');
    expect(sql).toContain('SourcePath');
    // The whole point of the endpoint.
    expect(sql).not.toContain('ImageData');
    expect(sql).not.toContain('SELECT *');
  });

  it('skips rows whose SourcePath is NULL', async () => {
    // Every image imported before the SourcePath column existed has a NULL
    // there. A null in the answer would be compared against a real path and
    // would never match, but it would also make the array lengths lie.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        { CoinId: 'morgan', SourcePath: null },
        { CoinId: 'morgan', SourcePath: 'D:\\pics\\a.jpg' },
        { CoinId: 'morgan', SourcePath: '   ' },
      ],
    });

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan'] });

    expect(res.body.results).toEqual({ morgan: ['D:\\pics\\a.jpg'] });
  });

  it('binds every coin id as a parameter rather than inlining it', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const nasty = "morgan'; DROP TABLE Coins; --";
    await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: [nasty, 'peace'] });

    const sql = mockRequest.query.mock.calls[0]?.[0] as string;
    expect(sql).not.toContain('DROP TABLE');
    expect(capturedInputs.map((i) => i.value)).toEqual([nasty, 'peace']);
    // Bound with the CoinImages.CoinId type, exactly like every other handler.
    expect(capturedInputs[0]?.type).toEqual({ type: 'nvarchar', length: 36 });
  });

  it('de-duplicates the requested coin ids', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan', 'morgan', 'peace', 'morgan'] });

    expect(capturedInputs.map((i) => i.value)).toEqual(['morgan', 'peace']);
  });

  it('answers an empty request without touching the database', async () => {
    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual({});
    expect(mockRequest.query).not.toHaveBeenCalled();
  });

  it('drops non-string entries rather than binding them', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan', 42, null, { id: 'x' }] });

    expect(res.status).toBe(200);
    expect(capturedInputs.map((i) => i.value)).toEqual(['morgan']);
    expect(res.body.results).toEqual({ morgan: [] });
  });

  it('rejects a body with no coinIds array', async () => {
    const res = await request(app).post('/api/coins/image-source-paths').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('coinIds');
    expect(mockRequest.query).not.toHaveBeenCalled();
  });

  it('rejects more coin ids than the cap allows', async () => {
    const tooMany = Array.from({ length: MAX_COIN_IDS_PER_REQUEST + 1 }, (_, i) => `coin-${i}`);

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: tooMany });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(MAX_COIN_IDS_PER_REQUEST));
    expect(mockRequest.query).not.toHaveBeenCalled();
  });

  it('reports a database failure as a 500 through sendDbError', async () => {
    mockRequest.query.mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan'] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to retrieve image source paths');
  });

  it('is not swallowed by POST /api/coins', async () => {
    // POST / (create a coin) and POST /image-source-paths are both POSTs under
    // the same router. If the mount order ever let the coin-create handler see
    // this path, the request would 201 with a brand new coin instead.
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app)
      .post('/api/coins/image-source-paths')
      .send({ coinIds: ['morgan'] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
  });
});
