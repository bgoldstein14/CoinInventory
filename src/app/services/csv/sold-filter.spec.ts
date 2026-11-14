/*
 * "IMPORT ONLY COINS I STILL OWN" ON THE CSV AND EXCEL PATH.
 *
 * The option used to exist on the Quicken dialog alone, which quietly made
 * it a property of one file format rather than of the import. It is now on
 * all three, keyed on one rule:
 *
 *     A coin counts as sold when it has a sold date, a sold price or a
 *     buyer.
 *
 * These run the rule END TO END -- through `mapRowToCoin`, which is what
 * turns a spreadsheet cell into the field the rule reads -- rather than
 * over hand-built CoinRecords. That is the point: a cell holding `0`, or a
 * cell holding one space, has to survive the mapping as the thing the rule
 * expects, and a unit test on the predicate alone cannot say whether it
 * does. The predicate's own edge cases are in services/import-sold.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { CsvService } from '../csv.service';
import { planImport } from './import-plan';

const csv = new CsvService();
const mapRow = (row: string[], headers: string[], mapping: Record<string, string>) =>
  csv.mapRowToCoin(row, headers, mapping);

/** One sheet, auto-mapped, planned with or without the sold filter. */
function plan(headers: string[], rows: string[][], excludeSold: boolean) {
  const mapping = csv.autoMapHeaders(headers);
  return planImport([{ headers, rows }], mapping, mapRow, { excludeSold });
}

describe('the sold filter on a spreadsheet', () => {
  const headers = ['Coin Type', 'Denomination', 'Year', 'Sold Date', 'Sold Price', 'Sold To'];

  it('is OFF by default, so everything comes in', () => {
    const mapping = csv.autoMapHeaders(headers);
    const result = planImport(
      [{ headers, rows: [['Morgan Dollar', 'Dollar', '1881', '2013-11-16', '400', 'Tollgate']] }],
      mapping,
      mapRow
    );

    expect(result.acceptedCount).toBe(1);
    expect(result.excludedAsSold).toBe(0);
  });

  it('leaves out a row with a sold date', () => {
    const result = plan(
      headers,
      [
        ['Morgan Dollar', 'Dollar', '1881', '2013-11-16', '', ''],
        ['Walking Liberty', 'Half Dollar', '1943', '', '', '']
      ],
      true
    );

    expect(result.acceptedCount).toBe(1);
    expect(result.accepted[0].coinType).toBe('Walking Liberty');
    expect(result.excludedAsSold).toBe(1);
  });

  it('leaves out a row with only a sold price', () => {
    const result = plan(headers, [['Morgan Dollar', 'Dollar', '1881', '', '400', '']], true);

    expect(result.acceptedCount).toBe(0);
    expect(result.excludedAsSold).toBe(1);
  });

  it('leaves out a row with only a buyer', () => {
    // The owner may remember who took it and nothing else.
    const result = plan(
      headers,
      [['Morgan Dollar', 'Dollar', '1881', '', '', 'Tollgate Rarities']],
      true
    );

    expect(result.acceptedCount).toBe(0);
    expect(result.excludedAsSold).toBe(1);
  });

  /* ---- THE TWO THAT FAIL ON A REAL SHEET ---- */

  it('TREATS A SOLD PRICE OF 0 AS SOLD', () => {
    // Given away, written off, traded at no cash value. Truthiness reads
    // this as "never sold" and hands the row back in an import the user
    // asked to be free of sold coins.
    const result = plan(headers, [['Morgan Dollar', 'Dollar', '1881', '', '0', '']], true);

    expect(result.excludedAsSold).toBe(1);
    expect(result.acceptedCount).toBe(0);
  });

  it('DOES NOT TREAT A WHITESPACE-ONLY BUYER AS SOLD', () => {
    // One stray space bar would otherwise hide the coin from the import.
    const result = plan(headers, [['Morgan Dollar', 'Dollar', '1881', '', '', '   ']], true);

    expect(result.excludedAsSold).toBe(0);
    expect(result.acceptedCount).toBe(1);
  });

  it('does not treat a whitespace-only sold date as sold', () => {
    const result = plan(headers, [['Morgan Dollar', 'Dollar', '1881', '  ', '', '']], true);

    expect(result.excludedAsSold).toBe(0);
    expect(result.acceptedCount).toBe(1);
  });

  it('changes nothing when the file maps no sold column at all', () => {
    const bare = ['Coin Type', 'Denomination', 'Year'];
    const rows = [['Morgan Dollar', 'Dollar', '1881'], ['Buffalo', 'Nickel', '1937']];

    expect(plan(bare, rows, true).acceptedCount).toBe(2);
    expect(plan(bare, rows, true).excludedAsSold).toBe(0);
  });

  it('counts the exclusions per sheet, because that is where the user looks', () => {
    const mapping = csv.autoMapHeaders(headers);
    const result = planImport(
      [
        {
          sheetName: 'Kept',
          headers,
          rows: [['Morgan Dollar', 'Dollar', '1881', '', '', '']]
        },
        {
          sheetName: 'Gone',
          headers,
          rows: [
            ['Buffalo', 'Nickel', '1937', '2013-11-16', '', ''],
            ['Barber', 'Dime', '1908', '', '0', '']
          ]
        }
      ],
      mapping,
      mapRow,
      { excludeSold: true }
    );

    expect(result.perSheet).toEqual([
      { sheetName: 'Kept', accepted: 1, rejected: 0, linkedDenominations: 0, excludedAsSold: 0 },
      { sheetName: 'Gone', accepted: 0, rejected: 0, linkedDenominations: 0, excludedAsSold: 2 }
    ]);
    expect(result.excludedAsSold).toBe(2);
  });

  it('does not report an excluded sale as a row that lacked detail', () => {
    /* A row the user asked not to import is not an exception he can act
     * on. Listing "no Denomination" for a coin he sold in 2013 and
     * deliberately filtered out would be noise in the one list that is
     * supposed to be actionable. */
    const result = plan(headers, [['', '', '', '2013-11-16', '', '']], true);

    expect(result.rejected).toEqual([]);
    expect(result.excludedAsSold).toBe(1);
  });
});

describe('Sold To is a column a spreadsheet can actually map', () => {
  it('auto-maps from its own label', () => {
    expect(csv.autoMapHeaders(['Sold To'])['Sold To']).toBe('soldTo');
  });

  it('auto-maps from "Buyer", which is what people write', () => {
    expect(csv.autoMapHeaders(['Buyer'])['Buyer']).toBe('soldTo');
  });

  it('carries the value onto the record', () => {
    const headers = ['Coin Type', 'Denomination', 'Sold To'];
    const mapping = csv.autoMapHeaders(headers);
    const coin = csv.mapRowToCoin(['Morgan Dollar', 'Dollar', 'Tollgate Rarities'], headers, mapping);

    expect(coin.soldTo).toBe('Tollgate Rarities');
  });
});
