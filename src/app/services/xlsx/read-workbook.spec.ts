/**
 * End-to-end: real `.xlsx` bytes in, header-and-row arrays out.
 *
 * The fixtures here are built by src/app/testing/xlsx-fixture.ts, which emits
 * SpreadsheetML by hand and shares no code with the reader. So a passing test
 * says the reader understands the file format rather than that two halves of
 * one library agree with each other -- and the fixture is readable in a diff,
 * which a committed `.xlsx` would not be.
 *
 * WHAT IS BEING PROVEN
 *
 * The four cell shapes that would each corrupt data silently if mishandled:
 *
 *   SERIAL DATE   a purchase date is stored as the number 45678. Read as a
 *                 number it becomes the string "45678" in the date field --
 *                 not obviously wrong in a grid, and unrecoverable later.
 *   CURRENCY      `$1,250.00` is a FORMAT over the value 1250. Taking the
 *                 formatted text and feeding it to parseNumericCell happens
 *                 to work, but taking the raw number is exact.
 *   FORMULA       the cell holds `=D2*2` and a cached result. Reading the
 *                 formula text would put "D2*2" into Purchase Price.
 *   BLANKS        separator rows, merged headers and formatted-but-empty
 *                 trailing columns, none of which should reach the mapper.
 */
import { describe, expect, it } from 'vitest';
import { buildXlsxWorkbook, buildSimpleXlsx } from '../../testing/xlsx-fixture';
import { readWorkbook } from './read-workbook';

/** fflate returns a view; the reader takes an ArrayBuffer, as a File would. */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('readWorkbook', () => {
  it('reads a plain one-sheet workbook into headers and rows', async () => {
    const sheets = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Denomination', 'Year', 'Grade'],
      [
        ['Morgan Dollar', 'Dollar', 1881, 'MS63'],
        ['Peace Dollar', 'Dollar', '1922-S', 'VF30']
      ]
    )));

    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Silver');
    expect(sheets[0].headers).toEqual(['Coin Type', 'Denomination', 'Year', 'Grade']);
    expect(sheets[0].rows).toEqual([
      ['Morgan Dollar', 'Dollar', '1881', 'MS63'],
      ['Peace Dollar', 'Dollar', '1922-S', 'VF30']
    ]);
  });

  it('reads an Excel serial date as a real date, not as the number 45678', async () => {
    // THE headline case. Serial 45678 is 21 January 2025.
    const sheets = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Purchase Date'],
      [['Morgan Dollar', { dateSerial: 45678 }]]
    )));

    expect(sheets[0].rows[0][1]).toBe('2025-01-21');
  });

  it('reads a currency-formatted cell as its underlying number', async () => {
    const sheets = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Cost', 'Refund'],
      [['Morgan Dollar', { currency: 1250 }, { currency: -95.5 }]]
    )));

    expect(sheets[0].rows[0][1]).toBe('1250');
    expect(sheets[0].rows[0][2]).toBe('-95.5');
  });

  it('reads a formula cell as its cached result, not as the formula text', async () => {
    const sheets = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Doubled', 'Label'],
      [[
        'Morgan Dollar',
        { formula: 'B2*2', cachedNumber: 2500 },
        { formula: 'CONCATENATE(A2," (gem)")', cachedText: 'Morgan Dollar (gem)' }
      ]]
    )));

    expect(sheets[0].rows[0][1]).toBe('2500');
    expect(sheets[0].rows[0][2]).toBe('Morgan Dollar (gem)');
  });

  it('survives a formula with no cached result rather than losing the file', async () => {
    // Files written by tools other than Excel sometimes omit the cached
    // `<v/>`. There is no calculation engine here and there should not be
    // one; the cell is simply blank, and the rest of the row imports.
    const sheets = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Computed'],
      [['Morgan Dollar', { formula: 'B2*2' }]]
    )));

    expect(sheets[0].rows[0][0]).toBe('Morgan Dollar');
    expect(sheets[0].rows[0][1]).toBe('');
  });

  it('drops blank separator rows and empty trailing columns', async () => {
    const sheets = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([{
      name: 'Silver',
      rows: [
        ['Coin Type', 'Year', null, null],
        ['Morgan Dollar', 1881, null, null],
        [],
        [null, null, null, null],
        ['Peace Dollar', 1922, null, null]
      ]
    }])));

    expect(sheets[0].headers).toEqual(['Coin Type', 'Year']);
    expect(sheets[0].rows).toEqual([['Morgan Dollar', '1881'], ['Peace Dollar', '1922']]);
    expect(sheets[0].rowCount).toBe(2);
  });

  it('finds the header row under a merged title banner', async () => {
    const sheets = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([{
      name: 'Inventory',
      rows: [
        ['Hoard of 2019', null, null],
        [],
        ['Coin Type', 'Denomination', 'Year'],
        ['Morgan Dollar', 'Dollar', 1881]
      ],
      merges: ['A1:C1']
    }])));

    expect(sheets[0].headers).toEqual(['Coin Type', 'Denomination', 'Year']);
    expect(sheets[0].rows).toHaveLength(1);
  });

  it('keeps the column a merged header cell left blank', async () => {
    const sheets = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([{
      name: 'Silver',
      rows: [
        ['Coin Type', null, 'Year'],
        ['Morgan Dollar', 'MS63', 1881]
      ],
      merges: ['A1:B1']
    }])));

    expect(sheets[0].headers).toEqual(['Coin Type', '(column B)', 'Year']);
    expect(sheets[0].rows).toEqual([['Morgan Dollar', 'MS63', '1881']]);
  });
});

describe('readWorkbook with several worksheets', () => {
  it('returns every sheet, in workbook order, with its row count', async () => {
    const sheets = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([
      { name: 'Silver', rows: [['Coin Type', 'Year'], ['Morgan Dollar', 1881]] },
      {
        name: 'Gold',
        rows: [['Coin Type', 'Year'], ['Gold Eagle', 1996], ['Saint-Gaudens', 1924]]
      }
    ])));

    expect(sheets.map(sheet => sheet.name)).toEqual(['Silver', 'Gold']);
    expect(sheets.map(sheet => sheet.rowCount)).toEqual([1, 2]);
  });

  it('reads sheets whose columns do not match without complaint', async () => {
    // Detecting the mismatch is sheet-header-comparison.ts's job; the reader
    // must not refuse the file over it.
    const sheets = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([
      { name: 'Silver', rows: [['Coin Type', 'Year'], ['Morgan Dollar', 1881]] },
      { name: 'Gold', rows: [['Coin Type', 'Year', 'AGW'], ['Gold Eagle', 1996, 0.1]] }
    ])));

    expect(sheets[0].headers).toEqual(['Coin Type', 'Year']);
    expect(sheets[1].headers).toEqual(['Coin Type', 'Year', 'AGW']);
  });

  it('marks an empty tab unimportable and keeps the good ones', async () => {
    const sheets = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([
      { name: 'Silver', rows: [['Coin Type', 'Year'], ['Morgan Dollar', 1881]] },
      { name: 'Sheet3', rows: [] }
    ])));

    expect(sheets[0].importable).toBe(true);
    expect(sheets[1].importable).toBe(false);
    expect(sheets[1].skipReason).toBe('This sheet is empty.');
  });
});

describe('readWorkbook on a file that is not a workbook', () => {
  it('reports something a non-technical user can act on', async () => {
    // A `.csv` renamed to `.xlsx`, or an old `.xls`, both land here. The
    // underlying error is about zip central directories, which is useless to
    // the person holding the file.
    const notAWorkbook = new TextEncoder().encode('Coin Type,Year\nMorgan Dollar,1881\n');

    await expect(readWorkbook(asArrayBuffer(notAWorkbook))).rejects.toThrow(
      /could not be read as an Excel workbook/i
    );
  });
});
