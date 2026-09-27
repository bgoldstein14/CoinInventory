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
 *   - The insert batch must roll back AS A UNIT. Each INSERT used to run in its
 *     own autocommit statement, so failing halfway through committed the
 *     earlier images anyway; the caller saw a 500, retried, and ended up with
 *     duplicates it had to delete by hand.
 *
 * As in the other spec files, `mssql` is replaced with the shared mock and the
 * handler's queries are satisfied IN CALL ORDER with mockResolvedValueOnce:
 *
 *   1. SELECT CoinId FROM Coins ...              (the existence check)
 *   2. SELECT ISNULL(MAX(SortOrder), -1) ...     (where to append from)
 *   3..n INSERT INTO CoinImages ... OUTPUT INSERTED.ImageId
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import {
  capturedInputs,
  mockRequest,
  mockTransaction,
  resetMssqlMock,
} from '../../test-support/mssql-mock';
import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

// ============================================================
// POST /api/coins/:id/images
// ============================================================

/** Queues the existence check + MAX(SortOrder) that every POST starts with. */
function queuePostPreamble(coinId = 'abc-123', maxOrder = -1): void {
  mockRequest.query
    .mockResolvedValueOnce({ recordset: [{ CoinId: coinId }] })
    .mockResolvedValueOnce({ recordset: [{ max_order: maxOrder }] });
}

/** All the `sourcePath` parameters bound during the request, in order. */
function boundSourcePaths(): unknown[] {
  return capturedInputs.filter((entry) => entry.name === 'sourcePath').map((entry) => entry.value);
}

describe('POST /api/coins/:id/images', () => {
  it('round-trips sourcePath into the INSERT, bound at the schema length', async () => {
    queuePostPreamble();
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageId: 42 }] });

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
    expect(res.body.imageIds).toEqual([42]);

    // The column must be named in the statement...
    const insertSql = mockRequest.query.mock.calls.at(-1)?.[0] as string;
    expect(insertSql).toContain('SourcePath');

    // ...and the value bound as NVARCHAR(400), matching setup-database.sql. A
    // shorter binding would silently truncate the user's path.
    const sourcePathInput = capturedInputs.find((entry) => entry.name === 'sourcePath');
    expect(sourcePathInput?.value).toBe('C:\\Coin Pictures\\1921-morgan-obverse.jpg');
    expect(sourcePathInput?.type).toMatchObject({ length: 400 });
  });

  it('trims a padded sourcePath and stores an empty one as NULL', async () => {
    queuePostPreamble();
    mockRequest.query.mockResolvedValue({ recordset: [{ ImageId: 1 }] });

    const res = await request(app)
      .post('/api/coins/abc-123/images')
      .send({
        images: [
          { imageData: 'data:image/png;base64,a', sourcePath: '  C:\\pics\\a.png  ' },
          { imageData: 'data:image/png;base64,b', sourcePath: '   ' },
        ],
      });

    expect(res.status).toBe(201);
    // One "unknown" value in the database, not two ('' and NULL).
    expect(boundSourcePaths()).toEqual(['C:\\pics\\a.png', null]);
  });

  // ----- THE COMPATIBILITY PATH ----------------------------------------
  // The Angular client still sends bare base64 strings. If these tests ever
  // start failing, the frontend is broken too.

  it('still accepts the legacy string form of `images`, storing a null sourcePath', async () => {
    queuePostPreamble();
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ ImageId: 7 }] })
      .mockResolvedValueOnce({ recordset: [{ ImageId: 8 }] });

    const res = await request(app)
      .post('/api/coins/abc-123/images')
      .send({ images: ['data:image/png;base64,obverse', 'data:image/png;base64,reverse'] });

    expect(res.status).toBe(201);
    expect(res.body.imageIds).toEqual([7, 8]);

    // A bare string means "I don't know where the original is" -> SQL NULL,
    // exactly like every row that predates the SourcePath column.
    expect(boundSourcePaths()).toEqual([null, null]);

    const imageDataValues = capturedInputs
      .filter((entry) => entry.name === 'imageData')
      .map((entry) => entry.value);
    expect(imageDataValues).toEqual(['data:image/png;base64,obverse', 'data:image/png;base64,reverse']);
  });

  it('still accepts the legacy single-image `image` / `imageData` keys', async () => {
    queuePostPreamble();
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageId: 3 }] });

    const res = await request(app)
      .post('/api/coins/abc-123/images')
      .send({ image: 'data:image/png;base64,single' });

    expect(res.status).toBe(201);
    expect(res.body.imageIds).toEqual([3]);
    expect(boundSourcePaths()).toEqual([null]);
  });

  it("appends after the coin's existing images by continuing SortOrder", async () => {
    // The coin already has images 0..2, so the new one must be SortOrder 3.
    queuePostPreamble('abc-123', 2);
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ ImageId: 99 }] });

    await request(app)
      .post('/api/coins/abc-123/images')
      .send({ images: ['data:image/png;base64,new'] });

    const sortOrders = capturedInputs
      .filter((entry) => entry.name === 'sortOrder')
      .map((entry) => entry.value);
    expect(sortOrders).toEqual([3]);
  });

  it('returns 404 when the coin does not exist, without opening a transaction', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app)
      .post('/api/coins/nonexistent/images')
      .send({ images: ['data:image/png;base64,a'] });

    expect(res.status).toBe(404);
    expect(mockTransaction.begin).not.toHaveBeenCalled();
  });

  // ----- THE TRANSACTION FIX -------------------------------------------
  // Each INSERT used to run in its own autocommit statement, so failing
  // halfway through a batch committed the earlier images anyway. The caller
  // saw a 500, retried, and ended up with duplicates.

  it('inserts the batch inside a transaction and commits once', async () => {
    queuePostPreamble();
    mockRequest.query.mockResolvedValue({ recordset: [{ ImageId: 1 }] });

    await request(app)
      .post('/api/coins/abc-123/images')
      .send({ images: ['data:image/png;base64,a', 'data:image/png;base64,b'] });

    expect(mockTransaction.begin).toHaveBeenCalledTimes(1);
    expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
    expect(mockTransaction.rollback).not.toHaveBeenCalled();
  });

  it('rolls the whole batch back when one INSERT fails mid-way', async () => {
    queuePostPreamble();
    mockRequest.query
      // image 1 of 3 inserts fine...
      .mockResolvedValueOnce({ recordset: [{ ImageId: 1 }] })
      // ...image 2 blows up...
      .mockRejectedValueOnce(new Error('Timeout expired'))
      // ...and image 3 must never be attempted.
      .mockResolvedValueOnce({ recordset: [{ ImageId: 3 }] });

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
    expect(mockTransaction.rollback).toHaveBeenCalledTimes(1);
    expect(mockTransaction.commit).not.toHaveBeenCalled();

    // 1 existence check + 1 MAX(SortOrder) + 2 INSERT attempts = 4. The third
    // image is not attempted, and nothing is left committed behind us — so a
    // retry re-inserts all three rather than duplicating the first.
    expect(mockRequest.query).toHaveBeenCalledTimes(4);
  });
});
