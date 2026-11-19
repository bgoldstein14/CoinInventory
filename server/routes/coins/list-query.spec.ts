/**
 * The GET /api/coins list shape (list-query.ts via reads.ts):
 *
 *   - `imageCount` on every coin, from a SQL COUNT(*);
 *   - the default omits `imagePaths` entirely;
 *   - only `?includeImages=true` returns payloads;
 *   - the outage test: the default response contains no base64 at all, for a
 *     coin that has images.
 *
 * Including payloads by default makes the list unserializable past about a
 * hundred coins (V8's maximum string length), so don't relax these. Statement
 * counts show the image query was skipped.
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

/** Gives a coin `count` photos (the coin must exist first). */
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
    // coin-b has no image rows, so it is absent from the GROUP BY; must default to 0.
    await insertCoin(COIN_A);
    await insertCoin(COIN_B);
    await givenImages('coin-a', 4);

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    // Ordered by Denomination, Year.
    expect(res.body[0].id).toBe('coin-a');
    expect(res.body[0].imageCount).toBe(4);
    expect(res.body[1].id).toBe('coin-b');
    expect(res.body[1].imageCount).toBe(0);
  });

  it('counts with a SQL aggregate rather than by fetching the image rows', async () => {
    await insertCoin(COIN_A);
    await givenImages('coin-a', 2);

    await request(app).get('/api/coins');

    // Must be a COUNT(*) GROUP BY, not a fetch of rows (asserted on the text).
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
    // The UI can still show "3 photos".
    expect(res.body[0].imageCount).toBe(3);

    // Coins, image counts and references; no image payload read.
    const statements = executedSql();
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).not.toContain('SELECT CoinId, ImageData');
    }
  });

  it('omits imagePaths BY DEFAULT, with no query parameter at all', async () => {
    // The default must match includeImages=false; a fourth query means the
    // default was flipped and the outage is back.
    await insertCoin(COIN_A);
    await givenImages('coin-a', 2);

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('imagePaths');
    expect(res.body[0].imageCount).toBe(2);
    expect(executedSql()).toHaveLength(3);
  });

  it('ships NO base64 payload in the default list, for a coin that has images', async () => {
    // The outage test. Checks the raw response text, not a parsed key, so a
    // payload leaking under any field name still fails. The blob really is in
    // the database.
    const BASE64 = 'data:image/jpeg;base64,' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(64);

    await insertCoin(COIN_A);
    await givenImages('coin-a', 7, BASE64);

    const res = await request(app).get('/api/coins');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('base64');
    expect(res.text).not.toContain(BASE64);
    // A few hundred bytes of coin fields, not a photo.
    expect(res.text.length).toBeLessThan(4000);

    // The image payload query never ran.
    for (const statement of executedSql()) {
      expect(statement).not.toContain('ImageData');
    }

    // The count still comes through.
    expect(res.body[0].imageCount).toBe(7);
  });

  it('includes imagePaths ONLY when explicitly asked with includeImages=true', async () => {
    await insertCoin(COIN_A);
    await givenImages('coin-a', 1, 'yes');

    const res = await request(app).get('/api/coins?includeImages=true');

    expect(res.status).toBe(200);
    expect(res.body[0].imagePaths).toEqual(['yes']);
    expect(executedSql()).toHaveLength(4);
  });

  it('never queries the dropped CoinTags table', async () => {
    // The tags table is gone, so a stray tags query would fail outright.
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
    // A caller that says nothing gets no image payloads.
    expect(shouldIncludeImages(undefined)).toBe(false);
  });

  it('defaults to FALSE for anything that is not a string', () => {
    // Arrays, parsed objects and null are not opt-ins.
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
    // A typo fails safe, towards the small response.
    expect(shouldIncludeImages('ture')).toBe(false);
  });

  it('collapses a repeated parameter to its first value', () => {
    expect(shouldIncludeImages(['true', 'false'])).toBe(true);
    expect(shouldIncludeImages(['false', 'true'])).toBe(false);
  });
});
