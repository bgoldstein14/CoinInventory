/**
 * Turning a spreadsheet cell into the text the user sees.
 *
 * WHY THIS IS THE RISKIEST FILE IN THE EXCEL IMPORT
 *
 * The whole `.xlsx` path exists to feed `CsvService.mapRowToCoin`, which
 * takes STRINGS. An `.xlsx` cell is not a string -- it is a typed value plus
 * a display format, and the two can look nothing like each other:
 *
 *   purchase date  cell value 45678,   displayed as 1/21/2025
 *   purchase price cell value 1250,    displayed as $1,250.00
 *   a formula      cell value cached,  displayed as the result
 *
 * Get the date one wrong and every purchase date in the collection becomes
 * the string "45678" -- which is not obviously a date, is not obviously
 * wrong at a glance in a grid, and is unrecoverable once the original
 * spreadsheet has moved on.
 *
 * TIME ZONES ARE THE SECOND TRAP
 *
 * The parser hands back a `Date` built from the serial number at UTC
 * midnight. Reading it back with `getFullYear()`/`getMonth()`/`getDate()` --
 * the obvious thing to write -- applies the machine's local offset, so west
 * of Greenwich every date slips back by one day. The developer machine here
 * runs at UTC-7, so a test written carelessly would pass in London and fail
 * in Denver. Every assertion below is on the UTC calendar date.
 */
import { describe, expect, it } from 'vitest';
import { cellToText } from './workbook-cell-text';

describe('cellToText', () => {
  it('passes a string through, trimmed', () => {
    expect(cellToText('Morgan Dollar')).toBe('Morgan Dollar');
    expect(cellToText('  MS63  ')).toBe('MS63');
  });

  it('turns a blank cell into an empty string', () => {
    expect(cellToText(null)).toBe('');
    expect(cellToText(undefined)).toBe('');
    expect(cellToText('')).toBe('');
  });

  it('renders a number plainly, with no separators and no exponent', () => {
    // `$1,250.00` is a FORMAT. The cell holds 1250, and 1250 is what
    // parseNumericCell needs to see.
    expect(cellToText(1250)).toBe('1250');
    expect(cellToText(1250.5)).toBe('1250.5');
    expect(cellToText(-95.5)).toBe('-95.5');
    expect(cellToText(0)).toBe('0');
    // A year must not pick up a thousands separator on the way through, or
    // "1,881" lands in the Year field.
    expect(cellToText(1881)).toBe('1881');
  });

  it('expands a number JavaScript would otherwise print in exponent form', () => {
    // A cert number typed as a number can be long enough for String() to
    // switch notation, and "1.23456789012345e+22" is not a cert number.
    expect(cellToText(1e21)).not.toContain('e');
    expect(cellToText(1e-7)).not.toContain('e');
  });

  it('drops a non-finite number rather than writing "NaN" into a field', () => {
    expect(cellToText(Number.NaN)).toBe('');
    expect(cellToText(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('renders a date as an ISO calendar date, on the UTC calendar', () => {
    // Serial 45678 is 2025-01-21. The parser returns UTC midnight; reading it
    // with local getters on a UTC-7 machine would give 2025-01-20.
    expect(cellToText(new Date(Date.UTC(2025, 0, 21)))).toBe('2025-01-21');
    expect(cellToText(new Date(Date.UTC(1999, 11, 31)))).toBe('1999-12-31');
  });

  it('keeps the date when the cell also carries a time', () => {
    // A cell formatted as a date-time still means a day as far as a purchase
    // date is concerned, and 12:00 UTC must not round into the next day.
    expect(cellToText(new Date(Date.UTC(2020, 5, 18, 12, 0)))).toBe('2020-06-18');
    expect(cellToText(new Date(Date.UTC(2020, 5, 18, 23, 59)))).toBe('2020-06-18');
  });

  it('refuses an invalid date instead of writing "Invalid Date"', () => {
    expect(cellToText(new Date(Number.NaN))).toBe('');
  });

  it('renders a boolean the way the spreadsheet shows it', () => {
    expect(cellToText(true)).toBe('TRUE');
    expect(cellToText(false)).toBe('FALSE');
  });
});
