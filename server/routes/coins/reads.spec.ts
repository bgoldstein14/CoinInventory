/**
 * routes/coins/reads.spec.ts — HTTP tests for the read-only coin endpoints
 * (routes/coins/reads.ts).
 *
 * *** THESE ROWS ARE NO LONGER CANNED. *** They are inserted into a real
 * in-memory SQLite database built from db/schema.sql, and read back out
 * through the real query the route runs. The previous version of this file
 * queued recordsets on a hand-written mock IN CALL ORDER, which meant the
 * test's idea of how many queries the handler runs had to be kept in step by
 * hand — and meant a route could pass while naming a column the schema does
 * not have.
 *
 * The CamelCase column names below are still the point: translating them
 * into the camelCase JSON the Angular app expects is exactly what rowToCoin()
 * in db/row-mappers.ts is being tested for.
 *
 * GET /api/coins runs no image-payload read at all unless the caller passes
 * ?includeImages=true — see list-query.spec.ts for why. The single-coin
 * endpoint still returns its images inline: one coin's photographs is a few
 * megabytes at worst, which is the entire reason a per-coin endpoint exists
 * for the client to fall back to.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { executedSql, insertCoin, withTestDb } from '../../test-support/sqlite-test-db';
import { app } from '../../server';

describe('GET /api/coins', () => {
  it('returns an empty array when no coins exist', async () => {
    const res = await request(app).get('/api/coins');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('maps every column, and carries imageCount INSTEAD OF the images', async () => {
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: '$1',
      Year: '1921',
      CoinType: 'Morgan',
      Category: 'Silver Dollars',
      Country: 'USA',
      Grade: 'MS-65',
      CertCompany: 'PCGS',
      CertNumber: '12345678',
      Variety: null,
      MintMark: 'S',
      Composition: '90% Silver',
      PurchaseDate: '2024-01-15',
      PurchasePrice: 150.0,
      CurrentValue: 200.0,
      Notes: 'Nice toning',
      Source: 'manual',
      HasCacSticker: 1,
      SoldPrice: null,
      SoldDate: null,
      Weight: 0.7734,
      MetalContent: 'Silver',
      CoinSet: null,
      PmWeightGrams: 24.06,
      PmPercent: 90,
    });

    await withTestDb((database) => {
      database
        .prepare('INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES (?, ?, 0)')
        .run('abc-123', 'data:image/jpeg;base64,AAAA');
    });

    const res = await request(app).get('/api/coins');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const coin = res.body[0];
    expect(coin.id).toBe('abc-123');
    expect(coin.denomination).toBe('$1');
    expect(coin.coinType).toBe('Morgan');
    expect(coin.year).toBe('1921');
    expect(coin.grade).toBe('MS-65');
    expect(coin.hasCacSticker).toBe(true);
    // NOT an empty array — THE KEY IS ABSENT. That distinction is the whole
    // contract: a client has to be able to tell "this coin's photographs were
    // not loaded" from "this coin has no photographs", because echoing the
    // second one back in a PUT would delete the first one's pictures.
    expect(coin).not.toHaveProperty('imagePaths');
    expect(coin.imageCount).toBe(1);
    // The tag feature is gone, so the key must not come back at all.
    expect(coin).not.toHaveProperty('tags');
    // The coin-level dealer field is gone too, so the key must not come back
    // even if an old database still has the column. (The deal's counterparty
    // is purchasedFrom / soldTo, which are ordinary coin fields.)
    expect(coin).not.toHaveProperty('dealer');
    expect(coin.weight).toBe(0.7734);
    expect(coin.metalContent).toBe('Silver');
    expect(coin.pmWeightGrams).toBe(24.06);
    expect(coin.pmPercent).toBe(90);
  });
});

describe('GET /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    const res = await request(app).get('/api/coins/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns a single coin with its images', async () => {
    await insertCoin({
      CoinId: 'xyz-789',
      Denomination: '1¢',
      Year: '1909',
      CoinType: 'Lincoln',
      Category: null,
      Country: 'USA',
      Grade: 'VF-30',
      CertCompany: 'NGC',
      CertNumber: '99999',
      Variety: 'VDB',
      MintMark: 'S',
      Composition: 'Copper',
      PurchaseDate: null,
      PurchasePrice: 1200,
      CurrentValue: 1500,
      Notes: null,
      Source: 'quicken',
      HasCacSticker: 0,
      SoldPrice: null,
      SoldDate: null,
      Weight: null,
      MetalContent: null,
      CoinSet: null,
    });

    const res = await request(app).get('/api/coins/xyz-789');
    expect(res.status).toBe(200);
    expect(res.body.denomination).toBe('1¢');
    expect(res.body.coinType).toBe('Lincoln');
    expect(res.body.year).toBe('1909');
    expect(res.body.hasCacSticker).toBe(false);
    expect(res.body.imagePaths).toEqual([]);
    expect(res.body).not.toHaveProperty('tags');

    // Exactly two queries, and neither of them touches the dropped table.
    const statements = executedSql();
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement).not.toContain('CoinTags');
    }
  });
});
