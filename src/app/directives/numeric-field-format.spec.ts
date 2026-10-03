/**
 * Tests for the parse/format pair behind every numeric box in the coin editor.
 *
 * WHAT IS AND IS NOT COVERED HERE
 * The directive that uses these functions (numeric-field.ts) needs a real
 * <input> element — focus, blur, caret — and this suite runs under plain Node
 * with no jsdom, so the directive itself and the template that uses it cannot
 * be unit-tested in this project. Everything that can go wrong *silently* is
 * in these two pure functions, and that is what is pinned down below.
 *
 * THE BUG BEING GUARDED AGAINST
 * The old bindings re-formatted the box on every keystroke, so typing "1" into
 * Price immediately became "$1.00" with the caret parked after the decimals.
 * The fix depends on exactly one thing from this file: `parseNumericInput`
 * must distinguish an EMPTY box (null — the user is mid-clear, leave them
 * alone) from a typed zero (0 — a real value). If that ever collapses to
 * returning 0 for both, a cleared field starts snapping back to "0.00".
 */
import { describe, expect, it } from 'vitest';
import { formatNumericValue, parseNumericInput } from './numeric-field-format';

describe('formatNumericValue', () => {
  it('reproduces the old money display exactly', () => {
    // Was formatMoneyInput(): "$" + toLocaleString with 2 fixed decimals.
    expect(formatNumericValue(1234.56, { decimals: 2, prefix: '$', group: true })).toBe('$1,234.56');
    expect(formatNumericValue(0, { decimals: 2, prefix: '$', group: true })).toBe('$0.00');
    expect(formatNumericValue(1, { decimals: 2, prefix: '$', group: true })).toBe('$1.00');
  });

  it('reproduces the old weight display exactly', () => {
    // Was formatWeightInput(): toFixed(3), no prefix, no grouping.
    expect(formatNumericValue(0.7734, { decimals: 3 })).toBe('0.773');
    expect(formatNumericValue(1, { decimals: 3 })).toBe('1.000');
  });

  it('shows PM weight to five decimal places, including trailing zeros', () => {
    // The whole point of the owner's request: the old type="number" input
    // could not render trailing zeros at all, so 0.1125 showed as "0.1125".
    expect(formatNumericValue(0.1125, { decimals: 5 })).toBe('0.11250');
    expect(formatNumericValue(0, { decimals: 5 })).toBe('0.00000');
    expect(formatNumericValue(31.1035, { decimals: 5 })).toBe('31.10350');
  });

  it('treats a missing value as zero rather than an empty box', () => {
    // Every numeric column on a coin is NOT NULL, so "no value" is 0.
    expect(formatNumericValue(null, { decimals: 2, prefix: '$', group: true })).toBe('$0.00');
    expect(formatNumericValue(undefined, { decimals: 5 })).toBe('0.00000');
  });

  it('never renders NaN or Infinity into the box', () => {
    // This text goes straight into the DOM; "NaN" sitting in a price field is
    // both alarming and un-editable.
    expect(formatNumericValue(Number.NaN, { decimals: 2 })).toBe('0.00');
    expect(formatNumericValue(Number.POSITIVE_INFINITY, { decimals: 2 })).toBe('0.00');
  });

  it('defaults to a plain two-decimal number', () => {
    expect(formatNumericValue(5)).toBe('5.00');
  });
});

describe('parseNumericInput', () => {
  it('returns null for an empty box, NOT zero', () => {
    // THE critical case. The directive relies on null to mean "the user has
    // cleared the field and is about to type", which is what stops the box
    // being rewritten to "0.00" under their cursor.
    expect(parseNumericInput('')).toBeNull();
    expect(parseNumericInput('   ')).toBeNull();
  });

  it('returns 0 for a typed zero, which is a real value', () => {
    expect(parseNumericInput('0')).toBe(0);
    expect(parseNumericInput('$0.00')).toBe(0);
  });

  it('reads a plainly typed number', () => {
    expect(parseNumericInput('1')).toBe(1);
    expect(parseNumericInput('1234.56')).toBe(1234.56);
  });

  it('reads the canonical display back without losing anything', () => {
    // Round trip: whatever we painted on blur must parse to the same number if
    // the user focuses the field again and clicks away without editing.
    const display = formatNumericValue(1234.56, { decimals: 2, prefix: '$', group: true });
    expect(parseNumericInput(display)).toBe(1234.56);

    const grams = formatNumericValue(0.1125, { decimals: 5 });
    expect(parseNumericInput(grams)).toBe(0.1125);
  });

  it('tolerates half-typed intermediate states without blowing up', () => {
    // These are what the box genuinely contains part-way through typing.
    expect(parseNumericInput('1.')).toBe(1);
    expect(parseNumericInput('.5')).toBe(0.5);
    expect(parseNumericInput('-')).toBe(0);
  });

  it('inherits the CSV importer\'s tolerance rather than duplicating it', () => {
    // parseNumericCell is shared with CSV import and is already well tested;
    // these cases only confirm the editor really is going through it.
    expect(parseNumericInput('0.7734 ozt')).toBe(0.7734);
    expect(parseNumericInput('1/10 oz')).toBe(0.1);
    expect(parseNumericInput('(1,250.00)')).toBe(-1250);
  });

  it('never yields NaN or Infinity', () => {
    for (const input of ['abc', '$', '.', '1/0', 'NaN', '1e999']) {
      const result = parseNumericInput(input);
      expect(result === null || Number.isFinite(result), `input ${JSON.stringify(input)}`).toBe(true);
    }
  });
});
