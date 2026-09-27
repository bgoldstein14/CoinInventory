/* ===========================================================================
 * numeric-cell.ts — turning a spreadsheet cell into a number.
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * CSV import has four numeric fields: Purchase Price, Current Value, Sold
 * Price and Weight (oz). The original one-liner that parsed them was:
 *
 *     Number(value.replace(/[$,]/g, '')) || 0
 *
 * That strips dollar signs and thousands separators, which handles
 * "$1,250.00" correctly. The problem is everything else it does NOT handle,
 * combined with `Number()` being far stricter than most people expect:
 * `Number()` returns NaN unless the ENTIRE string is a valid number, and the
 * `|| 0` then quietly turns that NaN into a zero.
 *
 * So a weight typed the way a collector actually writes it:
 *
 *     0.7734 ozt      ->  NaN  ->  0
 *     0.7734oz        ->  NaN  ->  0
 *     1/10 oz         ->  NaN  ->  0
 *     1250 USD        ->  NaN  ->  0
 *     (1,250.00)      ->  NaN  ->  0      (accounting negative)
 *
 * ...imported as ZERO, with no warning and nothing in the exceptions list.
 * Weight is the field where this bites hardest, because a troy-ounce figure is
 * meaningless without its unit and so people habitually type the unit. A coin
 * whose weight silently becomes 0 also loses its melt value, since melt is
 * computed from weight and purity.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD
 * ---------------------------------------------------------------------------
 * Pull the number out of the cell and ignore the decoration around it. The
 * rules are applied in a deliberate order, because some of them would
 * otherwise mask each other — the fraction check in particular MUST run
 * before plain number extraction, or "1/10 oz" reads as 1 rather than 0.1.
 *
 * This is deliberately forgiving rather than strict. A cell that cannot be
 * read at all still falls back to 0, which is the same behaviour as before —
 * see the note at the bottom about why that fallback is still not good enough
 * and what would fix it properly.
 * =========================================================================== */

/**
 * Currency symbols to discard. Only the symbol is removed, never a digit.
 * Kept as an explicit list rather than a broad "strip non-numeric" sweep so
 * that a genuinely odd cell still fails to parse instead of being mangled into
 * a plausible-looking wrong number.
 */
const CURRENCY_SYMBOLS = /[$£€¥]/g;

/**
 * A simple fraction, optionally followed by anything else: "1/10", "1/2 oz".
 *
 * This exists specifically for bullion weights. Fractional-ounce gold is sold
 * as 1/10, 1/4 and 1/2 oz, and those are exactly the figures someone typing a
 * weight column is likely to write. Without this rule "1/10 oz" parses as 1 —
 * a tenth-ounce coin recorded as a full ounce, a tenfold overstatement of its
 * melt value.
 */
const SIMPLE_FRACTION = /^(\d+)\s*\/\s*(\d+)/;

/**
 * The first signed decimal number anywhere in the remaining text.
 *
 * Anchored nowhere on purpose: by this point currency and separators are gone,
 * so whatever is left around the digits is a unit ("ozt", "grams", "USD") or
 * stray whitespace, and skipping it is the whole point.
 */
const FIRST_NUMBER = /-?\d*\.?\d+/;

/**
 * Parse one spreadsheet cell into a number, tolerating the decoration people
 * actually type around it.
 *
 * Returns 0 for a cell with no recognisable number in it, which matches the
 * previous behaviour and keeps the caller's contract unchanged (the importer
 * builds a fully-populated CoinRecord and has nowhere to report a bad cell).
 *
 * @param raw the cell text exactly as it came out of the CSV
 */
export function parseNumericCell(raw: string): number {
  let text = (raw ?? '').trim();
  if (text.length === 0) return 0;

  // ---- Accounting negatives ------------------------------------------------
  // Spreadsheets render a negative as "(1,250.00)" rather than "-1,250.00",
  // and Excel exports it that way. Detect and remember the parentheses, strip
  // them, and re-apply the sign at the end -- doing it here rather than later
  // means the rest of the rules never have to think about brackets.
  const parenthesised = /^\((.*)\)$/.exec(text);
  const isNegative = parenthesised !== null;
  if (parenthesised) text = parenthesised[1];

  // ---- Remove the formatting that is never part of the value ---------------
  text = text.replace(CURRENCY_SYMBOLS, '').replace(/,/g, '').trim();

  // ---- Fractions, before anything else looks for digits -------------------
  const fraction = SIMPLE_FRACTION.exec(text);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    // Guard the division: "1/0" is a typo, not infinity.
    if (denominator !== 0 && Number.isFinite(numerator) && Number.isFinite(denominator)) {
      const value = numerator / denominator;
      return isNegative ? -value : value;
    }
    return 0;
  }

  // ---- Otherwise take the first number and ignore any unit ----------------
  const match = FIRST_NUMBER.exec(text);
  if (!match) return 0;

  const value = Number(match[0]);
  if (!Number.isFinite(value)) return 0;

  // A leading minus inside the token and surrounding parentheses would cancel
  // out; Math.abs keeps "(-5)" reading as -5 rather than flipping back to 5.
  return isNegative ? -Math.abs(value) : value;
}

/**
 * Whether a cell contains something that looks like a number but could not be
 * read cleanly — i.e. `parseNumericCell` fell back to 0 for a non-empty cell.
 *
 * NOT used by the importer yet, and that is the honest state of things: the
 * importer returns a finished CoinRecord and has no channel for per-cell
 * warnings, so an unreadable cell still becomes 0 silently. This predicate is
 * the piece that a future "these cells could not be read" panel would be built
 * on — the same treatment QIF import gives records that fail the 2-of-3 rule,
 * which exists precisely because silently dropping data is worse than
 * reporting it.
 */
export function isUnreadableNumericCell(raw: string): boolean {
  const text = (raw ?? '').trim();
  if (text.length === 0) return false;
  return parseNumericCell(text) === 0 && !/^[($]*\s*-?0*[.0]*\s*[)%]*$/.test(text);
}
