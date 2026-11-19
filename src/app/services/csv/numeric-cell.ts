 /*
  * Parses the CSV import's numeric fields (Purchase Price, Current Value, Sold
  * Price, Weight (g)), ignoring decoration people type around the number:
  *
  *     $1,250.00    -> 1250
  *     0.7734 ozt   -> 0.7734
  *     1/10 oz      -> 0.1
  *     1250 USD     -> 1250
  *     (1,250.00)   -> -1250     (accounting negative)
  *
  * Rules run in order: parentheses, then currency and separators, then
  * fractions (must precede plain extraction, or "1/10" reads as 1), then the
  * first number. An unreadable cell falls back to 0.
  *
  * The Weight column is in grams (server/migrations/008-weight-to-grams.sql), and
  * melt value uses `pmWeightGrams`, not this weight.
  */

/**
 * Currency symbols to discard. An explicit list, so an odd cell fails to parse
 * rather than being mangled into a plausible wrong number.
 */
const CURRENCY_SYMBOLS = /[$£€¥]/g;

/**
 * A simple fraction, optionally followed by anything: "1/10", "1/2 oz", for
 * fractional-ounce bullion weights. The unit is still ignored, so "1/10 oz" in
 * the Weight column imports as 0.1 grams; the CSV guide asks users to write grams.
 */
const SIMPLE_FRACTION = /^(\d+)\s*\/\s*(\d+)/;

/**
 * The first signed decimal number in the remaining text. Unanchored, so units
 * around it ("g", "ozt", "USD") are skipped.
 */
const FIRST_NUMBER = /-?\d*\.?\d+/;

/**
 * Parses a spreadsheet cell into a number, tolerating units and formatting.
 * Returns 0 when no number is recognisable.
 *
 * @param raw the cell text as it came from the CSV
 */
export function parseNumericCell(raw: string): number {
  let text = (raw ?? '').trim();
  if (text.length === 0) return 0;

  // Accounting negatives: "(1,250.00)". Strip the parentheses now, apply the sign at the end.
  const parenthesised = /^\((.*)\)$/.exec(text);
  const isNegative = parenthesised !== null;
  if (parenthesised) text = parenthesised[1];

  // Remove formatting that is never part of the value.
  text = text.replace(CURRENCY_SYMBOLS, '').replace(/,/g, '').trim();

  // Fractions, before anything else looks for digits.
  const fraction = SIMPLE_FRACTION.exec(text);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    // "1/0" is a typo, not infinity.
    if (denominator !== 0 && Number.isFinite(numerator) && Number.isFinite(denominator)) {
      const value = numerator / denominator;
      return isNegative ? -value : value;
    }
    return 0;
  }

  // Otherwise take the first number and ignore any unit.
  const match = FIRST_NUMBER.exec(text);
  if (!match) return 0;

  const value = Number(match[0]);
  if (!Number.isFinite(value)) return 0;

  // Math.abs keeps "(-5)" as -5 rather than flipping it back to 5.
  return isNegative ? -Math.abs(value) : value;
}

/**
 * True when a non-empty cell fell back to 0 in `parseNumericCell`.
 * TODO: not used yet. The importer has no per-cell warning channel, so
 * unreadable cells still become 0 silently; this is the basis for reporting them.
 */
export function isUnreadableNumericCell(raw: string): boolean {
  const text = (raw ?? '').trim();
  if (text.length === 0) return false;
  return parseNumericCell(text) === 0 && !/^[($]*\s*-?0*[.0]*\s*[)%]*$/.test(text);
}
