/**
 * Tests for parsing a numeric CSV cell.
 *
 * These pin down a real, silent data-loss bug. The importer used to parse its
 * four numeric columns with:
 *
 *     Number(value.replace(/[$,]/g, '')) || 0
 *
 * `Number()` returns NaN unless the WHOLE string is a number, and `|| 0` then
 * turned that NaN into a zero. So a weight typed the way a collector actually
 * writes it -- "0.7734 ozt" -- imported as 0, with no warning anywhere. Weight
 * feeding melt value made it worse: the coin lost its melt figure too.
 *
 * Every case below that carries a unit or a fraction returned 0 before.
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
    // THE headline regression. All four of these were 0.
    expect(parseNumericCell('0.7734 ozt')).toBe(0.7734);
    expect(parseNumericCell('0.7734oz')).toBe(0.7734);
    expect(parseNumericCell('1 oz')).toBe(1);
    expect(parseNumericCell('31.1 grams')).toBe(31.1);
  });

  it('reads a fractional-ounce weight', () => {
    // Fractional gold is sold as 1/10, 1/4 and 1/2 oz, so these are ordinary
    // values in a weight column -- not edge cases. Note that without the
    // fraction rule "1/10 oz" would read as 1: a tenth-ounce coin recorded as
    // a full ounce, overstating its melt value tenfold.
    expect(parseNumericCell('1/10 oz')).toBe(0.1);
    expect(parseNumericCell('1/4 oz')).toBe(0.25);
    expect(parseNumericCell('1/2')).toBe(0.5);
  });

  it('reads a value followed by a currency word', () => {
    expect(parseNumericCell('1250 USD')).toBe(1250);
  });

  it('reads the parenthesised negative spreadsheets export', () => {
    // Excel renders a negative as (1,250.00) rather than -1,250.00.
    expect(parseNumericCell('(1,250.00)')).toBe(-1250);
    expect(parseNumericCell('($95.50)')).toBe(-95.5);
  });

  it('does not let a bracket and a minus sign cancel each other out', () => {
    // "(-5)" is still negative five, not positive five.
    expect(parseNumericCell('(-5)')).toBe(-5);
  });

  it('reads an explicit negative', () => {
    expect(parseNumericCell('-42.5')).toBe(-42.5);
  });

  it('falls back to 0 for a cell with no number in it', () => {
    // Unchanged from the old behaviour: the importer builds a complete
    // CoinRecord and has no channel for reporting a bad cell.
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
    // The caller writes this straight onto a CoinRecord and then into SQL, so
    // a non-finite value would propagate rather than fail fast.
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
    // This is the signal a future "these cells could not be read" panel would
    // use. Nothing consumes it yet, which is why an unreadable cell still
    // becomes 0 silently -- see the note in numeric-cell.ts.
    expect(isUnreadableNumericCell('n/a')).toBe(true);
    expect(isUnreadableNumericCell('ask dealer')).toBe(true);
  });
});
