/**
 * db/catalog-columns.spec.ts — the two catalogue columns on their way in and
 * out of the database.
 *
 * WHY THESE TWO COLUMNS NEED A SPEC OF THEIR OWN
 * `CatalogId` is the first INT FOREIGN KEY this application binds on the
 * Coins table. Every other column here is text, a decimal or a bit, and the
 * generic machinery around them — `normalizeNullable`, which turns an empty
 * value into SQL NULL — is right for all of them. It is NOT right for this
 * one, and the reason is specific:
 *
 *   The CSV importer copies a mapped cell into the record VERBATIM, as a
 *   string. So a coin that has been through Export -> CSV -> Import carries
 *   `catalogId: "3"`, not `catalogId: 3`. Bound straight through, that is a
 *   string arriving at an INT parameter — which the driver may coerce, may
 *   reject, or may turn into a confusing 8114 ("Error converting data type")
 *   depending on the value. A cell holding "Sear" (a header the user mapped
 *   onto the wrong field) would certainly fail, and it would fail at the
 *   point of SAVE, long after the import looked successful.
 *
 * So `catalogId` gets a normalizer that answers an integer or NULL and
 * nothing else. These tests pin that, and the usual schema-drift checks that
 * db/coin-fields.spec.ts applies to the text columns.
 *
 * The round-trip test matters for a plainer reason: a field the API accepts
 * but does not return is a field that silently empties itself the next time
 * the grid reloads.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../test-support/mssql-mock');
  return createMssqlMock();
});

import { resetMssqlMock } from '../test-support/mssql-mock';
import { COIN_FIELDS, normalizeCoinValue, rowToCoin } from './index';

beforeEach(() => {
  resetMssqlMock();
});

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'setup-database.sql'), 'utf8');
const coinsDdl = schemaSql.match(/CREATE TABLE Coins \(([\s\S]*?)\n\);/)?.[1] ?? '';

describe('COIN_FIELDS knows both catalogue columns', () => {
  it('parsed the Coins DDL, so the assertions below are not vacuous', () => {
    expect(coinsDdl).toMatch(/CoinId/);
  });

  it('binds CatalogId to the CatalogId column', () => {
    expect(COIN_FIELDS['catalogId'].column).toBe('CatalogId');
    // INT, so no maxLength — db/coin-fields.spec.ts only length-checks
    // NVARCHAR bindings, and declaring one here would be meaningless.
    expect(COIN_FIELDS['catalogId'].maxLength).toBeUndefined();
    expect(coinsDdl).toMatch(/CatalogId\s+INT\s+NULL/);
  });

  it('binds CatalogNumber at exactly NVARCHAR(50)', () => {
    // Shorter than the column silently truncates the user's reference;
    // longer makes SQL Server raise 8152 and abort the whole save.
    expect(COIN_FIELDS['catalogNumber'].column).toBe('CatalogNumber');
    expect(COIN_FIELDS['catalogNumber'].maxLength).toBe(50);
    expect(COIN_FIELDS['catalogNumber'].sqlType).toMatchObject({ type: 'nvarchar', length: 50 });
    expect(coinsDdl).toMatch(/CatalogNumber\s+NVARCHAR\(50\)\s+NULL/);
  });

  it('gives neither column an insert default', () => {
    // A default would attribute every coin created by a client that has
    // never heard of this feature to a catalogue nobody chose.
    expect(COIN_FIELDS['catalogId'].insertDefault).toBeUndefined();
    expect(COIN_FIELDS['catalogNumber'].insertDefault).toBeUndefined();
  });
});

describe('normalizing catalogId on the way in', () => {
  it('passes a real id straight through', () => {
    expect(normalizeCoinValue('catalogId', 3)).toBe(3);
  });

  it('turns the STRING form a CSV round-trip produces into a number', () => {
    // The whole reason this normalizer exists. See the header.
    expect(normalizeCoinValue('catalogId', '3')).toBe(3);
    expect(normalizeCoinValue('catalogId', ' 3 ')).toBe(3);
  });

  it('turns "no catalogue" into SQL NULL, in all of its spellings', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(normalizeCoinValue('catalogId', empty)).toBeNull();
    }
  });

  it('refuses text that is not a number, rather than letting the driver fail', () => {
    // "Sear" gets here when a user maps a catalogue-NAME column onto this
    // field on the import screen. NULL loses the attribution, which is
    // recoverable; a failed INSERT loses the whole coin, which is not.
    expect(normalizeCoinValue('catalogId', 'Sear')).toBeNull();
    expect(normalizeCoinValue('catalogId', 'KM# 110')).toBeNull();
    expect(normalizeCoinValue('catalogId', Number.NaN)).toBeNull();
  });

  it('truncates nothing and rounds nothing on a legitimate id', () => {
    expect(normalizeCoinValue('catalogId', 15)).toBe(15);
    expect(normalizeCoinValue('catalogId', '15')).toBe(15);
  });
});

describe('normalizing catalogNumber on the way in', () => {
  it('has NO normalizer, deliberately', () => {
    // The plainest entry in COIN_FIELDS, exactly like `variety` and
    // `storageLocation` beside it. Anything this app did to the text --
    // upper-casing it, trimming it to a pattern, matching it against a
    // lookup -- would rewrite a key into a printed book. If a future change
    // gives this field a normalizer, the reason had better be written down.
    expect(COIN_FIELDS['catalogNumber'].normalize).toBeUndefined();
  });

  it('stores the reference exactly as the catalogues write it', () => {
    // No upper-casing, no stripping of dots or slashes, no collapsing of the
    // internal space. A reference the app tidied no longer matches the book.
    for (const reference of ['1A', '6819', 'II.1 234', 'RRC 44/5']) {
      expect(normalizeCoinValue('catalogNumber', reference)).toBe(reference);
    }
  });

  it('turns an absent field into SQL NULL', () => {
    expect(normalizeCoinValue('catalogNumber', undefined)).toBeNull();
    expect(normalizeCoinValue('catalogNumber', null)).toBeNull();
  });

  it('leaves an empty box as the empty string the client sent', () => {
    // This is the house behaviour of normalizeNullable (only `undefined`
    // becomes NULL), shared with certNumber, variety and storageLocation.
    // Pinned rather than "fixed": both spellings of empty read as "no
    // reference" everywhere above this layer -- formatCatalogReference()
    // trims and treats '' and null alike -- so changing it here would be a
    // behavioural difference between this column and its neighbours for no
    // user-visible gain.
    expect(normalizeCoinValue('catalogNumber', '')).toBe('');
  });
});

describe('reading both columns back out', () => {
  it('returns them to the Angular app under their camelCase names', () => {
    const coin = rowToCoin({
      CoinId: 'abc', CatalogId: 1, CatalogNumber: '6819'
    });
    expect(coin['catalogId']).toBe(1);
    expect(coin['catalogNumber']).toBe('6819');
  });

  it('omits them entirely for a coin that has no reference', () => {
    // `undefined`, not null and not 0: JSON.stringify drops the key, so the
    // client can tell "never recorded" from "recorded as blank" — the same
    // rule coinSet and storageLocation follow. A 0 here would be read as a
    // catalogue id by anything that checks truthiness the wrong way round.
    const coin = rowToCoin({ CoinId: 'abc', CatalogId: null, CatalogNumber: null });
    expect(coin['catalogId']).toBeUndefined();
    expect(coin['catalogNumber']).toBeUndefined();
  });

  it('survives a row from a database the migration has not reached', () => {
    // Until 012 has been run the columns do not exist, so the row has no
    // such keys at all. That must read as "no reference", not as a crash.
    const coin = rowToCoin({ CoinId: 'abc' });
    expect(coin['catalogId']).toBeUndefined();
    expect(coin['catalogNumber']).toBeUndefined();
  });
});
