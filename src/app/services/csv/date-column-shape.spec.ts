/**
 * Tests for value-aware classification of a date-ish column.
 *
 * `header-synonyms.ts` maps a column headed `Date` onto `year`, on the
 * numismatic reading that a coin's "date" is the date it was struck. The
 * heading cannot tell that from a calendar date; the VALUES can, and these
 * tests fix exactly how they are read. See date-column-shape.ts for why.
 *
 * THE ASYMMETRY THAT SHAPES EVERY ASSERTION
 *
 * `coin-year` is a claim; anything else is a shrug. A shrug leaves the
 * dropdown blank and costs the user two seconds. A wrong claim costs the
 * whole import. So every "is this a coin year?" test below is really asking
 * "is there any way this could be a calendar date?", and when the answer is
 * yes the verdict must not be `coin-year`.
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

/** Shorthand: a plain text cell, the only kind a CSV can produce. */
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
    // `1909-S` is how a collector writes the San Francisco cent. It looks
    // like a hyphenated date and is not one.
    expect(classifyCellValue(text('1909-S'))).toBe('coin-year');
    expect(classifyCellValue(text('1883-CC'))).toBe('coin-year');
    expect(classifyCellValue(text('1922 D'))).toBe('coin-year');
  });

  it('reads a year RANGE as a coin year', () => {
    // CoinRecord.year is a string precisely so a type can carry its span.
    // A rule that called `1916-1945` "not a year" would be wrong.
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
    // The trap. Truncating to the first four characters, or testing
    // /^\d{4}/, turns every ISO purchase date in the file into a coin year.
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
    // `2024-03` cannot be a span -- it would have to run backwards -- so it
    // is a calendar value with the day left off.
    expect(classifyCellValue(text('2024-03'))).toBe('full-date');
    expect(classifyCellValue(text('1999-01'))).toBe('full-date');
    expect(classifyCellValue(text('3/15'))).toBe('full-date');
  });

  it('trusts the spreadsheet when the cell itself is typed as a date', () => {
    // The free, strongest signal: `read-excel-file` only hands back a `Date`
    // for a cell carrying a date NUMBER FORMAT, and such a cell is always a
    // full date. Whatever the text rendering happens to look like, the type
    // wins -- including for a date that falls on 1 January, whose rendering
    // is the most year-like a full date can get.
    expect(classifyCellValue({ text: '1881-01-01', typedDate: true })).toBe('full-date');
    expect(classifyCellValue({ text: '1881', typedDate: true })).toBe('full-date');
  });

  it('refuses to call an unrecognisable cell a year', () => {
    expect(classifyCellValue(text('unknown'))).toBe('other');
    expect(classifyCellValue(text('n/a'))).toBe('other');
    // A date cell whose number format was lost: the raw serial. We cannot
    // tell it from a quantity, so we must not call it a year.
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
    // Nothing principled to pick here, and picking wrong puts calendar dates
    // into Year for part of the file. Hand it back to the user.
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
    // The typed cell's TEXT is `1883`, which on its own reads as a perfectly
    // good coin year. Only the type says otherwise, so this assertion goes
    // red the moment the type stops being consulted -- which is the point of
    // writing it this way rather than with a date-looking rendering that the
    // pattern would have caught anyway.
    expect(classifyColumnValues([
      { text: '1881' },
      { text: '1882' },
      { text: '1883', typedDate: true }
    ])).toBe('mixed');
  });
});

describe('sampleColumnCells — how much of the column is read', () => {
  it('skips leading blanks instead of giving up on the column', () => {
    // A collector's sheet routinely opens with a spacer row, or a first row
    // that is a group heading. Sampling "the first few rows" verbatim reads
    // nothing and classifies the column as unknown.
    const column = [text(''), text(''), text('1881'), text('1909-S')];
    expect(sampleColumnCells(column).map(cell => cell.text)).toEqual(['1881', '1909-S']);
  });

  it('stops once it has enough non-blank values to decide', () => {
    const column = Array.from({ length: 500 }, () => text('1881'));
    expect(sampleColumnCells(column)).toHaveLength(COLUMN_SAMPLE_SIZE);
  });

  it('gives up scanning after a bounded number of rows', () => {
    // A column that is blank for thousands of rows must not cost a full scan
    // of a 50,000-row export every time the mapping grid is drawn.
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
    // Pooled, the column is a mix, which is exactly the verdict a user
    // needs to see rather than whichever tab happened to be read first.
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
