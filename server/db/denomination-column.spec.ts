/**
 * Coins.DenominationId on its way in and out. PUT builds its UPDATE from
 * COIN_FIELDS, so a missing binding would silently drop the value. Checks:
 *
 *   1. the binding exists and is an INT;
 *   2. values normalize to an integer or NULL (shared with catalogId, since CSV
 *      imports deliver "3" or a mis-mapped "8 Reales");
 *   3. it comes back out through rowToCoin().
 *
 * The end-to-end HTTP test is in routes/coins/denomination-id.spec.ts.
 */

import { describe, it, expect } from 'vitest';

import { insertCoin, queryRows } from '../test-support/sqlite-test-db';
import { parseTable } from '../test-support/schema-columns';
import { COIN_FIELDS, normalizeCoinValue, normalizeForeignKeyId, rowToCoin } from './index';

const schemaColumns = parseTable('Coins');

describe('COIN_FIELDS binds Coins.DenominationId', () => {
  it('parsed the Coins DDL, so the assertions below are not vacuous', () => {
    expect(schemaColumns.has('CoinId')).toBe(true);
    expect(schemaColumns.get('DenominationId')).toMatchObject({
      storage: 'INTEGER',
      declared: 'INT',
      notNull: false,
    });
  });

  it('has an entry at all — without one the UPDATE never names the column', () => {
    // PUT filters COIN_FIELDS by body keys, so an unbound key would be silently dropped.
    expect(COIN_FIELDS['denominationId']).toBeDefined();
  });

  it('points at the DenominationId column as an INT', () => {
    expect(COIN_FIELDS['denominationId'].column).toBe('DenominationId');
    // INT, so no maxLength.
    expect(COIN_FIELDS['denominationId'].maxLength).toBeUndefined();
    expect(COIN_FIELDS['denominationId'].sqlType).toMatchObject({
      storage: 'int',
      declared: 'INT',
    });
  });

  it('keeps Denomination bound as text beside it, unchanged', () => {
    // Both columns: the id is the canonical link, the text is what the source said.
    expect(COIN_FIELDS['denomination'].column).toBe('Denomination');
    expect(COIN_FIELDS['denomination'].maxLength).toBe(100);
    // db/bind-values.ts enforces this width, so it must match db/schema.sql.
    expect(COIN_FIELDS['denomination'].sqlType).toMatchObject({
      storage: 'text',
      maxLength: 100,
      declared: 'NVARCHAR(100)',
    });
    expect(schemaColumns.get('Denomination')).toMatchObject({
      storage: 'TEXT',
      declared: 'NVARCHAR(100)',
      maxLength: 100,
    });
  });

  it('gives it no insert default', () => {
    // No default: NULL ("never linked") is the normal state of an imported coin.
    expect(COIN_FIELDS['denominationId'].insertDefault).toBeUndefined();
  });
});

describe('normalizing denominationId on the way in', () => {
  it('passes a real id straight through', () => {
    expect(normalizeCoinValue('denominationId', 42)).toBe(42);
  });

  it('turns the STRING form a CSV round-trip produces into a number', () => {
    expect(normalizeCoinValue('denominationId', '42')).toBe(42);
    expect(normalizeCoinValue('denominationId', ' 42 ')).toBe(42);
  });

  it('turns "no denomination link" into SQL NULL, in all of its spellings', () => {
    // NULL is the normal state (unseeded issuer, deleted denomination).
    for (const empty of [null, undefined, '', '   ']) {
      expect(normalizeCoinValue('denominationId', empty)).toBeNull();
    }
  });

  it('refuses a label where an id belongs, rather than letting the driver fail', () => {
    // A mis-mapped label column. NULL keeps the save working; the user can relink.
    expect(normalizeCoinValue('denominationId', '8 Reales')).toBeNull();
    expect(normalizeCoinValue('denominationId', 'Crown')).toBeNull();
    expect(normalizeCoinValue('denominationId', Number.NaN)).toBeNull();
    expect(normalizeCoinValue('denominationId', '3 sheep')).toBeNull();
  });

  it('uses the shared foreign-key normalizer that catalogue references also use', () => {
    expect(normalizeForeignKeyId('3')).toBe(3);
    expect(normalizeForeignKeyId('Sear')).toBeNull();
    expect(normalizeForeignKeyId('')).toBeNull();
  });
});

describe('reading DenominationId back out', () => {
  it('returns it to the Angular app under its camelCase name', () => {
    const coin = rowToCoin({ CoinId: 'abc', Denomination: '8 Reales', DenominationId: 7 });
    expect(coin['denominationId']).toBe(7);
    expect(coin['denomination']).toBe('8 Reales');
  });

  it('returns NULL as null, NOT as undefined', () => {
    // null (not undefined, unlike catalogId): the key is always present so
    // the client has one check for "text but no link".
    const coin = rowToCoin({ CoinId: 'abc', Denomination: '8 Reales', DenominationId: null });
    expect(coin['denominationId']).toBeNull();
  });

  it('survives a row from a database migration 011 has not reached', () => {
    // Before migration 011 the column doesn't exist; that must read as "no link".
    const coin = rowToCoin({ CoinId: 'abc' });
    expect(coin['denominationId']).toBeNull();
  });

  it('keeps the recorded text even when the link is set and disagrees', () => {
    // Both text and id are kept; neither overwrites the other.
    const coin = rowToCoin({ CoinId: 'abc', Denomination: 'Pillar Dollar', DenominationId: 7 });
    expect(coin['denomination']).toBe('Pillar Dollar');
    expect(coin['denominationId']).toBe(7);
  });
});

/** The same mapping, using rows that actually came out of SQLite. */
describe('reading DenominationId back out of a real row', () => {
  it('hands the mapper a number, so the link survives the database', async () => {
    // A value stored as text would come back as a string and fail `=== 7` on the client.
    await insertCoin({ CoinId: 'abc', Denomination: 'Pillar Dollar', DenominationId: 7 });

    const [row] = await queryRows("SELECT * FROM Coins WHERE CoinId = 'abc'");
    expect(typeof row['DenominationId']).toBe('number');

    const coin = rowToCoin(row);
    expect(coin['denominationId']).toBe(7);
    expect(coin['denomination']).toBe('Pillar Dollar');
  });

  it('hands the mapper SQL NULL for an unresolved coin, which maps to null', async () => {
    // `?? null` must see a real null, not '' or 0.
    await insertCoin({ CoinId: 'abc', Denomination: '100 Soles', DenominationId: null });

    const [row] = await queryRows("SELECT * FROM Coins WHERE CoinId = 'abc'");
    expect(row['DenominationId']).toBeNull();
    expect(rowToCoin(row)['denominationId']).toBeNull();
  });
});
