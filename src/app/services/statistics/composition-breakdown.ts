 /*
  * Groups coins by one dimension (denomination, country, grade, category,
  * metal) and ranks the groups, for the ranked-bar chart.
  *
  * - Coins with a blank field are never a slice; they are reported as
  *   `unlabelledCount` and described in words under the chart.
  * - Categories past the cap fold into one "Other" slice, always drawn last and
  *   counting how many categories it holds. A fold never captures just one category.
  * - A slice's value sums only its appraised coins (`valueUnknownCount` counts
  *   the rest); `value` is null when none were appraised.
  */

import { PickerDenomination } from '../../components/coin-editor-form/denomination-picker';
import { CoinRecord } from '../../types/coin.model';
import { coinDenominationDisplay } from '../../types/inventory-columns';
import { NO_DENOMINATION } from '../denominations/denomination-display';

/** The dimensions a collection can be broken down by. */
export type BreakdownDimension =
  | 'denomination'
  | 'country'
  | 'grade'
  | 'category'
  | 'metal';

export type BreakdownMetric = 'count' | 'value';

/** Label for the folded tail. */
export const OTHER_LABEL = 'Other';

/**
 * Bars drawn before folding. All bars are one hue, so the limit is
 * readability rather than palette size.
 */
export const MAX_SLICES = 10;

export interface BreakdownSlice {
  label: string;
  /** Coins in this slice. */
  count: number;
  /** Current value over the slice's appraised coins; null when none are. */
  value: number | null;
  valueKnownCount: number;
  valueUnknownCount: number;
  /** True for the "Other" slice only. */
  folded: boolean;
  /** Distinct categories folded in; 0 for a named slice. */
  foldedSliceCount: number;
}

export interface Breakdown {
  dimension: BreakdownDimension;
  metric: BreakdownMetric;
  /** Ranked largest-first by `metric`, with "Other" (if any) always last. */
  slices: BreakdownSlice[];
  /** Coins with a value in this field. */
  labelledCount: number;
  /** Coins without one; never drawn as a bar. */
  unlabelledCount: number;
  /** Distinct values in the field, counted before folding. */
  distinctLabelCount: number;
}

/**
 * Raw text of one dimension on a coin; empty or whitespace means "not recorded".
 * Denomination is handled by `bucketLabel`.
 */
function rawValue(coin: CoinRecord, dimension: BreakdownDimension): string {
  switch (dimension) {
    case 'denomination': return coin.denomination;
    case 'country': return coin.country;
    case 'grade': return coin.grade;
    case 'category': return coin.category;
    case 'metal': return coin.metalContent ?? '';
  }
}

/**
 * The bucket a coin belongs in, or '' for "nothing recorded".
 *
 * Buckets are keyed on the string the grid shows (`coinDenominationDisplay`),
 * so chart and grid always agree: "2/-" and "2 Shilling" share a bar, a
 * resolved `denominationId` buckets under its label, and unresolved coins such
 * as `Other (8 Reales)` and `Other (100 Soles)` stay separate bars.
 *
 * Emptiness is decided on the rendered string: a coin with nothing recorded
 * displays as an em-dash, which must not become a category.
 */
function bucketLabel(
  coin: CoinRecord,
  dimension: BreakdownDimension,
  denominations: readonly PickerDenomination[]
): string {
  if (dimension !== 'denomination') return rawValue(coin, dimension).trim();

  const shown = coinDenominationDisplay(coin, denominations);
  return shown === NO_DENOMINATION ? '' : shown;
}

interface Bucket {
  label: string;
  count: number;
  valueSum: number;
  valueKnown: number;
  valueUnknown: number;
}

function bucketToSlice(bucket: Bucket): BreakdownSlice {
  return {
    label: bucket.label,
    count: bucket.count,
    value: bucket.valueKnown > 0 ? bucket.valueSum : null,
    valueKnownCount: bucket.valueKnown,
    valueUnknownCount: bucket.valueUnknown,
    folded: false,
    foldedSliceCount: 0
  };
}

/**
 * Ranking key. Under the value metric an unappraised slice ranks on 0 (the
 * bottom), not on its count.
 */
function rankOf(bucket: Bucket, metric: BreakdownMetric): number {
  return metric === 'value' ? bucket.valueSum : bucket.count;
}

/**
 * @param denominations optional `Denominations` lookup for the denomination
 *        dimension; without it each coin's own text is its label.
 */
export function buildBreakdown(
  coins: readonly CoinRecord[],
  dimension: BreakdownDimension,
  metric: BreakdownMetric,
  maxSlices: number = MAX_SLICES,
  denominations: readonly PickerDenomination[] = []
): Breakdown {
  const buckets = new Map<string, Bucket>();
  let unlabelledCount = 0;

  for (const coin of coins) {
    const label = bucketLabel(coin, dimension, denominations);
    if (label.length === 0) {
      unlabelledCount++;
      continue;
    }

    const bucket = buckets.get(label) ?? {
      label,
      count: 0,
      valueSum: 0,
      valueKnown: 0,
      valueUnknown: 0
    };

    bucket.count++;

    // Zero means "not appraised", as in collection-totals.ts.
    const worth = coin.currentValue;
    if (typeof worth === 'number' && Number.isFinite(worth) && worth > 0) {
      bucket.valueSum += worth;
      bucket.valueKnown++;
    } else {
      bucket.valueUnknown++;
    }

    buckets.set(label, bucket);
  }

  const ranked = [...buckets.values()].sort((a, b) => {
    const diff = rankOf(b, metric) - rankOf(a, metric);
    // Alphabetical tie-break so equal slices keep a stable order.
    return diff !== 0 ? diff : a.label.localeCompare(b.label);
  });

  const labelledCount = ranked.reduce((sum, bucket) => sum + bucket.count, 0);

  // Fold the tail into "Other".
  const slices: BreakdownSlice[] = [];
  // A fold leaves maxSlices - 1 named bars, so the tail always holds at least
  // two categories.
  const needsFold = ranked.length > maxSlices;
  const namedCount = needsFold ? maxSlices - 1 : ranked.length;

  for (let i = 0; i < namedCount; i++) {
    slices.push(bucketToSlice(ranked[i]));
  }

  if (needsFold) {
    const tail = ranked.slice(namedCount);
    const other: BreakdownSlice = {
      label: OTHER_LABEL,
      count: 0,
      value: null,
      valueKnownCount: 0,
      valueUnknownCount: 0,
      folded: true,
      foldedSliceCount: tail.length
    };
    let sum = 0;
    for (const bucket of tail) {
      other.count += bucket.count;
      sum += bucket.valueSum;
      other.valueKnownCount += bucket.valueKnown;
      other.valueUnknownCount += bucket.valueUnknown;
    }
    other.value = other.valueKnownCount > 0 ? sum : null;
    slices.push(other);
  }

  return {
    dimension,
    metric,
    slices,
    labelledCount,
    unlabelledCount,
    distinctLabelCount: ranked.length
  };
}
