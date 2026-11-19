/*
 * "Import only coins I still own" on the CSV and Excel path. Runs the rule
 * end to end through `mapRowToCoin`, so cells like `0` or a single space are
 * checked after mapping. The rule's own edge cases are in import-sold.spec.ts.
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
    // Only the buyer is recorded.
    const result = plan(
      headers,
      [['Morgan Dollar', 'Dollar', '1881', '', '', 'Tollgate Rarities']],
      true
    );

    expect(result.acceptedCount).toBe(0);
    expect(result.excludedAsSold).toBe(1);
  });

  it('TREATS A SOLD PRICE OF 0 AS SOLD', () => {
    // A sold price of 0 (given away, written off) counts as sold.
    const result = plan(headers, [['Morgan Dollar', 'Dollar', '1881', '', '0', '']], true);

    expect(result.excludedAsSold).toBe(1);
    expect(result.acceptedCount).toBe(0);
  });

  it('DOES NOT TREAT A WHITESPACE-ONLY BUYER AS SOLD', () => {
    // A single space must not count as a buyer.
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
    // Rows excluded as sold are not listed as exceptions.
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
