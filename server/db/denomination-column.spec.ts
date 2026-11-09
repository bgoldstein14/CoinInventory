/**
 * db/denomination-column.spec.ts — Coins.DenominationId on its way in and out.
 *
 * WHY THIS COLUMN NEEDS A SPEC OF ITS OWN
 * `PUT /api/coins/:id` builds its UPDATE from COIN_FIELDS, so a column with
 * no COIN_FIELDS entry is never written: the editor picks a denomination, the
 * PUT returns 200, and the next reload shows the old value. That is the worst
 * shape a bug can take in this application, and nothing about it is visible
 * from a status code — hence a spec that proves the round trip.
 *
 * Three things are asserted, and each one is a different failure:
 *
 *   1. THE BINDING EXISTS AND IS AN INT. Without it the UPDATE never names
 *      the column. With the wrong type the driver rejects the value.
 *   2. THE VALUE IS NORMALISED TO AN INTEGER OR NULL. Exactly the problem
 *      `catalogId` has, for exactly the same reasons — see the long note on
 *      that binding in db/coin-fields.ts. A CSV round trip turns 3 into "3";
 *      a user mapping a denomination-LABEL column onto this field on the
 *      import screen sends "8 Reales". Bound straight through, the first may
 *      or may not coerce depending on the driver and the second certainly
 *      fails with SQL Server 8114, at SAVE time, aborting the transaction
 *      and losing the whole coin rather than merely its link.
 *   3. IT COMES BACK OUT AGAIN. A field the API accepts but does not return
 *      is a field that silently empties itself on the next reload.
 *
 * ON THE SHARED NORMALISER: `catalogId` and `denominationId` are the only
 * two INT foreign keys on this table and they have identical requirements,
 * so they share one function rather than carrying two copies that can drift.
 * The catalogue tests in db/catalog-columns.spec.ts still pass unchanged,
 * which is what proves the sharing did not change either one's behaviour.
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

describe('COIN_FIELDS binds Coins.DenominationId', () => {
  it('parsed the Coins DDL, so the assertions below are not vacuous', () => {
    expect(coinsDdl).toMatch(/CoinId/);
    expect(coinsDdl).toMatch(/DenominationId\s+INT\s+NULL/);
  });

  it('has an entry at all — without one the UPDATE never names the column', () => {
    // This is the whole bug. `PUT /api/coins/:id` filters COIN_FIELDS by the
    // keys present in the request body, so a key with no binding is dropped
    // on the floor and the save reports success.
    expect(COIN_FIELDS['denominationId']).toBeDefined();
  });

  it('points at the DenominationId column as an INT', () => {
    expect(COIN_FIELDS['denominationId'].column).toBe('DenominationId');
    // INT, so no maxLength — db/coin-fields.spec.ts only length-checks
    // NVARCHAR bindings and declaring one here would be meaningless.
    expect(COIN_FIELDS['denominationId'].maxLength).toBeUndefined();
  });

  it('keeps Denomination bound as text beside it, unchanged', () => {
    // *** BOTH COLUMNS, DELIBERATELY. *** The id is the
    // canonical link; the text is what the source said. Replacing one with
    // the other is what the design calls a failure even if it works.
    expect(COIN_FIELDS['denomination'].column).toBe('Denomination');
    expect(COIN_FIELDS['denomination'].maxLength).toBe(100);
  });

  it('gives it no insert default', () => {
    // A default would link every coin created by a client that has never
    // heard of this feature to a denomination nobody chose. NULL means
    // "never established", which is the normal state of an imported coin.
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
    // NULL is the ORDINARY state here, not an error: every coin that arrived
    // by import before its issuer was seeded has one, and deleting a
    // back into it when a denomination is deleted.
    for (const empty of [null, undefined, '', '   ']) {
      expect(normalizeCoinValue('denominationId', empty)).toBeNull();
    }
  });

  it('refuses a label where an id belongs, rather than letting the driver fail', () => {
    // "8 Reales" gets here when a user maps a denomination-NAME column onto
    // this field on the import screen. NULL loses the link, which the user
    // can see (the coin reads as unresolved) and fix in one click; a failed
    // INSERT loses the whole coin.
    expect(normalizeCoinValue('denominationId', '8 Reales')).toBeNull();
    expect(normalizeCoinValue('denominationId', 'Crown')).toBeNull();
    expect(normalizeCoinValue('denominationId', Number.NaN)).toBeNull();
    expect(normalizeCoinValue('denominationId', '3 sheep')).toBeNull();
  });

  it('did not change how catalogId normalises, now that they share a function', () => {
    // The two INT foreign keys on Coins share one normaliser. If sharing it
    // had altered either, this is where it would show.
    expect(normalizeCoinValue('catalogId', '3')).toBe(3);
    expect(normalizeCoinValue('catalogId', 'Sear')).toBeNull();
    expect(normalizeCoinValue('catalogId', '')).toBeNull();
  });
});

describe('reading DenominationId back out', () => {
  it('returns it to the Angular app under its camelCase name', () => {
    const coin = rowToCoin({ CoinId: 'abc', Denomination: '8 Reales', DenominationId: 7 });
    expect(coin['denominationId']).toBe(7);
    expect(coin['denomination']).toBe('8 Reales');
  });

  it('returns NULL as null, NOT as undefined', () => {
    // *** DELIBERATELY UNLIKE catalogId AND coinSet BESIDE IT. ***
    // `undefined` is dropped by JSON.stringify, and the editor needs to be
    // able to say "this coin has text and no link" — which is the state that
    // renders as unresolved and opens the custom box. A missing key and a
    // null would both have to mean that, so the client would need two checks
    // where it should need one, and the first consumer to forget the second
    // check would show an imported coin as though it were resolved.
    const coin = rowToCoin({ CoinId: 'abc', Denomination: '8 Reales', DenominationId: null });
    expect(coin['denominationId']).toBeNull();
  });

  it('survives a row from a database migration 011 has not reached', () => {
    // Until 011 has been run the column does not exist, so the row has no
    // such key at all. That must read as "no link", not as a crash.
    const coin = rowToCoin({ CoinId: 'abc' });
    expect(coin['denominationId']).toBeNull();
  });

  it('keeps the recorded text even when the link is set and disagrees', () => {
    // The NORMAL state after migration 014 resolves a coin: the text still
    // says what the QIF said and the id says what it turned out to be.
    // Neither overwrites the other, here or anywhere.
    const coin = rowToCoin({ CoinId: 'abc', Denomination: 'Pillar Dollar', DenominationId: 7 });
    expect(coin['denomination']).toBe('Pillar Dollar');
    expect(coin['denominationId']).toBe(7);
  });
});
