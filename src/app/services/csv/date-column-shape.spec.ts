/**
 * Tests for classifying a date-ish column by its values (see date-column-shape.ts).
 * `coin-year` is a claim and any doubt must avoid it; a blank dropdown costs
 * the user a click, a wrong mapping corrupts the import.
 */
import { describe, expect, it } from 'vitest';
import {
  COIN_YEAR_MAJORITY,
  COLUMN_SAMPLE_SIZE,
  COLUMN_SCAN_ROWS,
  classifyCellValue,
  classifyColumnValues,
  mergeColumnSamples,
  sampleColumnCells,
  shapeOfColumn,
  textColumnSamples
} from './date-column-shape';

/** A plain text cell, the only kind a CSV produces. */
function text(value: string) {
  return { text: value };
}

describe('classifyCellValue — one cell at a time', () => {
  it('reads a bare four-digit year as a coin year', () => {
    expect(classifyCellValue(text('1881'))).toBe('coin-year');
    expect(classifyCellValue(text('1873'))).toBe('coin-year');
    expect(classifyCellValue(text(' 1922 '))).toBe('coin-year');
  });

  it('reads a mint-marked coin date as a coin year', () => {
    // `1909-S` is a year with a mint mark, not a hyphenated date.
    expect(classifyCellValue(text('1909-S'))).toBe('coin-year');
    expect(classifyCellValue(text('1883-CC'))).toBe('coin-year');
    expect(classifyCellValue(text('1922 D'))).toBe('coin-year');
  });

  it('reads a year RANGE as a coin year', () => {
    // A type's span is a valid coin year (CoinRecord.year is a string).
    expect(classifyCellValue(text('1916-1945'))).toBe('coin-year');
    expect(classifyCellValue(text('1916–1945'))).toBe('coin-year');
    expect(classifyCellValue(text('1916-45'))).toBe('coin-year');
    expect(classifyCellValue(text('1800 - 1899'))).toBe('coin-year');
  });

  it('reads ancient and BC dates as coin years', () => {
    expect(classifyCellValue(text('476'))).toBe('coin-year');
    expect(classifyCellValue(text('-480'))).toBe('coin-year');
    expect(classifyCellValue(text('44 BC'))).toBe('coin-year');
    expect(classifyCellValue(text('44 B.C.'))).toBe('coin-year');
    expect(classifyCellValue(text('AD 117'))).toBe('coin-year');
    expect(classifyCellValue(text('117 CE'))).toBe('coin-year');
    expect(classifyCellValue(text('330 BCE'))).toBe('coin-year');
  });

  it('reads the hedges collectors write next to an uncertain date', () => {
    expect(classifyCellValue(text('c. 1880'))).toBe('coin-year');
    expect(classifyCellValue(text('ca 1880'))).toBe('coin-year');
    expect(classifyCellValue(text('circa 1880'))).toBe('coin-year');
    expect(classifyCellValue(text('1880s'))).toBe('coin-year');
    expect(classifyCellValue(text('1881?'))).toBe('coin-year');
  });

  it('reads MM/DD/YYYY as a full date, not a year', () => {
    expect(classifyCellValue(text('3/15/2024'))).toBe('full-date');
    expect(classifyCellValue(text('03/15/2024'))).toBe('full-date');
    expect(classifyCellValue(text('12/31/99'))).toBe('full-date');
  });

  it('reads YYYY-MM-DD as a full date even though it STARTS with four digits', () => {
    // Must not be read as a year by looking at the first four characters.
    expect(classifyCellValue(text('2024-03-15'))).toBe('full-date');
    expect(classifyCellValue(text('1881-01-01'))).toBe('full-date');
    expect(classifyCellValue(text('2024/03/15'))).toBe('full-date');
    expect(classifyCellValue(text('2024-03-15T00:00:00Z'))).toBe('full-date');
  });

  it('reads the other separators and orders people actually type', () => {
    expect(classifyCellValue(text('15.03.2024'))).toBe('full-date');
    expect(classifyCellValue(text('15/03/2024'))).toBe('full-date');
    expect(classifyCellValue(text('Mar 15, 2024'))).toBe('full-date');
    expect(classifyCellValue(text('15 March 2024'))).toBe('full-date');
    expect(classifyCellValue(text('March 2024'))).toBe('full-date');
  });

  it('reads a year-and-month pair as a full date rather than a range', () => {
    // `2024-03` can't be a span (it runs backwards), so it is a calendar value.
    expect(classifyCellValue(text('2024-03'))).toBe('full-date');
    expect(classifyCellValue(text('1999-01'))).toBe('full-date');
    expect(classifyCellValue(text('3/15'))).toBe('full-date');
  });

  it('trusts the spreadsheet when the cell itself is typed as a date', () => {
    // A cell typed as a date is a full date, whatever its text looks like.
    expect(classifyCellValue({ text: '1881-01-01', typedDate: true })).toBe('full-date');
    expect(classifyCellValue({ text: '1881', typedDate: true })).toBe('full-date');
  });

  it('refuses to call an unrecognisable cell a year', () => {
    expect(classifyCellValue(text('unknown'))).toBe('other');
    expect(classifyCellValue(text('n/a'))).toBe('other');
    // A raw serial (number format lost) can't be told from a quantity.
    expect(classifyCellValue(text('45678'))).toBe('other');
    expect(classifyCellValue(text('Morgan Dollar'))).toBe('other');
  });

  it('refuses a four-digit number that is not a plausible coin year', () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(classifyCellValue(text(String(nextYear)))).toBe('coin-year');
    expect(classifyCellValue(text(String(nextYear + 50)))).toBe('other');
    expect(classifyCellValue(text('0'))).toBe('other');
  });

  it('reports a blank cell as blank rather than guessing', () => {
    expect(classifyCellValue(text(''))).toBe('blank');
    expect(classifyCellValue(text('   '))).toBe('blank');
  });
});

describe('classifyColumnValues — the whole column', () => {
  it('calls a column of bare years a coin-year column', () => {
    expect(classifyColumnValues(['1881', '1909-S', '1873'].map(text))).toBe('coin-year');
  });

  it('calls a column of full dates a full-date column', () => {
    expect(classifyColumnValues(['3/15/2024', '2024-03-15', '1/2/2020'].map(text)))
      .toBe('full-date');
  });

  it('refuses a column that mixes years and full dates', () => {
    // No principled choice; hand it back to the user.
    expect(classifyColumnValues(['1881', '3/15/2024', '1909'].map(text))).toBe('mixed');
  });

  it('tolerates a little junk among the years but not a single real date', () => {
    const withJunk = ['1881', '1882', '1883', '1884', 'unknown'].map(text);
    expect(withJunk.filter(c => c.text !== 'unknown').length / withJunk.length)
      .toBeGreaterThanOrEqual(COIN_YEAR_MAJORITY);
    expect(classifyColumnValues(withJunk)).toBe('coin-year');

    const withOneDate = [
      '1881', '1882', '1883', '1884', '1885',
      '1886', '1887', '1888', '1889', '3/15/2024'
    ].map(text);
    expect(classifyColumnValues(withOneDate)).toBe('mixed');
  });

  it('says so when there is no evidence at all', () => {
    expect(classifyColumnValues([])).toBe('no-evidence');
    expect(classifyColumnValues(['', '   ', ''].map(text))).toBe('no-evidence');
  });

  it('judges a mostly-blank column on the few values it does have', () => {
    expect(classifyColumnValues(['', '', '1881', '', '1909-S'].map(text))).toBe('coin-year');
    expect(classifyColumnValues(['', '', '3/15/2024', ''].map(text))).toBe('full-date');
  });

  it('lets one typed date cell veto a column that otherwise reads as years', () => {
    // The text `1883` reads as a year; only the type says otherwise, so this
    // fails if the type stops being consulted.
    expect(classifyColumnValues([
      { text: '1881' },
      { text: '1882' },
      { text: '1883', typedDate: true }
    ])).toBe('mixed');
  });
});

describe('sampleColumnCells — how much of the column is read', () => {
  it('skips leading blanks instead of giving up on the column', () => {
    // Leading blank or heading rows must not leave the column unclassified.
    const column = [text(''), text(''), text('1881'), text('1909-S')];
    expect(sampleColumnCells(column).map(cell => cell.text)).toEqual(['1881', '1909-S']);
  });

  it('stops once it has enough non-blank values to decide', () => {
    const column = Array.from({ length: 500 }, () => text('1881'));
    expect(sampleColumnCells(column)).toHaveLength(COLUMN_SAMPLE_SIZE);
  });

  it('gives up scanning after a bounded number of rows', () => {
    // Scanning is bounded, so a mostly blank column doesn't cost a full scan.
    const column = [
      ...Array.from({ length: COLUMN_SCAN_ROWS + 10 }, () => text('')),
      text('1881')
    ];
    expect(sampleColumnCells(column)).toEqual([]);
  });

  it('shapeOfColumn samples and classifies in one step', () => {
    const column = [text(''), text('1881'), text('1909-S')];
    expect(shapeOfColumn(column)).toBe('coin-year');
  });
});

describe('textColumnSamples — evidence from plain text rows', () => {
  it('keys the samples by header text, as the mapping is keyed', () => {
    const samples = textColumnSamples(
      ['Coin Type', 'Date'],
      [['Morgan Dollar', '1881'], ['Peace Dollar', '1922']]
    );

    expect(samples['Date'].map(cell => cell.text)).toEqual(['1881', '1922']);
    expect(samples['Coin Type'].map(cell => cell.text))
      .toEqual(['Morgan Dollar', 'Peace Dollar']);
  });

  it('marks nothing as a typed date, because CSV has no types', () => {
    const samples = textColumnSamples(['Date'], [['2024-03-15']]);
    expect(samples['Date'][0].typedDate).toBeFalsy();
    expect(shapeOfColumn(samples['Date'])).toBe('full-date');
  });

  it('survives rows shorter than the header row', () => {
    const samples = textColumnSamples(['Coin Type', 'Date'], [['Morgan Dollar']]);
    expect(samples['Date']).toEqual([]);
  });
});

describe('mergeColumnSamples — one mapping, several worksheets', () => {
  it('pools the samples for a header that appears on more than one sheet', () => {
    const merged = mergeColumnSamples([
      { 'Date': [{ text: '1881' }] },
      { 'Date': [{ text: '3/15/2024' }], 'Cost': [{ text: '1250' }] }
    ]);

    expect(merged['Date'].map(cell => cell.text)).toEqual(['1881', '3/15/2024']);
    expect(merged['Cost'].map(cell => cell.text)).toEqual(['1250']);
    // Pooled across tabs, the column is mixed.
    expect(classifyColumnValues(merged['Date'])).toBe('mixed');
  });

  it('keeps the pooled sample bounded however many sheets are ticked', () => {
    const sets = Array.from({ length: 30 }, () => ({
      'Date': Array.from({ length: 10 }, () => ({ text: '1881' }))
    }));
    expect(mergeColumnSamples(sets)['Date']).toHaveLength(COLUMN_SAMPLE_SIZE);
  });

  it('returns an empty record for no sources at all', () => {
    expect(mergeColumnSamples([])).toEqual({});
  });
});
