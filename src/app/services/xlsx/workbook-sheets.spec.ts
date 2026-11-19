/**
 * Tests for toWorkbookSheets: worksheet grids become the `headers` + `rows`
 * shape the CSV importer uses. Covers title banners, merged header cells,
 * blank separator rows, empty trailing columns, non-inventory tabs and empty
 * tabs. None of these may make the whole workbook fail.
 */
import { describe, expect, it } from 'vitest';
import { toWorkbookSheets } from './workbook-sheets';

describe('toWorkbookSheets', () => {
  it('takes the first row as headers and the rest as data', () => {
    const [sheet] = toWorkbookSheets([
      {
        sheet: 'Silver',
        data: [
          ['Coin Type', 'Year', 'Cost'],
          ['Morgan Dollar', 1881, 1250],
          ['Peace Dollar', '1922-S', 95.5]
        ]
      }
    ]);

    expect(sheet.name).toBe('Silver');
    expect(sheet.headers).toEqual(['Coin Type', 'Year', 'Cost']);
    expect(sheet.rows).toEqual([
      ['Morgan Dollar', '1881', '1250'],
      ['Peace Dollar', '1922-S', '95.5']
    ]);
    expect(sheet.rowCount).toBe(2);
    expect(sheet.importable).toBe(true);
  });

  it('skips a merged title banner and finds the real header row', () => {
    // A merged A1:C1 title is one filled cell then blanks; it isn't the header row.
    const [sheet] = toWorkbookSheets([
      {
        sheet: 'Inventory',
        data: [
          ['My Coin Collection', null, null],
          [null, null, null],
          ['Coin Type', 'Year', 'Cost'],
          ['Morgan Dollar', 1881, 1250]
        ]
      }
    ]);

    expect(sheet.headers).toEqual(['Coin Type', 'Year', 'Cost']);
    expect(sheet.rows).toEqual([['Morgan Dollar', '1881', '1250']]);
  });

  it('names a blank header cell after its column letter instead of dropping it', () => {
    // A merged header leaves its neighbour blank. Dropping the column would shift
    // every cell to its right, so it is kept and named.
    const [sheet] = toWorkbookSheets([
      {
        sheet: 'Gold',
        data: [
          ['Coin Type', null, 'Cost'],
          ['Gold Eagle', 'extra', 395]
        ]
      }
    ]);

    expect(sheet.headers).toEqual(['Coin Type', '(column B)', 'Cost']);
    expect(sheet.rows).toEqual([['Gold Eagle', 'extra', '395']]);
  });

  it('gives two blank header cells different names', () => {
    const [sheet] = toWorkbookSheets([
      { sheet: 'S', data: [['A', null, null, 'D'], ['1', '2', '3', '4']] }
    ]);
    expect(sheet.headers).toEqual(['A', '(column B)', '(column C)', 'D']);
  });

  it('drops blank separator rows', () => {
    const [sheet] = toWorkbookSheets([
      {
        sheet: 'Silver',
        data: [
          ['Coin Type', 'Year'],
          ['Morgan Dollar', 1881],
          [null, null],
          ['', '   '],
          ['Peace Dollar', 1922]
        ]
      }
    ]);

    expect(sheet.rows).toEqual([['Morgan Dollar', '1881'], ['Peace Dollar', '1922']]);
    expect(sheet.rowCount).toBe(2);
  });

  it('drops trailing columns that have no header and no data', () => {
    // Excel may report formatted-but-empty columns; they are dropped.
    const [sheet] = toWorkbookSheets([
      {
        sheet: 'Silver',
        data: [
          ['Coin Type', 'Year', null, null],
          ['Morgan Dollar', 1881, null, null]
        ]
      }
    ]);

    expect(sheet.headers).toEqual(['Coin Type', 'Year']);
    expect(sheet.rows).toEqual([['Morgan Dollar', '1881']]);
  });

  it('keeps an unheaded trailing column that DOES hold data', () => {
    // Data under a blank heading is kept.
    const [sheet] = toWorkbookSheets([
      {
        sheet: 'Silver',
        data: [
          ['Coin Type', 'Year', null],
          ['Morgan Dollar', 1881, 'MS63']
        ]
      }
    ]);

    expect(sheet.headers).toEqual(['Coin Type', 'Year', '(column C)']);
    expect(sheet.rows).toEqual([['Morgan Dollar', '1881', 'MS63']]);
  });

  it('squares off every row, padding short ones and widening for long ones', () => {
    // Rows shorter than the headers must not throw. A longer row widens the sheet
    // (named by column letter) rather than losing data.
    const [sheet] = toWorkbookSheets([
      {
        sheet: 'Silver',
        data: [
          ['Coin Type', 'Year', 'Grade'],
          ['Morgan Dollar'],
          ['Peace Dollar', 1922, 'VF30', 'overflow']
        ]
      }
    ]);

    expect(sheet.headers).toEqual(['Coin Type', 'Year', 'Grade', '(column D)']);
    expect(sheet.rows).toEqual([
      ['Morgan Dollar', '', '', ''],
      ['Peace Dollar', '1922', 'VF30', 'overflow']
    ]);
  });

  it('converts dates, currency and formula results to their displayed text', () => {
    const [sheet] = toWorkbookSheets([
      {
        sheet: 'Silver',
        data: [
          ['Coin Type', 'Purchase Date', 'Cost', 'Doubled'],
          ['Morgan Dollar', new Date(Date.UTC(2025, 0, 21)), 1250, 2500]
        ]
      }
    ]);

    expect(sheet.rows[0]).toEqual(['Morgan Dollar', '2025-01-21', '1250', '2500']);
  });

  it('strips the invisible characters that hide in a header cell', () => {
    const [sheet] = toWorkbookSheets([
      { sheet: 'S', data: [['﻿Coin Type', 'Cert No'], ['Morgan Dollar', '123']] }
    ]);
    expect(sheet.headers).toEqual(['Coin Type', 'Cert No']);
  });
});

describe('sheets that are not inventory', () => {
  it('marks a completely empty sheet unimportable rather than throwing', () => {
    const [sheet] = toWorkbookSheets([{ sheet: 'Sheet3', data: [] }]);

    expect(sheet.name).toBe('Sheet3');
    expect(sheet.importable).toBe(false);
    expect(sheet.skipReason).toBe('This sheet is empty.');
    expect(sheet.headers).toEqual([]);
    expect(sheet.rowCount).toBe(0);
  });

  it('marks a sheet with a header row but no data unimportable', () => {
    const [sheet] = toWorkbookSheets([
      { sheet: 'Template', data: [['Coin Type', 'Year']] }
    ]);

    expect(sheet.importable).toBe(false);
    expect(sheet.skipReason).toBe('This sheet has column headings but no rows under them.');
  });

  it('marks a sheet whose only content is one cell unimportable', () => {
    // A "Notes" tab with a sentence in A1 has no header row (needs two filled cells).
    const [sheet] = toWorkbookSheets([
      { sheet: 'Notes', data: [['Remember to insure the gold'], [null]] }
    ]);

    expect(sheet.importable).toBe(false);
    expect(sheet.skipReason).toBe('No column heading row could be found on this sheet.');
  });

  it('still imports every other sheet when one is junk', () => {
    // One bad tab must not lose the good ones.
    const sheets = toWorkbookSheets([
      { sheet: 'Price Guide', data: [] },
      { sheet: 'Silver', data: [['Coin Type', 'Year'], ['Morgan Dollar', 1881]] }
    ]);

    expect(sheets.map(s => s.name)).toEqual(['Price Guide', 'Silver']);
    expect(sheets[0].importable).toBe(false);
    expect(sheets[1].importable).toBe(true);
    expect(sheets[1].rowCount).toBe(1);
  });

  it('counts how many headings it recognised, so a non-inventory tab shows up', () => {
    // A totals tab recognises nothing but is still listed and tickable.
    const [coins, totals] = toWorkbookSheets([
      {
        sheet: 'Coins',
        data: [['Coin Type', 'Yr', 'Cost'], ['Morgan Dollar', 1881, 1250]]
      },
      {
        sheet: 'Totals',
        data: [['Metric', 'Figure'], ['Count', 412]]
      }
    ]);

    expect(coins.recognisedColumns).toBe(3);
    expect(totals.recognisedColumns).toBe(0);
    expect(totals.importable).toBe(true);
  });
});
