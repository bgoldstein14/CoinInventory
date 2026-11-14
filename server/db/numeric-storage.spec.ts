/**
 * db/numeric-storage.spec.ts — THE DECISION THE WHOLE MIGRATION TURNS ON.
 *
 * SQLite has no decimal type. Six columns on Coins, plus the four SpotPrices
 * columns and Denominations.FaceValue, were DECIMAL under
 * SQL Server. They are REAL — IEEE-754 binary64 — here, and the precision and
 * scale SQL Server used to enforce are reapplied at the parameter boundary by
 * db/bind-values.ts. The full argument is in the header of db/schema.sql.
 *
 * *** WHY THIS FILE EXISTS RATHER THAN A COMMENT. *** Design §4.1 says it
 * plainly: a wrong weight is indistinguishable from a right one. Both 0.7734
 * and 24.05582 are entirely plausible for a Morgan dollar, so nothing
 * downstream — not the UI, not the melt-value calculation, not the owner
 * looking at the screen — can detect that a number went through a lossy step.
 * There is no symptom. The only defence is a test that compares the number
 * out against the number in, which is also exactly what Stage 2's one-time
 * import has to do.
 *
 * The three properties below are the ones the storage choice was made for,
 * in the order they matter:
 *
 *   1. a value written is the identical double when read back (REAL);
 *   2. a value is rounded to the column's scale on the way in, as SQL Server
 *      did, so the same request stores the same number on both engines;
 *   3. a value too large for the column is REFUSED, as SQL Server refused it,
 *      rather than silently stored.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { insertCoin, queryRows, withTestDb } from '../test-support/sqlite-test-db';
import { parseTable } from '../test-support/schema-columns';
import { app } from '../server';
import { roundToScale, decimalLimit, toBindValue, DbValueError } from './bind-values';
import { Decimal } from './column-types';
import { COIN_FIELDS } from './index';

/** The six columns design §4.1 names, and what they are declared as. */
const MONEY_AND_WEIGHT: ReadonlyArray<[string, string]> = [
  ['Weight', 'DECIMAL(12,5)'],
  ['PmWeightGrams', 'DECIMAL(12,5)'],
  ['PmPercent', 'DECIMAL(5,2)'],
  ['PurchasePrice', 'DECIMAL(12,2)'],
  ['CurrentValue', 'DECIMAL(12,2)'],
  ['SoldPrice', 'DECIMAL(12,2)'],
];

describe('the six columns §4.1 names are stored as REAL with their scale recorded', () => {
  const columns = parseTable('Coins');

  it.each(MONEY_AND_WEIGHT)('%s is REAL, declared %s', (column, declared) => {
    const schemaColumn = columns.get(column);
    expect(schemaColumn?.storage).toBe('REAL');
    expect(schemaColumn?.declared).toBe(declared);
  });

  it('every one of them has a binding whose scale matches the schema', () => {
    // If these drift, the rounding applied on the way in stops matching the
    // rounding SQL Server applied, and Stage 2's before/after comparison
    // starts reporting differences that are the migration's own fault.
    for (const [column, declared] of MONEY_AND_WEIGHT) {
      const binding = Object.values(COIN_FIELDS).find((field) => field.column === column);
      expect(binding?.sqlType.declared, column).toBe(declared);
    }
  });
});

describe('a value written is the identical double when read back', () => {
  /**
   * These are not arbitrary. 26.73 g is a Morgan dollar; 24.05582 is its
   * silver content and is the number migration 008 produced by multiplying
   * 0.7734 troy ounces by 31.1034768 — i.e. a value with every one of the
   * five decimals in use. 0.1 + 0.2 is the canonical float-inexactness
   * example and is here to show what IS and IS NOT being claimed: the stored
   * double is bit-identical to the one handed over, not to the decimal
   * literal a human would write.
   */
  const weights = [26.73, 24.05582, 0.7734, 31.1034768 * 0.7734, 0.1 + 0.2, 99999.99999, 0];

  it.each(weights)('round-trips %p through Coins.PmWeightGrams exactly', async (value) => {
    const rounded = roundToScale(value, 5);
    await insertCoin({ CoinId: `w-${value}`, Denomination: '$1', PmWeightGrams: rounded });

    const [row] = await queryRows('SELECT PmWeightGrams AS w FROM Coins WHERE CoinId = @id', {
      id: `w-${value}`,
    });
    expect(row['w']).toBe(rounded);
  });

  it('stores REAL, not the NUMERIC affinity that would silently become an INTEGER', async () => {
    // A column declared `DECIMAL(12,5)` in SQLite gets NUMERIC affinity,
    // under which 26.0 is stored as the INTEGER 26. That is harmless in
    // JavaScript and misleading everywhere else — a column whose storage
    // class depends on the value is a column nobody can reason about, and
    // Stage 2's verification would be comparing types as well as values.
    // Declaring REAL forces an 8-byte float every time.
    await insertCoin({ CoinId: 'whole', Denomination: '$1', Weight: 26 });

    const [row] = await queryRows(
      "SELECT typeof(Weight) AS t FROM Coins WHERE CoinId = 'whole'"
    );
    expect(row['t']).toBe('real');
  });

  it('round-trips a price through the HTTP layer, which is where it actually travels', async () => {
    // The claim that matters is end to end: JSON in, JSON out, unchanged.
    await request(app)
      .post('/api/coins')
      .send({ id: 'priced', denomination: '$1', purchasePrice: 1234.56, weight: 24.05582 });

    const res = await request(app).get('/api/coins/priced');
    expect(res.body.purchasePrice).toBe(1234.56);
    expect(res.body.weight).toBe(24.05582);
  });
});

describe('a value is rounded to the column scale on the way in, as SQL Server did', () => {
  it('rounds a 7-decimal weight to the 5 decimals DECIMAL(12,5) held', async () => {
    // Without this, the identical POST stores 1.234567 here and 1.23457 on
    // SQL Server — and nothing anywhere reports the difference.
    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'rounded', denomination: '$1', weight: 1.2345678 });
    expect(res.status).toBe(201);

    const [row] = await queryRows("SELECT Weight AS w FROM Coins WHERE CoinId = 'rounded'");
    expect(row['w']).toBe(1.23457);
  });

  it('rounds money to 2 decimals', async () => {
    await request(app)
      .post('/api/coins')
      .send({ id: 'money', denomination: '$1', purchasePrice: 10.005, currentValue: 10.004 });

    const [row] = await queryRows(
      "SELECT PurchasePrice AS p, CurrentValue AS c FROM Coins WHERE CoinId = 'money'"
    );
    expect(row['p']).toBe(10.01);
    expect(row['c']).toBe(10.0);
  });

  it('rounds half AWAY FROM ZERO, not half towards positive infinity', () => {
    // Math.round(-0.5) is -0; SQL Server's conversion gives -1. Nothing in
    // this schema is routinely negative, but a rule that is right only for
    // the values we happen to see is not a rule.
    expect(roundToScale(-0.005, 2)).toBe(-0.01);
    expect(roundToScale(0.005, 2)).toBe(0.01);
  });

  it('re-rounding an already-rounded value changes nothing', () => {
    // The property Stage 2 depends on. The owner's SQL Server values are
    // already at their column's scale, so the import must be able to push
    // each one through this boundary and get the same double out — otherwise
    // the value-by-value verification fails on the migration's own rounding.
    for (const value of [26.73, 24.05582, 0.7734, 1234.56, 90.0, 0.00001]) {
      const once = roundToScale(value, 5);
      expect(roundToScale(once, 5)).toBe(once);
    }
  });

  it('leaves a value alone rather than mangling it when scaling would exceed 2^53', () => {
    // DECIMAL(18,6) — Denominations.FaceValue — can in principle hold a
    // number whose scaled form is larger than a double can represent as an
    // integer. No coin has such a face value, but rounding it would produce
    // noise rather than a rounded number, so the multiply is guarded.
    const huge = 1e12;
    expect(roundToScale(huge, 6)).toBe(huge);
  });
});

describe('a value too large for its column is refused, not silently stored', () => {
  it('knows each column range', () => {
    expect(decimalLimit(12, 5)).toBe(1e7);
    expect(decimalLimit(12, 2)).toBe(1e10);
    expect(decimalLimit(5, 2)).toBe(1e3);
  });

  it('rejects a weight past DECIMAL(12,5) with a 400, leaving the row untouched', async () => {
    // SQL Server raised an arithmetic overflow. SQLite would store it. The
    // value is refused here, and routes/db-error-response.ts answers 400 so
    // the user is told rather than shown a 500 or, worse, a saved coin whose
    // weight is nonsense.
    await insertCoin({ CoinId: 'overflow', Denomination: '$1', Weight: 26.73 });

    const res = await request(app).put('/api/coins/overflow').send({ weight: 1e9 });
    expect(res.status).toBe(400);

    const [row] = await queryRows("SELECT Weight AS w FROM Coins WHERE CoinId = 'overflow'");
    expect(row['w']).toBe(26.73);
  });

  it('rejects a percentage past DECIMAL(5,2)', async () => {
    await insertCoin({ CoinId: 'pct', Denomination: '$1', PmPercent: 90 });

    const res = await request(app).put('/api/coins/pct').send({ pmPercent: 1000 });
    expect(res.status).toBe(400);

    const [row] = await queryRows("SELECT PmPercent AS p FROM Coins WHERE CoinId = 'pct'");
    expect(row['p']).toBe(90);
  });

  it('accepts the largest value the column can hold', () => {
    // The boundary from the other side, so "reject" is not implemented as
    // "reject everything big".
    expect(toBindValue('weight', Decimal(12, 5), 9999999.99999)).toBe(9999999.99999);
    expect(() => toBindValue('weight', Decimal(12, 5), 10000000)).toThrow(DbValueError);
  });

  it('refuses a value that is not a number at all', () => {
    // A CSV round trip can put the string "" or "n/a" in a numeric field.
    expect(() => toBindValue('weight', Decimal(12, 5), 'n/a')).toThrow(DbValueError);
    // ...but a numeric string is accepted and converted, because that is what
    // Export -> CSV -> Import produces for a perfectly good weight.
    expect(toBindValue('weight', Decimal(12, 5), '26.73')).toBe(26.73);
  });

  it('never stores text in a REAL column, which SQLite would happily do', async () => {
    // The failure mode unique to a dynamically-typed engine: a string that
    // slipped past the binding layer would sit in Weight as TEXT, compare
    // wrongly in every ORDER BY and SUM, and look completely normal in the
    // UI. db/bind-values.ts is what prevents it.
    await request(app).post('/api/coins').send({
      id: 'typed',
      denomination: '$1',
      weight: '26.73',
      purchasePrice: '1234.56',
    });

    const [row] = await queryRows(
      "SELECT typeof(Weight) AS w, typeof(PurchasePrice) AS p FROM Coins WHERE CoinId = 'typed'"
    );
    expect(row['w']).toBe('real');
    expect(row['p']).toBe('real');
  });

  it('keeps SpotPrices.Copper at four decimals, not two', async () => {
    // Copper trades in cents, so it is the one price column with
    // DECIMAL(10,4). Rounding it like the others would lose the digits that
    // carry the whole value.
    const res = await request(app)
      .post('/api/spot-prices')
      .send({ gold: 2650.55, silver: 31.25, platinum: 980.1, copper: 4.1234, source: 'manual' });
    expect(res.status).toBe(201);

    const [row] = await queryRows('SELECT Gold, Copper FROM SpotPrices');
    expect(row['Gold']).toBe(2650.55);
    expect(row['Copper']).toBe(4.1234);
  });
});

describe('Denominations.FaceValue', () => {
  // The case that used to live here posted 1234.567 to /api/transactions and
  // checked Transactions.Amount came back 1234.57. The table is gone and the
  // route with it; the SAME property is now carried by the coin's own money
  // columns, in the DECIMAL(12,2) case above and in SoldPrice here, which
  // became user-editable when the deal record moved onto the coin.
  it('rounds a sale price to the two decimals DECIMAL(12,2) holds', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'sold', denomination: '$1', soldPrice: 1234.567, soldTo: 'Heritage' });
    expect(res.status).toBe(201);

    const [row] = await queryRows("SELECT SoldPrice AS s FROM Coins WHERE CoinId = 'sold'");
    expect(row['s']).toBe(1234.57);
  });

  it('keeps the seeded sub-cent face values intact', async () => {
    // The US half cent is seeded with faceValue 0.005, which a 2-decimal
    // column would have rounded to 0.01 or 0.00. FaceValue is DECIMAL(18,6)
    // precisely so it does not.
    const [row] = await queryRows(
      "SELECT FaceValue AS f FROM Denominations WHERE Label = '½¢' AND Country = 'US'"
    );
    expect(row['f']).toBe(0.005);
  });

  it('stores FaceValue as REAL too', async () => {
    const [row] = await withTestDb((database) =>
      database
        .prepare("SELECT typeof(FaceValue) AS t FROM Denominations WHERE Label = '½¢' AND Country = 'US'")
        .all()
    );
    expect(row['t']).toBe('real');
  });
});
