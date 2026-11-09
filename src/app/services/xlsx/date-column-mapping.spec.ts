/**
 * End-to-end: a real `.xlsx` with a `Date` column, through the reader, into
 * the auto-mapping.
 *
 * WHY THIS TEST IS NOT REDUNDANT WITH date-column-shape.spec.ts
 *
 * That spec proves the classifier. This one proves the WIRING, which is
 * where the signal is easiest to lose: `toWorkbookSheets` flattens every
 * cell to a string before anything downstream sees it (that flattening is
 * the entire point of services/xlsx/ -- nothing below the mapping grid is
 * allowed to know a workbook was involved). A `Date` object becomes the text
 * `2024-03-15` and its TYPE is gone. If the samples are built from the
 * flattened text instead of from the parsed cells, this file still passes on
 * the pattern alone and the typed-cell guarantee is silently not there --
 * so the assertions below check `typedDate` explicitly, not just the verdict.
 *
 * The fixtures are built by src/app/testing/xlsx-fixture.ts, which emits
 * SpreadsheetML by hand and shares no code with the reader.
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
    // Serial 45678 is 21 January 2025; 45000 is 4 April 2023. Both carry the
    // built-in m/d/yy number format, so the parser hands back `Date`s.
    const [sheet] = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Date', 'Grade'],
      [
        ['Morgan Dollar', { dateSerial: 45678 }, 'MS63'],
        ['Peace Dollar', { dateSerial: 45000 }, 'VF30']
      ]
    )));

    // The cell TYPE survived the flattening to text. This is the assertion
    // that fails if the samples are rebuilt from `sheet.rows`.
    expect(sheet.valueSamples['Date'].map(cell => cell.typedDate)).toEqual([true, true]);
    expect(mapHeadersToFields(sheet.headers, sheet.valueSamples)['Date']).toBeUndefined();
  });

  it('is left unmapped for a date cell that happens to fall on 1 January', async () => {
    // The hardest case for a text-only rule: serial 29587 is 1 January 1981,
    // which renders as `1981-01-01`. The type says full date regardless.
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
    // Plenty of sheets hold dates as strings. No type to lean on, so the
    // pattern has to carry it.
    const [sheet] = await readWorkbook(asArrayBuffer(buildSimpleXlsx(
      'Silver',
      ['Coin Type', 'Date'],
      [['Morgan Dollar', '3/15/2024'], ['Peace Dollar', '2023-01-02']]
    )));

    expect(sheet.valueSamples['Date'].every(cell => !cell.typedDate)).toBe(true);
    expect(mapHeadersToFields(sheet.headers, sheet.valueSamples)['Date']).toBeUndefined();
  });

  it('does not count an unmappable Date column towards recognisedColumns', async () => {
    // recognisedColumns decides which tabs are ticked by default. A column we
    // have decided not to map is not a column we recognised.
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
    // Sampling "the first two data rows" verbatim reads nothing here and
    // would fall back to the heading, mapping a purchase ledger onto Year.
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
    // One mapping covers all the ticked tabs, so the decision about a `Date`
    // column has to be made on all of their values. A tab whose Date column
    // happens to be empty must not out-vote the tab that shows what it is.
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
