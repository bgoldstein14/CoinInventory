 /*
 * composition-breakdown.ts — "what is this collection made of?"
 *
 * Groups the coins by one dimension (denomination, country, grade, category,
 * metal) and ranks the groups, for the ranked-bar chart in the statistics
 * view.
 *
 * ---- TWO SILENT LIES THIS FILE REFUSES TO TELL ----
 * 1. A BLANK FIELD IS NOT A CATEGORY.
 *    The tempting line is `const key = coin.country || '(none)'`. It is what
 *    the existing Reports dialog does. The result is a bar labelled "(none)"
 *    sitting in the ranking among Canada and Mexico, sorted by size like a
 *    real place, and — if enough coins are blank — often the LARGEST bar on
 *    the chart. The reader's eye reads a shape, not a label.
 *
 *    Here, coins with nothing in the field are never a slice. They come back
 *    as `unlabelledCount` so the view prints "No country recorded for 30
 *    coins" underneath, in words, outside the ranking.
 *
 * 2. THE TAIL IS NOT DROPPED.
 *    Forty denominations will not fit on a chart. Showing the top ten and
 *    saying nothing makes the ten look like the whole collection. The fold is
 *    explicit: everything past the cap goes into one "Other" slice that is
 *    always drawn LAST regardless of its size (so it is never mistaken for a
 *    category that happens to be called Other), carries the count of how many
 *    categories went into it, and keeps the bars adding up to the labelled
 *    total.
 *
 *    One exception, and it is the obvious one: a fold that would capture a
 *    SINGLE category does not happen. Replacing one name with "Other" hides
 *    information and gains nothing.
 *
 * 3. (The quiet one.) A slice's VALUE is the sum over the coins in it that
 *    have a recorded value — which is not the same as the sum over the slice.
 *    `valueUnknownCount` is how a slice admits that, and `value` is null
 *    rather than 0 when nothing in the slice was ever appraised.
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

/** What the bars are measuring. */
export type BreakdownMetric = 'count' | 'value';

/** The label the folded tail is drawn under. Never a real category name. */
export const OTHER_LABEL = 'Other';

/**
 * How many bars a breakdown chart draws before folding.
 *
 * Ten rather than the usual categorical ceiling of eight: these bars are all
 * ONE hue (they are magnitudes of one measure, not distinct series), so the
 * colour-vision limit that caps a categorical palette does not apply. The
 * limit here is purely how many labelled rows stay readable in a modal, and
 * ten is about that.
 */
export const MAX_SLICES = 10;

export interface BreakdownSlice {
  label: string;
  /** Coins in this slice. Always exact — a coin is either in it or not. */
  count: number;
  /**
   * Current value of this slice, over the coins in it that have one. Null,
   * not 0, when none of them do.
   */
  value: number | null;
  valueKnownCount: number;
  valueUnknownCount: number;
  /** True for the "Other" slice only. */
  folded: boolean;
  /** How many distinct categories were folded in. 0 for a named slice. */
  foldedSliceCount: number;
}

export interface Breakdown {
  dimension: BreakdownDimension;
  metric: BreakdownMetric;
  /** Ranked largest-first by `metric`, with "Other" (if any) always last. */
  slices: BreakdownSlice[];
  /** Coins that HAVE a value in this field. */
  labelledCount: number;
  /** Coins that do not. Never drawn as a bar — see the header. */
  unlabelledCount: number;
  /** Distinct values in the field, counted BEFORE any folding. */
  distinctLabelCount: number;
}

/**
 * The raw text of one dimension on one coin.
 *
 * `metal` reads the optional `metalContent`; everything else reads a required
 * string field that may still be empty. Either way an empty or whitespace-only
 * answer means "not recorded".
 *
 * Denomination is NOT in here. Since migration 011 it is not a text field at
 * all from a reader's point of view — see `bucketLabel` below.
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
 * Which bucket a coin belongs in, or '' for "nothing recorded".
 *
 * ---- A BUCKET IS KEYED ON THE STRING THE GRID SHOWS. THAT IS THE WHOLE RULE. ----
 * Two views of one collection naming the same denomination two different ways
 * is the kind of small inconsistency that makes a user distrust both, so the
 * chart calls a coin whatever the inventory table calls it —
 * `coinDenominationDisplay`, the same function, not a second reading of the
 * same fields. That carries the shilling normalisation ("2/-" and
 * "2 Shilling" are one bar) for free, as it always did, and it now also
 * carries the id: a coin whose `denominationId` resolves buckets under its
 * LABEL even though the column still says what the import said.
 *
 * ---- AND IT IS WHY UNRESOLVED COINS DO NOT COLLAPSE INTO ONE "OTHER" ----
 * `Other (8 Reales)` and `Other (100 Soles)` are different strings, so they
 * are different bars, and nothing special had to be written to make that
 * true. The alternative — one bucket for everything unresolved — would be
 * silent lie #1 from the header of this file wearing a different hat: a bar
 * that reads as a denomination, ranked by size among real ones, that is in
 * fact a pile of unrelated coins. On the owner's un-migrated database it
 * would be all 105 of them in a single bar.
 *
 * (Note that it cannot be confused with the FOLDED tail either. That slice is
 * labelled exactly `Other`, carries `folded: true`, and is always drawn last
 * regardless of size.)
 *
 * ---- THE ORDERING TRAP, WHICH IS WHY THIS RETURNS '' RATHER THAN THE PLACEHOLDER ----
 * A coin with neither an id nor any text displays as an em-dash. An em-dash
 * is a perfectly good Map key, so returning it would create a category called
 * "—" sitting in the ranking — the `(none)` bar this file exists to refuse.
 * Emptiness is therefore decided HERE, on the rendered string, and not on the
 * raw column: since 011 a coin can have an empty `Denomination` and still
 * have a denomination.
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
 * What a slice is ranked by.
 *
 * Under the VALUE metric a slice with nothing appraised in it ranks on 0 and
 * therefore lands at the bottom — which is the honest place for it, because
 * the chart cannot say how big it is. Note it is NOT ranked on its count as a
 * stand-in: a slice of forty unappraised coins would then outrank a slice
 * holding one gold eagle on a chart whose axis says "dollars".
 *
 * (An earlier version returned a -1 sentinel for the unvalued case. It was
 * removed after a mutation run showed it could not change any outcome:
 * `valueSum` only ever accumulates strictly positive amounts, so an unvalued
 * slice always sums to exactly 0 and 0 already sorts below every valued
 * slice. Dead distinctions in a comparator are worse than none — they read
 * as though some case needs them.)
 */
function rankOf(bucket: Bucket, metric: BreakdownMetric): number {
  return metric === 'value' ? bucket.valueSum : bucket.count;
}

/**
 * @param denominations the `Denominations` lookup, for the `denomination`
 *        dimension only. OPTIONAL, and omitting it is not a wrong answer:
 *        with no list to resolve against, a coin's own text stands as its
 *        label and the chart groups exactly as it did before migration 011.
 *        That is what the statistics dialog shows while the lookup is still
 *        in flight, and what every caller without one gets.
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

    // Same reading of a zero as collection-totals.ts: absent, not nil.
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
    // Alphabetical tie-break, so two equal slices do not swap places between
    // renders (Map iteration order is insertion order, which depends on the
    // order the coins happened to load in).
    return diff !== 0 ? diff : a.label.localeCompare(b.label);
  });

  const labelledCount = ranked.reduce((sum, bucket) => sum + bucket.count, 0);

  // Fold the tail — but only when there is more than one category in it.
  // Folding exactly one category replaces a real name with "Other" and tells
  // the reader strictly less than leaving it alone.
  const slices: BreakdownSlice[] = [];
  //
  // That cannot happen here, and the arithmetic is worth spelling out so a
  // later edit does not break it: a fold leaves `maxSlices - 1` named bars,
  // so the tail holds `ranked.length - maxSlices + 1` categories. The fold
  // only runs when `ranked.length > maxSlices`, i.e. at `maxSlices + 1` or
  // more, which makes the smallest possible tail exactly TWO.
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
