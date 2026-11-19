 /*
  * Formatting for the statistics view. An unknown figure renders as "—", never
  * as "$0.00". Money delegates to `formatMeltValue` (types/inventory-columns.ts)
  * so the grid and statistics show unknown values the same way; this file adds
  * digit grouping for large totals.
  */

import { formatMeltValue } from '../../types/inventory-columns';
import { gramsToTroyOunces } from './precious-metal-holdings';

/** What every helper here prints when the value is unknown. */
const UNKNOWN = formatMeltValue(null);

/**
 * Inserts thousands separators into the integer part of a formatted decimal
 * string only ("0.9674" stays as is). A string transform rather than
 * `toLocaleString`, to match the rest of the app's hard-coded `$` formatting.
 * Exported for testing.
 */
export function groupThousands(text: string): string {
  const dot = text.indexOf('.');
  const head = dot === -1 ? text : text.slice(0, dot);
  const tail = dot === -1 ? '' : text.slice(dot);
  return head.replace(/\B(?=(\d{3})+$)/g, ',') + tail;
}

/** A money total: "$1,234.50" ("-$1,234.50" for negatives), or "—" when unknown. */
export function formatStatMoney(value: number | null): string {
  if (value === null) return UNKNOWN;
  const sign = value < 0 ? '-' : '';
  return sign + groupThousands(formatMeltValue(Math.abs(value)));
}

/**
 * Signed money delta: "+$1,234.50" / "-$1,234.50" / "$0.00" / "—". The explicit
 * sign keeps gain/loss readable without relying on red/green colour.
 */
export function formatStatDelta(value: number | null): string {
  if (value === null) return UNKNOWN;
  return (value > 0 ? '+' : '') + formatStatMoney(value);
}

/** Weight in grams: "12,345.60 g", or "—" when unknown. */
export function formatGrams(grams: number | null): string {
  if (grams === null) return UNKNOWN;
  return `${groupThousands(grams.toFixed(2))} g`;
}

/**
 * Weight in troy ounces: "0.967 ozt", or "—". Three decimals, as the bullion
 * trade quotes (two would round a tenth-ounce coin to "0.10").
 */
export function formatTroyOunces(grams: number | null): string {
  if (grams === null) return UNKNOWN;
  return `${groupThousands(gramsToTroyOunces(grams).toFixed(3))} ozt`;
}

/** A whole count: "1,284". */
export function formatCount(count: number): string {
  return groupThousands(String(Math.round(count)));
}

/** Axis tick label: full under 10,000 ("9,999"), compact above ("10K", "2.4M"). */
export function formatAxisTick(value: number): string {
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);

  if (magnitude >= 1_000_000_000) return sign + compact(magnitude, 1_000_000_000, 'B');
  if (magnitude >= 1_000_000) return sign + compact(magnitude, 1_000_000, 'M');
  if (magnitude >= 10_000) return sign + compact(magnitude, 1_000, 'K');

  // Non-integers keep up to two decimals with trailing zeroes trimmed ("0.5").
  const text = Number.isInteger(magnitude)
    ? String(magnitude)
    : String(Number(magnitude.toPrecision(12)));
  return sign + groupThousands(text);
}

function compact(magnitude: number, divisor: number, suffix: string): string {
  return (magnitude / divisor).toFixed(1).replace(/\.0$/, '') + suffix;
}

/*
 * Axis dates use a fixed month table rather than `toLocaleDateString`: the
 * timestamps are UTC midnight (local getters would show the previous day west
 * of Greenwich), and output must not depend on the machine's locale.
 */
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
] as const;

/** An x-axis tick: "Mar 2024". */
export function formatChartMonth(time: number): string {
  const date = new Date(time);
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** A tooltip or table date: "15 Mar 2024". */
export function formatChartDay(time: number): string {
  const date = new Date(time);
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Coverage sentence such as "Not recorded for 31 of 125 coins", or null when
 * the data is complete (so the note appears only where it matters).
 *
 * @param knownCount records that contributed to the figure
 * @param totalCount records in scope
 * @param noun what the records are ("coins", "gold coins")
 */
export function coverageNote(
  knownCount: number,
  totalCount: number,
  noun = 'coins'
): string | null {
  if (totalCount <= 0) return null;

  const missing = totalCount - knownCount;
  if (missing <= 0) return null;

  if (knownCount === 0) {
    return `Not recorded for any of the ${formatCount(totalCount)} ${noun}`;
  }
  return `Not recorded for ${formatCount(missing)} of ${formatCount(totalCount)} ${noun}`;
}
