/**
 * How DECIMAL values are stored. SQLite has no decimal type, so the money and
 * weight columns are REAL, with SQL Server's precision and scale reapplied by
 * db/bind-values.ts (see the db/schema.sql header).
 *
 * A wrong weight looks as plausible as a right one, so these tests compare
 * values out against values in:
 *
 *   1. a value written reads back as the identical double;
 *   2. values are rounded to the column's scale, as SQL Server did;
 *   3. a value too large for the column is refused.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { insertCoin, queryRows, withTestDb } from '../test-support/sqlite-test-db';
import { parseTable } from '../test-support/schema-columns';
import { app } from '../server';
import { roundToScale, decimalLimit, toBindValue, DbValueError } from './bind-values';
import { Decimal } from './column-types';
import { COIN_FIELDS } from './index';

/** The money and weight columns on Coins, and their declared types. */
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
    // Drift here would make rounding differ from SQL Server's.
    for (const [column, declared] of MONEY_AND_WEIGHT) {
      const binding = Object.values(COIN_FIELDS).find((field) => field.column === column);
      expect(binding?.sqlType.declared, column).toBe(declared);
    }
  });
});

describe('a value written is the identical double when read back', () => {
  /**
   * 26.73 g is a Morgan dollar; 24.05582 is its silver content (0.7734 ozt x
   * 31.1034768), using all five decimals. 0.1 + 0.2 shows the claim is
   * bit-identical doubles, not decimal literals.
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
    // Declared as REAL (not DECIMAL, which gets NUMERIC affinity and would
    // store 26.0 as INTEGER 26), so the storage class doesn't depend on the value.
    await insertCoin({ CoinId: 'whole', Denomination: '$1', Weight: 26 });

    const [row] = await queryRows(
      "SELECT typeof(Weight) AS t FROM Coins WHERE CoinId = 'whole'"
    );
    expect(row['t']).toBe('real');
  });

  it('round-trips a price through the HTTP layer, which is where it actually travels', async () => {
    // End to end: JSON in, JSON out, unchanged.
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
    // SQL Server would have stored 1.23457; so must this.
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
    // Half away from zero, as SQL Server does (Math.round(-0.5) is -0).
    expect(roundToScale(-0.005, 2)).toBe(-0.01);
    expect(roundToScale(0.005, 2)).toBe(0.01);
  });

  it('re-rounding an already-rounded value changes nothing', () => {
    // Values already at their column's scale must pass through unchanged,
    // or the SQL Server import's verification would fail on its own rounding.
    for (const value of [26.73, 24.05582, 0.7734, 1234.56, 90.0, 0.00001]) {
      const once = roundToScale(value, 5);
      expect(roundToScale(once, 5)).toBe(once);
    }
  });

  it('leaves a value alone rather than mangling it when scaling would exceed 2^53', () => {
    // DECIMAL(18,6) values can exceed 2^53 when scaled; such values are left unrounded.
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
    // SQL Server raised an overflow; here it is refused with a 400.
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
    // The boundary from the other side.
    expect(toBindValue('weight', Decimal(12, 5), 9999999.99999)).toBe(9999999.99999);
    expect(() => toBindValue('weight', Decimal(12, 5), 10000000)).toThrow(DbValueError);
  });

  it('refuses a value that is not a number at all', () => {
    // A CSV round trip can put the string "" or "n/a" in a numeric field.
    expect(() => toBindValue('weight', Decimal(12, 5), 'n/a')).toThrow(DbValueError);
    // ...but a numeric string (from a CSV round trip) is converted.
    expect(toBindValue('weight', Decimal(12, 5), '26.73')).toBe(26.73);
  });

  it('never stores text in a REAL column, which SQLite would happily do', async () => {
    // A string stored in Weight would sort and sum wrongly while looking normal.
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
    // Copper is DECIMAL(10,4); rounding it to 2 places would lose its value.
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
  it('rounds a sale price to the two decimals DECIMAL(12,2) holds', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'sold', denomination: '$1', soldPrice: 1234.567, soldTo: 'Heritage' });
    expect(res.status).toBe(201);

    const [row] = await queryRows("SELECT SoldPrice AS s FROM Coins WHERE CoinId = 'sold'");
    expect(row['s']).toBe(1234.57);
  });

  it('keeps the seeded sub-cent face values intact', async () => {
    // The US half cent's 0.005 needs FaceValue's DECIMAL(18,6).
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
