/* ===========================================================================
 * numeric-field-format.ts — the pure parse/format pair behind a numeric input.
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS (separate from the directive)
 * ---------------------------------------------------------------------------
 * The directive that uses these functions (`numeric-field.ts`) has to talk to a
 * real <input> element, which means it can only be exercised with a DOM. This
 * project's unit tests run under plain Node with no jsdom, so anything that
 * touches an element is untestable here.
 *
 * Keeping the actual arithmetic and string work in this file — no Angular, no
 * DOM, no signals — means the part that can silently corrupt a coin's price or
 * weight IS covered by tests. See numeric-field-format.spec.ts.
 * =========================================================================== */

import { parseNumericCell } from '../services/csv/numeric-cell';

/**
 * How one numeric field is rendered once the user has finished typing.
 *
 * There is deliberately no "how to parse" half of this config: parsing is
 * handled by {@link parseNumericCell}, which is shared with CSV import and is
 * already tolerant of everything a person might type (currency symbols,
 * thousands separators, unit suffixes like "ozt", fractions like "1/10",
 * accounting negatives like "(5.00)"). Duplicating that here would mean two
 * parsers that drift apart.
 */
export interface NumericFieldFormat {
  /** Digits after the decimal point in the canonical display, e.g. 2 for money. */
  decimals: number;
  /** Literal text placed in front of the number, e.g. "$". Never parsed back. */
  prefix: string;
  /** Insert thousands separators ("1,250.00")? Money yes, weights no. */
  group: boolean;
}

/** Sensible defaults: a plain two-decimal number with no decoration. */
export const DEFAULT_NUMERIC_FIELD_FORMAT: NumericFieldFormat = {
  decimals: 2,
  prefix: '',
  group: false
};

/**
 * Render a stored number in its canonical display form.
 *
 * This is what the input shows when it is NOT focused. While it IS focused the
 * directive leaves the user's literal text alone — that is the whole point of
 * the Item 2 fix — so this function is only ever called on load and on blur.
 *
 * A null/undefined/NaN value renders as a formatted zero rather than an empty
 * box, matching what the form did before: every one of these columns is a
 * NOT NULL number in the database, so "no value" genuinely means zero.
 */
export function formatNumericValue(
  value: number | null | undefined,
  format: Partial<NumericFieldFormat> = {}
): string {
  const { decimals, prefix, group } = { ...DEFAULT_NUMERIC_FIELD_FORMAT, ...format };

  const numeric = Number(value ?? 0);
  const safe = Number.isFinite(numeric) ? numeric : 0;

  // `toLocaleString` is what produced the old "$1,234.56"; `toFixed` is what
  // produced the old "1.234" weight. Keeping both means the switch to one
  // shared mechanism does not change how any existing field looks.
  const body = group
    ? safe.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      })
    : safe.toFixed(decimals);

  return `${prefix}${body}`;
}

/**
 * Read whatever the user has typed so far.
 *
 * Returns `null` — NOT 0 — for an empty box. The caller needs to tell those two
 * apart: a half-cleared field ("the user selected all and pressed delete, and
 * is about to type a new number") must not look the same as a deliberate zero,
 * or the box would fight the user by snapping back to "0.00" mid-edit.
 *
 * Everything else is delegated to the CSV importer's parser, so "$1,250",
 * "0.7734 ozt" and "1/10 oz" all behave in the editor exactly as they do on
 * import.
 */
export function parseNumericInput(text: string): number | null {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return null;
  return parseNumericCell(trimmed);
}
