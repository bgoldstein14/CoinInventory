/**
 * End-to-end: a real `.xlsx` with a `Date` column, through the reader, into the
 * auto-mapping. Checks that each sample's `typedDate` survives, since
 * `toWorkbookSheets` flattens cells to text and would otherwise lose the type.
 * Fixtures come from src/app/testing/xlsx-fixture.ts, which shares no code with the reader.
 */
import { describe, expect, it } from 'vitest';
import { buildSimpleXlsx, buildXlsxWorkbook } from '../../testing/xlsx-fixture';
import { readWorkbook } from './read-workbook';
import { mapHeadersToFields } from '../csv/header-synonyms';
import { mergeColumnSamples } from '../csv/date-column-shape';

/** fflate returns a view; the reader takes an ArrayBuffer, as a File would. */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('a `Date` column in a real workbook', () => {
  it('maps onto year when the cells hold coin years', async () => {
    const [sheet] = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Date', 'Grade'],
      [
        ['Morgan Dollar', 1881, 'MS63'],
        ['Peace Dollar', '1922-S', 'VF30'],
        ['Seated Dollar', 1873, 'VF20']
      ]
    )));

    expect(sheet.valueSamples['Date'].map(cell => cell.text))
      .toEqual(['1881', '1922-S', '1873']);
    expect(sheet.valueSamples['Date'].every(cell => !cell.typedDate)).toBe(true);
    expect(mapHeadersToFields(sheet.headers, sheet.valueSamples)['Date']).toBe('year');
  });

  it('is left unmapped when the cells are real Excel date cells', async () => {
    // Serial 45678 is 21 Jan 2025 and 45000 is 4 Apr 2023, both with the built-in
    // m/d/yy format, so the parser returns `Date`s.
    const [sheet] = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Date', 'Grade'],
      [
        ['Morgan Dollar', { dateSerial: 45678 }, 'MS63'],
        ['Peace Dollar', { dateSerial: 45000 }, 'VF30']
      ]
    )));

    // The cell type survived flattening; fails if samples are built from `sheet.rows`.
    expect(sheet.valueSamples['Date'].map(cell => cell.typedDate)).toEqual([true, true]);
    expect(mapHeadersToFields(sheet.headers, sheet.valueSamples)['Date']).toBeUndefined();
  });

  it('is left unmapped for a date cell that happens to fall on 1 January', async () => {
    // Serial 29587 is 1 Jan 1981 ("1981-01-01"); the type marks it as a full date.
    const [sheet] = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Date'],
      [['Morgan Dollar', { dateSerial: 29587 }], ['Peace Dollar', { dateSerial: 29588 }]]
    )));

    expect(sheet.rows[0][1]).toBe('1981-01-01');
    expect(sheet.valueSamples['Date'][0].typedDate).toBe(true);
    expect(mapHeadersToFields(sheet.headers, sheet.valueSamples)['Date']).toBeUndefined();
  });

  it('is left unmapped when the dates were typed as text rather than formatted', async () => {
    // Dates stored as strings: no type, so the pattern decides.
    const [sheet] = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Date'],
      [['Morgan Dollar', '3/15/2024'], ['Peace Dollar', '2023-01-02']]
    )));

    expect(sheet.valueSamples['Date'].every(cell => !cell.typedDate)).toBe(true);
    expect(mapHeadersToFields(sheet.headers, sheet.valueSamples)['Date']).toBeUndefined();
  });

  it('does not count an unmappable Date column towards recognisedColumns', async () => {
    // recognisedColumns sets default ticks; an unmapped column isn't "recognised".
    const [years, dates] = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([
      { name: 'Coins', rows: [['Coin Type', 'Date'], ['Morgan Dollar', 1881]] },
      {
        name: 'Ledger',
        rows: [['Coin Type', 'Date'], ['Morgan Dollar', { dateSerial: 45678 }]]
      }
    ])));

    expect(years.recognisedColumns).toBe(2);
    expect(dates.recognisedColumns).toBe(1);
  });

  it('skips the blank spacer rows a collector leaves at the top of a tab', async () => {
    // Sampling the first two data rows verbatim would read nothing here.
    const [sheet] = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([{
      name: 'Silver',
      rows: [
        ['Coin Type', 'Date'],
        [],
        ['Morgan Dollar', null],
        ['Peace Dollar', { dateSerial: 45678 }],
        ['Seated Dollar', { dateSerial: 45000 }]
      ]
    }])));

    expect(sheet.valueSamples['Date'].map(cell => cell.typedDate)).toEqual([true, true]);
    expect(mapHeadersToFields(sheet.headers, sheet.valueSamples)['Date']).toBeUndefined();
  });

  it('keeps Year and hands Date back when a sheet has both', async () => {
    const [sheet] = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Year', 'Date'],
      [
        ['Morgan Dollar', 1881, { dateSerial: 45678 }],
        ['Peace Dollar', 1922, { dateSerial: 45000 }]
      ]
    )));

    const mapping = mapHeadersToFields(sheet.headers, sheet.valueSamples);
    expect(mapping['Year']).toBe('year');
    expect(mapping['Date']).toBeUndefined();
  });

  it('pools the evidence across every selected worksheet', async () => {
    // One mapping covers all ticked tabs, so a tab with an empty Date column must
    // not out-vote the tab that shows what it holds.
    const sheets = await readWorkbook(asArrayBuffer(buildXlsxWorkbook([
      { name: 'Gold', rows: [['Coin Type', 'Date'], ['Saint-Gaudens', null]] },
      {
        name: 'Silver',
        rows: [['Coin Type', 'Date'], ['Morgan Dollar', { dateSerial: 45678 }]]
      }
    ])));

    const pooled = mergeColumnSamples(sheets.map(sheet => sheet.valueSamples));
    expect(mapHeadersToFields(['Coin Type', 'Date'], pooled)['Date']).toBeUndefined();
  });
});
