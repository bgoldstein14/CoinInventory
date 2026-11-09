 /*
 * stats-format.ts — how a statistic is written down.
 * ---- THE ONE RULE THIS FILE ENFORCES ----
 *     A FIGURE WE DO NOT KNOW RENDERS AS "—", NEVER AS "$0.00".
 *
 * That rule is not new. `formatMeltValue` in types/inventory-columns.ts has
 * enforced it for the melt column since the melt bug was fixed, for exactly
 * the reason set out at the top of services/pm-reference.ts:
 *
 *     A WRONG NUMBER SILENTLY LOOKS LIKE A FACT.
 *     A BLANK IS VISIBLE AND THE USER CAN FIX IT.
 *
 * A statistics panel is where that rule is hardest to keep, because every
 * figure on it is a SUM, and the natural way to write the sum of an empty set
 * is `0`. "Total melt value: $0.00" over a tray of gold eagles whose weights
 * were never typed in is a lie with no tell.
 *
 * ---- WHY THESE DELEGATE TO formatMeltValue INSTEAD OF CALLING toFixed(2) ----
 * There must be exactly ONE place in the app that decides what an unknown
 * money figure looks like, so the statistics view and the inventory grid can
 * never disagree about it, and so a future change of mind (a greyed "n/a",
 * say) changes both at once. `formatMeltValue` is that place and it already
 * existed, so this file borrows it rather than growing a second copy of the
 * decision. The only thing added on top is digit grouping, because a totals
 * panel routinely shows six- and seven-figure sums and "$1234567.89" is
 * unreadable in a way "$30.09" in a grid cell never was.
  */

import { formatMeltValue } from '../../types/inventory-columns';
import { gramsToTroyOunces } from './precious-metal-holdings';

/** What every helper here prints when the answer is not known. */
const UNKNOWN = formatMeltValue(null);

/**
 * Insert thousands separators into the INTEGER part of an already-formatted
 * decimal string — and into nothing else.
 *
 * Deliberately a string transform rather than `toLocaleString`: the rest of
 * the app formats money with a hard-coded `$` and `toFixed(2)` (see
 * `formatInventoryCell`), so switching to locale formatting here would make
 * the statistics view the only screen that renders "1.234,57 €" on a German
 * machine while the grid beside it still said "$1234.57".
 *
 * ---- EXPORTED SO THE FRACTIONAL-PART RULE CAN BE TESTED DIRECTLY ----
 * This started as a private helper, and a mutation run caught the problem:
 * replacing it with the naive one-regex version
 *
 *     text.replace(/(\d)(?=(\d{3})+(\.|$))/g, '$1,')
 *
 * broke NOTHING. Not because the two are equivalent — they are not, the naive
 * one renders "0.9674" as "0.9,674" — but because no caller in the file today
 * formats to four decimals, so the difference was unreachable. An untested
 * guard with a confident comment on it is exactly the thing that gets
 * "simplified" away by the next reader.
 *
 * Exporting it makes the rule assertable on its own terms rather than through
 * whatever precision today's callers happen to use. The export has no other
 * purpose; nothing outside the spec calls it.
 */
export function groupThousands(text: string): string {
  const dot = text.indexOf('.');
  const head = dot === -1 ? text : text.slice(0, dot);
  const tail = dot === -1 ? '' : text.slice(dot);
  return head.replace(/\B(?=(\d{3})+$)/g, ',') + tail;
}

/**
 * A money total: "$1,234.50", or "—" when it is not known.
 *
 * The minus sign goes OUTSIDE the dollar sign ("-$1,234.50"), which is how
 * the rest of the app's gain/loss figures read, rather than "$-1234.50".
 */
export function formatStatMoney(value: number | null): string {
  if (value === null) return UNKNOWN;
  const sign = value < 0 ? '-' : '';
  return sign + groupThousands(formatMeltValue(Math.abs(value)));
}

/**
 * A signed money delta: "+$1,234.50" / "-$1,234.50" / "$0.00" / "—".
 *
 * THE SIGN IS NOT DECORATION. Gain and loss are rendered in the app's green
 * and red, and colour must never be the only channel carrying meaning — a
 * red/green pair is the single most common confusion for the ~8% of men with
 * a colour vision deficiency. The explicit "+"/"-" means the figure reads
 * correctly in greyscale, in print, and under forced-colors.
 */
export function formatStatDelta(value: number | null): string {
  if (value === null) return UNKNOWN;
  return (value > 0 ? '+' : '') + formatStatMoney(value);
}

/** A weight in grams: "12,345.60 g", or "—" when it is not known. */
export function formatGrams(grams: number | null): string {
  if (grams === null) return UNKNOWN;
  return `${groupThousands(grams.toFixed(2))} g`;
}

/**
 * The same weight in troy ounces: "0.967 ozt", or "—".
 *
 * Three decimals because that is the precision the bullion trade quotes
 * (0.9675 ozt AGW for a double eagle), and because two would round a tenth-
 * ounce coin to "0.10".
 */
export function formatTroyOunces(grams: number | null): string {
  if (grams === null) return UNKNOWN;
  return `${groupThousands(gramsToTroyOunces(grams).toFixed(3))} ozt`;
}

/** A whole number of things: "1,284". */
export function formatCount(count: number): string {
  return groupThousands(String(Math.round(count)));
}

/**
 * An axis tick label.
 *
 * Full under 10,000 ("0 / 1,000 / 9,999") and compact at and above it
 * ("10K / 12.5K / 2.4M"), one style per axis. Axis ticks are what carry the
 * values that are NOT directly labelled, so they have to stay short enough to
 * sit side by side without colliding.
 */
export function formatAxisTick(value: number): string {
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);

  if (magnitude >= 1_000_000_000) return sign + compact(magnitude, 1_000_000_000, 'B');
  if (magnitude >= 1_000_000) return sign + compact(magnitude, 1_000_000, 'M');
  if (magnitude >= 10_000) return sign + compact(magnitude, 1_000, 'K');

  // Under ten thousand, in full. Non-integers (a cents-scale axis) keep up to
  // two decimals; trailing zeroes are trimmed so a tick reads "0.5", not
  // "0.50", which would imply a precision the scale does not have.
  const text = Number.isInteger(magnitude)
    ? String(magnitude)
    : String(Number(magnitude.toPrecision(12)));
  return sign + groupThousands(text);
}

function compact(magnitude: number, divisor: number, suffix: string): string {
  return (magnitude / divisor).toFixed(1).replace(/\.0$/, '') + suffix;
}

/* ---------------------------------------------------------------------------
 * AXIS DATES
 * ---------------------------------------------------------------------------
 * Hand-rolled from a fixed month table rather than `toLocaleDateString`, for
 * two reasons:
 *
 *   1. THE TIMESTAMPS ARE UTC. spend-over-time.ts builds them with `Date.UTC`
 *      from a bare "YYYY-MM-DD" with no time of day in it. Reading those back
 *      with LOCAL getters shows the previous day to every collector west of
 *      Greenwich — an off-by-one on every point of the chart, invisible to
 *      whoever built it.
 *
 *   2. THE TESTS. A locale-dependent string is a test that passes on the
 *      developer's machine and fails in CI, and the suite here runs under
 *      plain Node where the ICU locale is whatever the box happens to have.
 * ------------------------------------------------------------------------- */
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
 * The sentence that replaces a silent zero: "Not recorded for 31 of 125 coins".
 *
 * ---- THIS IS THE WHOLE POINT OF THE STATISTICS VIEW ----
 * Several of the fields these statistics are built on — `weight`,
 * `pmWeightGrams`, `soldPrice`, `purchaseDate` — are optional and frequently
 * blank in a real collection. Every total computed from them is therefore a
 * total over a SUBSET, and a figure presented without saying which subset is
 * a figure the reader will take for the whole.
 *
 * Returns `null`, meaning "say nothing", when the data is complete — a note
 * printed under every single statistic becomes wallpaper and stops being
 * read, which would defeat the purpose on the one statistic that needs it.
 *
 * @param knownCount how many records contributed to the figure
 * @param totalCount how many records were in scope
 * @param noun what the records are, for the sentence ("coins", "gold coins")
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
