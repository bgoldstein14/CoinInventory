/**
 * routes/coins/list-query.spec.ts — tests for the GET /api/coins list shape
 * (routes/coins/list-query.ts, reached through routes/coins/reads.ts).
 *
 * What is being protected here:
 *   - `imageCount` is present on every coin and comes from a SQL COUNT(*),
 *     not from counting fetched rows in JavaScript
 *   - `?includeImages=false` omits `imagePaths` entirely
 *   - the DEFAULT (no query parameter) still includes `imagePaths`, which is
 *     the temporary compatibility behaviour the Angular client still relies on
 *
 * Queries are satisfied IN CALL ORDER by the shared mssql mock:
 *
 *   includeImages = true   ->  1. coins   2. images   3. image counts
 *   includeImages = false  ->  1. coins   2. image counts
 *
 * THESE NUMBERS ARE LOAD-BEARING. `mockResolvedValueOnce` queues one answer per
 * `query()` call with no idea which query is asking, so the Nth queued recordset
 * is handed to the Nth query loadCoinList() happens to run. Insert or remove a
 * query in list-query.ts and every mock after it silently answers the wrong
 * question — a coin row would arrive where an image-count row was expected.
 *
 * The sequence was one longer until the tag feature was removed: it used to be
 * coins -> images -> tags -> counts. Dropping the tags query renumbered
 * everything after it, which is why the count query is now the 3rd call (index
 * 2) rather than the 4th.
 *
 * The coin rows below are intentionally minimal: rowToCoin() defaults every
 * column it does not find, so only CoinId matters for these assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import { mockRequest, resetMssqlMock } from '../../test-support/mssql-mock';
import { shouldIncludeImages } from './list-query';
import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

const COIN_A = { CoinId: 'coin-a', Denomination: '$1', Year: '1921' };
const COIN_B = { CoinId: 'coin-b', Denomination: '5c', Year: '1937' };

describe('GET /api/coins — imageCount', () => {
  it('reports imageCount from the COUNT(*) aggregate, and 0 for coins with none', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A, COIN_B] })                    // 1. coins
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageData: 'x' }] }) // 2. images
      // 3. the aggregate. coin-b has no image rows at all, so SQL's GROUP BY
      // simply does not return a row for it — the handler must default it to 0.
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageCount: 4 }] });

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe('coin-a');
    expect(res.body[0].imageCount).toBe(4);
    expect(res.body[1].id).toBe('coin-b');
    expect(res.body[1].imageCount).toBe(0);
  });

  it('counts with a SQL aggregate rather than by fetching the image rows', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A] })                             // 1. coins
      .mockResolvedValueOnce({ recordset: [] })                                   // 2. images
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageCount: 2 }] }); // 3. counts

    await request(app).get('/api/coins');

    // The 3rd query (index 2) is the count. It must be a COUNT(*) GROUP BY — if
    // someone ever replaces it with a SELECT of the rows, this fails loudly.
    const countQuery = mockRequest.query.mock.calls[2]?.[0] as string;
    expect(countQuery).toContain('COUNT(*)');
    expect(countQuery).toContain('GROUP BY CoinId');
    expect(countQuery).not.toContain('ImageData');
  });
});

describe('GET /api/coins — includeImages', () => {
  it('omits imagePaths entirely when includeImages=false', async () => {
    // Only two queries now: the image-payload query is skipped, which is the
    // whole point of the flag.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A] })                              // 1. coins
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageCount: 3 }] }); // 2. counts

    const res = await request(app).get('/api/coins?includeImages=false');

    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('imagePaths');
    // The useful metadata survives, so the UI can still show "3 photos".
    expect(res.body[0].imageCount).toBe(3);

    // Two queries, not three — no image payload was ever read.
    expect(mockRequest.query).toHaveBeenCalledTimes(2);
    for (const call of mockRequest.query.mock.calls) {
      expect(call[0] as string).not.toContain('SELECT CoinId, ImageData');
    }
  });

  it('still includes imagePaths by default (temporary, pending the client migration)', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A] })
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageData: 'data:image/png;base64,abc' }] })
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageCount: 1 }] });

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.body[0].imagePaths).toEqual(['data:image/png;base64,abc']);
  });

  it('treats includeImages=true like the default', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A] })
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageData: 'yes' }] })
      .mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/coins?includeImages=true');

    expect(res.status).toBe(200);
    expect(res.body[0].imagePaths).toEqual(['yes']);
  });

  it('never queries the dropped CoinTags table', async () => {
    // The tag feature is gone, table and all. If a stray tags query came back,
    // it would both fail against the real database (the table no longer exists
    // after migration 005) and shift every later mock answer by one.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A] })
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('tags');
    for (const call of mockRequest.query.mock.calls) {
      expect(call[0] as string).not.toContain('CoinTags');
    }
  });
});

describe('shouldIncludeImages()', () => {
  it('defaults to true when the parameter is absent', () => {
    // This is the temporary default documented in list-query.ts. When it is
    // flipped to false for the client migration, this expectation changes too.
    expect(shouldIncludeImages(undefined)).toBe(true);
  });

  it('accepts the usual spellings of "no"', () => {
    expect(shouldIncludeImages('false')).toBe(false);
    expect(shouldIncludeImages('FALSE')).toBe(false);
    expect(shouldIncludeImages(' 0 ')).toBe(false);
    expect(shouldIncludeImages('no')).toBe(false);
  });

  it('treats anything else as "include"', () => {
    expect(shouldIncludeImages('true')).toBe(true);
    expect(shouldIncludeImages('')).toBe(true);
    expect(shouldIncludeImages('yes')).toBe(true);
  });

  it('collapses a repeated parameter to its first value', () => {
    expect(shouldIncludeImages(['false', 'true'])).toBe(false);
  });
});
