/**
 * Tests for cellToText: typed `.xlsx` cells become the strings
 * `CsvService.mapRowToCoin` expects. Dates from the parser are UTC midnight,
 * so all assertions are on the UTC calendar date (local getters would shift a
 * day west of Greenwich).
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
    // `$1,250.00` is a format; the cell holds 1250, which parseNumericCell needs.
    expect(cellToText(1250)).toBe('1250');
    expect(cellToText(1250.5)).toBe('1250.5');
    expect(cellToText(-95.5)).toBe('-95.5');
    expect(cellToText(0)).toBe('0');
    // A year must not get a thousands separator ("1,881").
    expect(cellToText(1881)).toBe('1881');
  });

  it('expands a number JavaScript would otherwise print in exponent form', () => {
    // Long numbers (e.g. cert numbers) must not switch to exponent notation.
    expect(cellToText(1e21)).not.toContain('e');
    expect(cellToText(1e-7)).not.toContain('e');
  });

  it('drops a non-finite number rather than writing "NaN" into a field', () => {
    expect(cellToText(Number.NaN)).toBe('');
    expect(cellToText(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('renders a date as an ISO calendar date, on the UTC calendar', () => {
    // Serial 45678 is 2025-01-21; local getters at UTC-7 would give the 20th.
    expect(cellToText(new Date(Date.UTC(2025, 0, 21)))).toBe('2025-01-21');
    expect(cellToText(new Date(Date.UTC(1999, 11, 31)))).toBe('1999-12-31');
  });

  it('keeps the date when the cell also carries a time', () => {
    // A date-time still means its day; 12:00 UTC must not roll over.
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
