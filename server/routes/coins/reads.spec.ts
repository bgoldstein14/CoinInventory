/**
 * HTTP tests for the read-only coin endpoints, against real rows. Checks the
 * PascalCase -> camelCase mapping in rowToCoin(). The list has no image
 * payloads (see list-query.spec.ts); a single coin includes its images.
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
    // The key is absent, not []: echoing [] back in a PUT would delete photos.
    expect(coin).not.toHaveProperty('imagePaths');
    expect(coin.imageCount).toBe(1);
    // Tags are gone.
    expect(coin).not.toHaveProperty('tags');
    // The coin-level dealer field is gone too (purchasedFrom / soldTo replaced it).
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

    // Coin, references and images; none touching the dropped table.
    const statements = executedSql();
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).not.toContain('CoinTags');
    }
  });
});
