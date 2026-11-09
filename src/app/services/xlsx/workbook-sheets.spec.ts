/**
 * Turning parsed worksheet grids into the header-row-plus-data-rows shape the
 * CSV importer already understands.
 *
 * WHY THIS SHAPE AND NOT A NEW ONE
 *
 * The CSV path has a mapping UI, a completeness rule, a preview and an
 * exceptions list, all built on `headers: string[]` + `rows: string[][]`.
 * The Excel work is worth doing only if it converges on that, so everything
 * in this file is in service of producing exactly those two arrays per
 * worksheet. Nothing downstream needs to know the data came from a workbook.
 *
 * WHAT A REAL SPREADSHEET DOES THAT A CSV DOES NOT
 *
 *   - a merged title banner across the top, so row 1 is not the header row
 *   - merged header cells, which leave the neighbouring header BLANK
 *   - blank rows used as visual separators between groups of coins
 *   - trailing columns that were formatted once and never filled in
 *   - a "Notes", "Price Guide" or "Totals" tab that is not inventory at all
 *   - an entirely empty tab left over from the default three-sheet workbook
 *
 * Every one of those has to degrade into something the user can see and
 * correct, never into an exception that loses the other twelve good sheets.
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
    // A merged A1:C1 title arrives as one filled cell followed by blanks.
    // Treating it as the header row would give a one-column sheet called
    // "My Coin Collection" and nothing would map.
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
    // A merged header cell leaves its neighbour empty. Dropping the column
    // would shift every cell to its right one place left -- the worst
    // possible outcome, because the data still looks plausible. Naming it
    // keeps the columns aligned and gives the user something to point at.
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
    // Excel readily reports a sheet as being wider than its content, because
    // somebody once formatted column H. Carrying those through would put
    // four empty dropdowns on the mapping screen.
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
    // The opposite case, and the reason the rule is "header and data", not
    // "header". Data under a blank heading is still the user's data.
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
    // mapRowToCoin walks the header array and indexes into the row, so a row
    // shorter than the headers must not throw.
    //
    // A row LONGER than the heading row widens the sheet rather than being
    // truncated, and that choice is deliberate: truncating would silently
    // discard a column of the user's data, whereas widening surfaces it with
    // a column-letter name they can map or skip. Same rule, same reason, as
    // the unheaded trailing column above.
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
    // A "Notes" tab with a sentence in A1 has no header row by the
    // two-filled-cells rule, so there is nothing to map.
    const [sheet] = toWorkbookSheets([
      { sheet: 'Notes', data: [['Remember to insure the gold'], [null]] }
    ]);

    expect(sheet.importable).toBe(false);
    expect(sheet.skipReason).toBe('No column heading row could be found on this sheet.');
  });

  it('still imports every other sheet when one is junk', () => {
    // The point of the whole exercise: one bad tab must not cost the user
    // the twelve good ones.
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
    // Used to decide which sheets are ticked by default. A tab of totals
    // recognises nothing; it is still listed and still tickable, because a
    // guess about what is inventory is only a guess.
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
