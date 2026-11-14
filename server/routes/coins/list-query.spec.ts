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
 * *** THE COINS AND THEIR PHOTOGRAPHS ARE REAL NOW. *** They are inserted
 * into an in-memory SQLite database built from db/schema.sql, and the outage
 * test puts a genuine multi-kilobyte base64 blob in CoinImages before asking
 * for the list — so "no image text in the response" is now a statement about
 * a database that really contains image text. The previous version queued one
 * canned recordset per `query()` call in call order:
 *
 *   includeImages = true   ->  1. coins   2. images   3. image counts
 *   includeImages = false  ->  1. coins   2. image counts
 *
 * which meant the Nth queued recordset went to whichever query happened to be
 * Nth, and inserting a query in list-query.ts silently shifted every answer
 * after it. The statement COUNT is still asserted, because "the image-payload
 * query was skipped" is the whole point of the flag — but it is now counted
 * out of what really ran rather than out of what the test queued.
 *
 * The coins below carry only the columns the assertions read; db/schema.sql
 * makes every other column nullable, and rowToCoin() defaults what it does
 * not find.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import {
  executedSql,
  findQuery,
  insertCoin,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { shouldIncludeImages } from './list-query';
import { app } from '../../server';

const COIN_A = { CoinId: 'coin-a', Denomination: '$1', Year: '1921' };
const COIN_B = { CoinId: 'coin-b', Denomination: '5c', Year: '1937' };

/** Gives a coin `count` photographs. The FOREIGN KEY needs the coin first. */
async function givenImages(coinId: string, count: number, data = 'data:image/png;base64,x'): Promise<void> {
  await withTestDb((database) => {
    const insert = database.prepare(
      'INSERT INTO CoinImages (CoinId, ImageData, SortOrder) ' +
        'VALUES (@coinId, @imageData, @sortOrder)'
    );
    for (let order = 0; order < count; order++) {
      insert.run({ coinId, imageData: data, sortOrder: order });
    }
  });
}

describe('GET /api/coins — imageCount', () => {
  it('reports imageCount from the COUNT(*) aggregate, and 0 for coins with none', async () => {
    // coin-b has no image rows at all, so SQL's GROUP BY simply does not
    // return a row for it — the handler must default it to 0.
    await insertCoin(COIN_A);
    await insertCoin(COIN_B);
    await givenImages('coin-a', 4);

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    // ORDER BY Denomination, Year: '$1' sorts before '5c'.
    expect(res.body[0].id).toBe('coin-a');
    expect(res.body[0].imageCount).toBe(4);
    expect(res.body[1].id).toBe('coin-b');
    expect(res.body[1].imageCount).toBe(0);
  });

  it('counts with a SQL aggregate rather than by fetching the image rows', async () => {
    await insertCoin(COIN_A);
    await givenImages('coin-a', 2);

    await request(app).get('/api/coins');

    // The count query must be a COUNT(*) GROUP BY — if someone ever replaces
    // it with a SELECT of the rows, this fails loudly. A returned count
    // cannot show HOW it was arrived at, so this stays a text assertion.
    const countQuery = findQuery('COUNT(*)');
    expect(countQuery?.sql).toContain('GROUP BY CoinId');
    expect(countQuery?.sql).not.toContain('ImageData');
  });
});

describe('GET /api/coins — includeImages', () => {
  it('omits imagePaths entirely when includeImages=false', async () => {
    await insertCoin(COIN_A);
    await givenImages('coin-a', 3);

    const res = await request(app).get('/api/coins?includeImages=false');

    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('imagePaths');
    // The useful metadata survives, so the UI can still show "3 photos".
    expect(res.body[0].imageCount).toBe(3);

    // Two queries, not three — no image payload was ever read.
    const statements = executedSql();
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement).not.toContain('SELECT CoinId, ImageData');
    }
  });

  it('omits imagePaths BY DEFAULT, with no query parameter at all', async () => {
    // Exactly the same two queries as ?includeImages=false, because the
    // absent parameter now MEANS false. If a third query appears here the
    // default has been flipped back and the outage is live again.
    await insertCoin(COIN_A);
    await givenImages('coin-a', 2);

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('imagePaths');
    expect(res.body[0].imageCount).toBe(2);
    expect(executedSql()).toHaveLength(2);
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
     *
     * The blob is IN THE DATABASE for this test, not merely in a mock the
     * route might never have consulted — so a handler that started selecting
     * ImageData would really have it in hand and would really put it on the
     * wire.
      */
    const BASE64 = 'data:image/jpeg;base64,' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(64);

    await insertCoin(COIN_A);
    await givenImages('coin-a', 7, BASE64);

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('base64');
    expect(res.text).not.toContain(BASE64);
    // The response is a few hundred bytes of coin fields, not a megabyte of
    // photograph. A generous ceiling: one coin's worth of columns.
    expect(res.text.length).toBeLessThan(4000);

    // And the proof that it is cheap rather than merely tidy: the image
    // payload query was never sent to the database in the first place.
    for (const statement of executedSql()) {
      expect(statement).not.toContain('ImageData');
    }

    // The count still gets through, which is what lets the grid say
    // "this coin has 7 photographs" without fetching one of them.
    expect(res.body[0].imageCount).toBe(7);
  });

  it('includes imagePaths ONLY when explicitly asked with includeImages=true', async () => {
    await insertCoin(COIN_A);
    await givenImages('coin-a', 1, 'yes');

    const res = await request(app).get('/api/coins?includeImages=true');

    expect(res.status).toBe(200);
    expect(res.body[0].imagePaths).toEqual(['yes']);
    expect(executedSql()).toHaveLength(3);
  });

  it('never queries the dropped CoinTags table', async () => {
    // The tag feature is gone, table and all. A stray tags query would now
    // FAIL OUTRIGHT rather than merely shifting a queued mock answer by one,
    // because db/schema.sql has no such table to select from — so this test
    // has teeth it did not have before.
    await insertCoin(COIN_A);

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('tags');
    for (const statement of executedSql()) {
      expect(statement).not.toContain('CoinTags');
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
