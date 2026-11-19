 /*
  * Maps the pm-reference.ts answer ("what is this coin made of?") onto a coin's
  * five alloy fields: Metal Content, Composition, PM %, PM Weight (g) and gross
  * Weight. Shared by the Quicken import, the CSV import (blanks only) and the
  * Settings PM backfill, so all three write the same values. All alloy rules
  * and refusals stay in pm-reference.ts; this file reshapes the answer and
  * decides which fields are safe to write.
  */

import { CoinRecord } from '../types/coin.model';
import { lookupCoinAlloy } from './pm-reference';
// Coarse metal-only fallback, used only when `lookupCoinAlloy` declines.
import { inferMetalContent } from './metal-inference';

/**
 * The five fields this file writes, in UI order. Backfill payloads must contain
 * only these keys (a test checks this), and "already complete?" checks all five.
 * `weight` is the whole coin's weight in grams (since migration 008), copied
 * from `grossWeightGrams` without conversion; it follows the same rules.
 */
export const PM_FIELD_KEYS = [
  'metalContent',
  'composition',
  'pmPercent',
  'pmWeightGrams',
  'weight'
] as const satisfies readonly (keyof CoinRecord)[];

/** One of the five alloy / weight field names. */
export type PmFieldKey = (typeof PM_FIELD_KEYS)[number];

/**
 * The five fields in `CoinRecord`'s names (`CoinAlloy.metal` becomes
 * `metalContent` here; the rename happens only in `composePmFields`).
 *
 * Unknown fields are `undefined`, never 0 or '': a 0 PM weight would be read
 * by `computeMeltValue` as a recorded fact. Only `metalContent` is required,
 * because the coarse inference (metal-inference.ts) gives the metal alone;
 * with no metal at all the result is `null`.
 */
export interface CoinPmFields {
  /** Canonical Metal value: 'Gold', 'Silver', 'Clad', ... */
  metalContent: string;
  /** Free-text alloy description, e.g. '90% Gold, 10% Copper'; absent for a coarse answer. */
  composition?: string;
  /** Fineness as a percentage (90 = 90%); absent for base metal and coarse answers. */
  pmPercent?: number;
  /** Pure precious-metal weight in grams (not gross); absent for base metal and coarse answers. */
  pmWeightGrams?: number;
  /**
   * The whole coin's weight in grams. Present for base-metal coins too (a 1983
   * cent weighs 2.50 g); absent for a coarse answer and for the large cent and
   * half cent rows.
   */
  weight?: number;
}

/**
 * Optional extra evidence beyond country, denomination and year. Deliberately
 * excludes `category` (see metal-inference.ts).
 */
export interface PmFillContext {
  /** Coin type / series: 'Saint-Gaudens', 'Gold Eagle', 'Morgan', ... */
  coinType?: string;
  /** Alloy description already recorded on the coin. */
  composition?: string;
}

/**
 * Asks what a coin is made of and returns the answer in `CoinRecord` field names.
 *
 * 1. `lookupCoinAlloy` (pm-reference.ts) is authoritative: a catalogued row is
 *    used exactly as given, all five fields.
 * 2. Only when it returns nothing does the coarse metal inference run, and it
 *    supplies `metalContent` alone.
 * Both still answer nothing where two alloys circulated at once (1942 nickel,
 * 1982 cent, 1971-78 Eisenhower, a bare `$1` in the gold-dollar era).
 *
 * @param denomination normalised denomination ('50¢', '$20', '100 Soles')
 * @param year year string; ranges ('1920-1930') and overdates ('1862/1') tolerated
 * @param country country name ('United States', 'Great Britain', 'Peru')
 * @param metalHint the metal when stated outside the year/denomination: the
 *   security name ('1855 G$1') on import, or the coin's existing Metal Content on
 *   backfill. Allowed to break ties the table otherwise refuses.
 * @param context coin type and existing composition, read by the coarse
 *   fallback; omitting it only makes a blank answer more likely
 */
export function composePmFields(
  denomination: string,
  year: string,
  country: string,
  metalHint?: string,
  context?: PmFillContext
): CoinPmFields | null {
  // Source 1: the catalogued answer, used verbatim.
  const alloy = lookupCoinAlloy(denomination, year, country, metalHint);
  if (alloy) {
    return {
      metalContent: alloy.metal,
      composition: alloy.composition,
      pmPercent: alloy.pmPercent,
      pmWeightGrams: alloy.pmWeightGrams,
      // The reference table's `grossWeightGrams` is the record's `weight`; grams on both sides.
      weight: alloy.grossWeightGrams
    };
  }

  // Source 2: the coarse, metal-only fallback.
  const metal = inferMetalContent({
    coinType: context?.coinType,
    denomination,
    year,
    country,
    composition: context?.composition,
    metalHint
  });
  if (!metal) return null;

  // Metal only; the other fields stay absent (the metal says nothing about weight).
  return { metalContent: metal };
}

/**
 * Whether a field is empty. Zero counts as a value: the backfill only fills
 * blanks, and a 0 may have been typed by hand (unlike spot prices, where 0
 * means "no price"; see `hasAnySpotPrice`). NaN, left by a failed parse,
 * counts as blank.
 */
export function isPmFieldBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

/** True when the coin has a value in all five alloy / weight fields. */
export function hasAllPmFields(coin: Partial<CoinRecord>): boolean {
  return PM_FIELD_KEYS.every((key) => !isPmFieldBlank(coin[key]));
}

/** Options for `inferPmFields`. */
export interface InferPmOptions {
  /**
   * Whether the coin's own `metalContent` is passed to the lookup as a hint.
   * Default true: it is normally the user's own statement and settles cases
   * like an 1855 "$1".
   *
   * The editor's autofill passes false on its first attempt: after changing the
   * denomination from "$1" to "$20", the recorded "Silver" is the previous
   * inference's output and would block the new answer. `planPmAutofill`
   * (pm-autofill.ts) retries with the hint when the hintless lookup answers nothing.
   */
  useRecordedMetalAsHint?: boolean;
}

/**
 * Asks `composePmFields` using a coin record: which column is the hint, which are
 * context. Shared by the Settings backfill and the editor's autofill so both ask
 * the same question. Decides nothing about what is written (`pmFieldsToFill` /
 * `planPmAutofill` do that).
 */
export function inferPmFields(
  coin: Partial<CoinRecord>,
  options?: InferPmOptions
): CoinPmFields | null {
  const useHint = options?.useRecordedMetalAsHint ?? true;
  const metalHint =
    useHint && typeof coin.metalContent === 'string' ? coin.metalContent.trim() : '';

  return composePmFields(
    coin.denomination ?? '',
    coin.year ?? '',
    coin.country ?? '',
    metalHint || undefined,
    // Coin Type and Composition are the evidence the coarse fallback reads
    // ("Gold Eagle", "Saint-Gaudens").
    {
      coinType: coin.coinType,
      composition: typeof coin.composition === 'string' ? coin.composition : undefined
    }
  );
}

/**
 * Which of the five fields may be written for one coin, and with what. Used by
 * the Settings backfill and the CSV import. (The Quicken import calls
 * `composePmFields` directly: a security name carries no alloy fields to protect.)
 *
 * Rules:
 * 1. Only blanks are filled; existing values (typed by the user or supplied
 *    by the file) are omitted from the result and never overwritten.
 * 2. Partially filled coins get their gaps completed. Melt value needs both
 *    `metalContent` and `pmWeightGrams`, so partial coins are the common case.
 * 3. Nothing is invented: a field the inference has no value for is absent.
 *
 * The coin's existing metal is passed as `metalHint`, which settles the
 * 1849-1889 `$1` (silver or gold dollar) and 1992+ silver proof dimes/quarters.
 * If it matches no row the lookup returns null and the coin is left alone.
 *
 * @returns the fields to write, or {} when complete or the table declines
 */
export function pmFieldsToFill(coin: Partial<CoinRecord>): Partial<CoinRecord> {
  if (hasAllPmFields(coin)) return {};

  // The stored metal is used as a hint here (see `InferPmOptions.useRecordedMetalAsHint`).
  const inferred = inferPmFields(coin);

  // Neither source would commit; no further guess.
  if (!inferred) return {};

  const updates: Partial<CoinRecord> = {};
  for (const key of PM_FIELD_KEYS) {
    // Rule 1: never touch a field that already holds something.
    if (!isPmFieldBlank(coin[key])) continue;
    // Rule 3: never invent a value.
    const value = inferred[key];
    if (value === undefined) continue;
    // Safe: `CoinPmFields` uses the same keys and types as `CoinRecord`;
    // TypeScript can't prove it through a union-key index.
    (updates as Record<string, unknown>)[key] = value;
  }

  return updates;
}
