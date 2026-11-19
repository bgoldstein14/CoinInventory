/*
 * Pure parse/format helpers for the numeric-field directive, kept free of
 * Angular and the DOM so they can be unit tested under Node.
 */

import { parseNumericCell } from '../services/csv/numeric-cell';

/** How a numeric field is displayed when not focused. Parsing is shared with CSV import. */
export interface NumericFieldFormat {
  /** Digits after the decimal point in the canonical display, e.g. 2 for money. */
  decimals: number;
  /** Literal text placed in front of the number, e.g. "$". Never parsed back. */
  prefix: string;
  /** Insert thousands separators ("1,250.00")? Money yes, weights no. */
  group: boolean;
}

/** A plain two-decimal number. */
export const DEFAULT_NUMERIC_FIELD_FORMAT: NumericFieldFormat = {
  decimals: 2,
  prefix: '',
  group: false
};

/**
 * Format a stored number for display (used on load and on blur).
 * null/undefined/NaN show as zero: these columns are NOT NULL numbers.
 */
export function formatNumericValue(
  value: number | null | undefined,
  format: Partial<NumericFieldFormat> = {}
): string {
  const { decimals, prefix, group } = { ...DEFAULT_NUMERIC_FIELD_FORMAT, ...format };

  const numeric = Number(value ?? 0);
  const safe = Number.isFinite(numeric) ? numeric : 0;

  const body = group
    ? safe.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      })
    : safe.toFixed(decimals);

  return `${prefix}${body}`;
}

/**
 * Parse the box's current text. Returns `null` (not 0) for an empty box so a
 * cleared field isn't mistaken for a deliberate zero. Accepts everything CSV
 * import does ("$1,250", "0.7734 ozt", "1/10 oz").
 */
export function parseNumericInput(text: string): number | null {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return null;
  return parseNumericCell(trimmed);
}
