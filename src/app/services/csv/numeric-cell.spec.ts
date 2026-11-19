/**
 * Tests for parseNumericCell. Values with units or fractions ("0.7734 ozt",
 * "1/10 oz") must parse to their number, not fall back to 0.
 */
import { describe, expect, it } from 'vitest';
import { isUnreadableNumericCell, parseNumericCell } from './numeric-cell';

describe('parseNumericCell', () => {
  it('reads a plain number', () => {
    expect(parseNumericCell('1400')).toBe(1400);
    expect(parseNumericCell('0.7734')).toBe(0.7734);
  });

  it('reads currency formatting, which is the case that always worked', () => {
    expect(parseNumericCell('$1,250.00')).toBe(1250);
    expect(parseNumericCell('1,250')).toBe(1250);
    expect(parseNumericCell('£95.50')).toBe(95.5);
  });

  it('reads a weight that carries its unit', () => {
    // Units after the number are ignored.
    expect(parseNumericCell('0.7734 ozt')).toBe(0.7734);
    expect(parseNumericCell('0.7734oz')).toBe(0.7734);
    expect(parseNumericCell('1 oz')).toBe(1);
    expect(parseNumericCell('31.1 grams')).toBe(31.1);
  });

  it('reads a fractional-ounce weight', () => {
    // Fractional bullion weights (1/10, 1/4, 1/2 oz) are ordinary values; without
    // the fraction rule "1/10 oz" would read as 1.
    expect(parseNumericCell('1/10 oz')).toBe(0.1);
    expect(parseNumericCell('1/4 oz')).toBe(0.25);
    expect(parseNumericCell('1/2')).toBe(0.5);
  });

  it('reads a value followed by a currency word', () => {
    expect(parseNumericCell('1250 USD')).toBe(1250);
  });

  it('reads the parenthesised negative spreadsheets export', () => {
    // Excel renders a negative as (1,250.00).
    expect(parseNumericCell('(1,250.00)')).toBe(-1250);
    expect(parseNumericCell('($95.50)')).toBe(-95.5);
  });

  it('does not let a bracket and a minus sign cancel each other out', () => {
    // "(-5)" is still negative five.
    expect(parseNumericCell('(-5)')).toBe(-5);
  });

  it('reads an explicit negative', () => {
    expect(parseNumericCell('-42.5')).toBe(-42.5);
  });

  it('falls back to 0 for a cell with no number in it', () => {
    // The importer builds a complete CoinRecord and can't report a bad cell.
    expect(parseNumericCell('n/a')).toBe(0);
    expect(parseNumericCell('unknown')).toBe(0);
    expect(parseNumericCell('')).toBe(0);
    expect(parseNumericCell('   ')).toBe(0);
  });

  it('treats a zero denominator as a typo rather than infinity', () => {
    expect(parseNumericCell('1/0')).toBe(0);
    expect(Number.isFinite(parseNumericCell('1/0'))).toBe(true);
  });

  it('reads a genuine zero as zero', () => {
    expect(parseNumericCell('0')).toBe(0);
    expect(parseNumericCell('$0.00')).toBe(0);
  });

  it('never returns NaN or Infinity, whatever it is handed', () => {
    // The value is written to a CoinRecord and SQL, so it must always be finite.
    for (const input of ['', 'abc', '$', '-', '.', '1/0', '()', 'e5', 'NaN', '1e999']) {
      const result = parseNumericCell(input);
      expect(Number.isFinite(result), `input ${JSON.stringify(input)}`).toBe(true);
    }
  });
});

describe('isUnreadableNumericCell', () => {
  it('is false for an empty cell, which is simply absent data', () => {
    expect(isUnreadableNumericCell('')).toBe(false);
    expect(isUnreadableNumericCell('  ')).toBe(false);
  });

  it('is false for values it can read', () => {
    expect(isUnreadableNumericCell('0.7734 ozt')).toBe(false);
    expect(isUnreadableNumericCell('$1,250.00')).toBe(false);
    expect(isUnreadableNumericCell('1/10 oz')).toBe(false);
  });

  it('is false for a genuine zero, which is a real value not a failure', () => {
    expect(isUnreadableNumericCell('0')).toBe(false);
    expect(isUnreadableNumericCell('$0.00')).toBe(false);
  });

  it('is true for a non-empty cell it had to fall back to 0 for', () => {
    // Not consumed yet; an unreadable cell still becomes 0 (see numeric-cell.ts).
    expect(isUnreadableNumericCell('n/a')).toBe(true);
    expect(isUnreadableNumericCell('ask dealer')).toBe(true);
  });
});
