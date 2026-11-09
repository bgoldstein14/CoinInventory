/**
 * routes/coins/list-query.spec.ts — tests for the GET /api/coins list shape
 * (routes/coins/list-query.ts, reached through routes/coins/reads.ts).
 *
 * What is being protected here:
 *   - `imageCount` is present on every coin and comes from a SQL COUNT(*),
 *     not from counting fetched rows in JavaScript
 *   - the DEFAULT (no query parameter) omits `imagePaths` ENTIRELY
 *   - `?includeImages=true` is the only way to get the payloads back
 *   - and, above all, THE OUTAGE TEST: the default response body must contain
 *     no base64 image text at all, for a coin that definitely has images.
 *
 * THE OUTAGE THIS FILE GUARDS. Including image payloads by default makes
 * GET /api/coins fail outright past about a hundred coins: V8 refuses to
 * BUILD the response string, because every coin carries every photograph as
 * ~250 KB of base64 and the total exceeds the engine's maximum string length.
 * The client sees only a 500, which reads as a database fault.
 *
 * So "the default response contains no base64" is not a style preference, it
 * is the difference between a working app and an unusable one. If you are
 * about to relax one of these assertions, that is the bug you are re-opening.
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
      // 2. the aggregate. coin-b has no image rows at all, so SQL's GROUP BY
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
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageCount: 2 }] }); // 2. counts

    await request(app).get('/api/coins');

    // The 2nd query (index 1) is the count. It must be a COUNT(*) GROUP BY — if
    // someone ever replaces it with a SELECT of the rows, this fails loudly.
    const countQuery = mockRequest.query.mock.calls[1]?.[0] as string;
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

  it('omits imagePaths BY DEFAULT, with no query parameter at all', async () => {
    // Exactly the same two queries as ?includeImages=false, because the
    // absent parameter now MEANS false. If a third query appears here the
    // default has been flipped back and the outage is live again.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A] })                              // 1. coins
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageCount: 2 }] }); // 2. counts

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('imagePaths');
    expect(res.body[0].imageCount).toBe(2);
    expect(mockRequest.query).toHaveBeenCalledTimes(2);
  });

  it('ships NO base64 payload in the default list, for a coin that has images', async () => {
    /*
     * THE OUTAGE TEST. See the file header.
     *
     * This asserts on the RAW RESPONSE TEXT rather than on the parsed body,
     * because the failure being prevented is about the size of the string
     * JSON.stringify has to build. A `not.toHaveProperty('imagePaths')` would
     * still pass if the payload leaked out under some other key, or if a
     * future "preview"/"thumbnail" field quietly inlined the same blob. The
     * rule is simpler and stricter than any key name: NO IMAGE TEXT, ANYWHERE
     * IN THE LIST RESPONSE.
      */
    const BASE64 = 'data:image/jpeg;base64,' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(64);

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A] })                              // 1. coins
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageCount: 7 }] }); // 2. counts

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('base64');
    expect(res.text).not.toContain(BASE64);
    // The response is a few hundred bytes of coin fields, not a megabyte of
    // photograph. A generous ceiling: one coin's worth of columns.
    expect(res.text.length).toBeLessThan(4000);

    // And the proof that it is cheap rather than merely tidy: the image
    // payload query was never sent to SQL Server in the first place.
    for (const call of mockRequest.query.mock.calls) {
      expect(call[0] as string).not.toContain('ImageData');
    }

    // The count still gets through, which is what lets the grid say
    // "this coin has 7 photographs" without fetching one of them.
    expect(res.body[0].imageCount).toBe(7);
  });

  it('includes imagePaths ONLY when explicitly asked with includeImages=true', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [COIN_A] })
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'coin-a', ImageData: 'yes' }] })
      .mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/coins?includeImages=true');

    expect(res.status).toBe(200);
    expect(res.body[0].imagePaths).toEqual(['yes']);
    expect(mockRequest.query).toHaveBeenCalledTimes(3);
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
  it('defaults to FALSE when the parameter is absent', () => {
    // The whole fix in one assertion: a caller that says nothing gets no
    // image payloads. Every client that wants them now has to ask.
    expect(shouldIncludeImages(undefined)).toBe(false);
  });

  it('defaults to FALSE for anything that is not a string', () => {
    // Express can hand us an array, a parsed object (?includeImages[a]=b) or
    // nothing. None of those is an opt-in.
    expect(shouldIncludeImages(null)).toBe(false);
    expect(shouldIncludeImages({})).toBe(false);
    expect(shouldIncludeImages(1)).toBe(false);
    expect(shouldIncludeImages(true)).toBe(false);
  });

  it('accepts the usual spellings of "yes"', () => {
    expect(shouldIncludeImages('true')).toBe(true);
    expect(shouldIncludeImages('TRUE')).toBe(true);
    expect(shouldIncludeImages(' 1 ')).toBe(true);
    expect(shouldIncludeImages('yes')).toBe(true);
  });

  it('treats anything else as "omit"', () => {
    expect(shouldIncludeImages('false')).toBe(false);
    expect(shouldIncludeImages('FALSE')).toBe(false);
    expect(shouldIncludeImages('0')).toBe(false);
    expect(shouldIncludeImages('no')).toBe(false);
    expect(shouldIncludeImages('')).toBe(false);
    // Not an opt-in spelling. A typo must fail SAFE — towards the small
    // response, never towards the one that cannot be serialised.
    expect(shouldIncludeImages('ture')).toBe(false);
  });

  it('collapses a repeated parameter to its first value', () => {
    expect(shouldIncludeImages(['true', 'false'])).toBe(true);
    expect(shouldIncludeImages(['false', 'true'])).toBe(false);
  });
});
