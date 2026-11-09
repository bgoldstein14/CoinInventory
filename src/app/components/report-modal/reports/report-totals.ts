/*
 * report-totals.ts — adding up money without lying about what is missing.
 *
 * A coin whose value has never been appraised has `currentValue === 0`. Sum
 * that column naively and the answer is confidently, invisibly too small; on
 * an insurance schedule that is not cosmetic, it is an understated claim.
 * The governing rule, written down at the top of services/pm-reference.ts:
 *
 *     A WRONG FIGURE SILENTLY PRODUCES A WRONG ANSWER.
 *     A BLANK IS VISIBLE AND THE USER CAN FIX IT.
 *
 * `computeMeltValue` obeys it by returning null rather than 0. This file
 * carries the rule up to the TOTAL, where it is easier to get wrong because a
 * sum has to produce *some* number. The answer is that a sum produces three
 * numbers — see HonestTotal in report-types.ts — and the renderer prints all
 * three.
 *
 * WHY 0 IS TREATED AS "NOT RECORDED"
 *
 * `purchasePrice` and `currentValue` are non-nullable numbers on CoinRecord
 * and default to 0, so the data model genuinely cannot tell "this coin was a
 * gift and cost nothing" apart from "nobody has filled this in". Given that
 * ambiguity there are only two choices, and only one of them is safe:
 *
 *   treat 0 as a real figure  -> a 400-coin collection with 40 unappraised
 *                                coins reports a total that is too small, and
 *                                says nothing about it.
 *   treat 0 as unknown        -> the total is based on 360 coins, the page
 *                                says "40 coins have no Current Value
 *                                recorded and are NOT included in this
 *                                total", and the reader decides.
 *
 * The second is the only one that can be wrong in a way the reader can see.
 * It is the same trade the melt column already makes.
 */

import { CoinRecord, SpotPrices } from '../../../types/coin.model';
import { computeMeltValue, hasAnySpotPrice } from '../../../services/inventory/inventory-metrics';
import { HonestTotal } from './report-types';

/**
 * Add up a list of "known or not" figures.
 *
 * Takes `(number | null)[]` rather than coins so it has no opinion about what
 * makes a value unknown — that judgement belongs to the small functions below,
 * one per field, where it can be read and changed in isolation. A 0 handed to
 * this function is therefore a REAL zero and is counted.
 */
export function sumKnown(values: readonly (number | null)[]): HonestTotal {
  let total = 0;
  let counted = 0;
  let unknown = 0;

  for (const value of values) {
    if (value === null) {
      unknown++;
      continue;
    }
    total += value;
    counted++;
  }

  return { total, counted, unknown };
}

/**
 * What this coin is worth for insurance purposes, or null if nobody has said.
 *
 * A negative value cannot be an appraisal; it is a typo or a bad import, and
 * subtracting it from the schedule would be worse than leaving it out.
 */
export function insuredValue(coin: CoinRecord): number | null {
  return coin.currentValue > 0 ? coin.currentValue : null;
}

/** What this coin cost, or null if no purchase price was ever recorded. */
export function purchaseCost(coin: CoinRecord): number | null {
  return coin.purchasePrice > 0 ? coin.purchasePrice : null;
}

/**
 * The coin's melt value for a report, or null.
 *
 * Deliberately thin: the arithmetic is NOT repeated here. `computeMeltValue`
 * is the only place in the app that knows the sum, and re-deriving it is how
 * purity comes to be applied twice.
 *
 * The extra thing this adds is the `undefined` case — a report may be built
 * before any spot price has been loaded, and "no prices at all" is a
 * different situation from "this coin has no metal". Both answer null here,
 * but the CALLER uses hasReportMeltValues() below to decide whether to print
 * a melt column at all, so an empty price table produces no column rather
 * than a column of dashes.
 */
export function reportMeltValue(coin: CoinRecord, prices: SpotPrices | undefined): number | null {
  if (!prices) return null;
  return computeMeltValue(coin, prices);
}

/**
 * Is it worth printing a melt column/total at all?
 *
 * Reuses hasAnySpotPrice() rather than asking "did any coin produce a
 * figure", because the two answer different questions and only this one is
 * stable: a collection of clad quarters with a full price table legitimately
 * has no melt values, and the column should still appear showing why.
 */
export function hasReportMeltValues(prices: SpotPrices | undefined): boolean {
  return !!prices && hasAnySpotPrice(prices);
}

/**
 * Currency for a printed page: "$1,234,567.50".
 *
 * NOT `formatInventoryCell`, and not `formatMeltValue` — both of those are
 * `$${n.toFixed(2)}`, which is right for a dense on-screen grid where a
 * thousands separator is visual noise in a 70px column, and wrong for a grand
 * total that somebody reads aloud off a sheet of paper. A seven-figure
 * collection total without separators is genuinely hard to read.
 *
 * The locale is pinned to 'en-US' rather than left to the machine: this is a
 * dollar figure with a dollar sign in front of it, and formatting the digits
 * by one country's convention and the symbol by another's would be worse
 * than either. Pinning also makes the output identical on every machine,
 * which is what lets the tests assert on the exact string.
 */
const REPORT_MONEY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function formatReportMoney(value: number): string {
  return `$${REPORT_MONEY.format(value)}`;
}

/** "1 coin" / "7 coins". Pluralisation in one place so no caller gets it wrong. */
export function pluralCoins(count: number): string {
  return count === 1 ? '1 coin' : `${count} coins`;
}

/**
 * Turn an HonestTotal into the three strings a report prints.
 *
 * `fieldLabel` is the name of the field as it appears on the page ("Current
 * Value"), because a caveat that says "3 coins are excluded" is useless — the
 * reader needs to know WHICH blank to go and fill in.
 *
 * `missingPhrase` is how the sentence ends before the field name, and exists
 * because the two totals are missing values for different reasons. A Current
 * Value is MISSING BECAUSE NOBODY TYPED IT, and the owner can go and fix
 * that. A melt value is missing because the coin's metal or weight is
 * unknown, or no spot price is loaded; nobody "records" a melt value, and
 * telling the reader otherwise sends them looking for a box that does not
 * exist. Defaulted so the common case stays a two-argument call.
 *
 * An all-unknown total renders as an em-dash, not "$0.00". Zero coins priced
 * is not the same as a collection worth nothing, and the dash is the same
 * "we cannot say" marker the grid already uses everywhere else.
 */
export function formatHonestTotal(
  amount: HonestTotal,
  fieldLabel: string,
  missingPhrase = 'recorded for'
): { amountText: string; basis: string; caveat: string | null } {
  const amountText = amount.counted === 0 && amount.unknown > 0
    ? '—'
    : formatReportMoney(amount.total);

  const singular = amount.unknown === 1;
  const caveat = amount.unknown === 0
    ? null
    : `${fieldLabel} is not ${missingPhrase} ${pluralCoins(amount.unknown)}, `
      + `so ${singular ? 'that coin is' : 'those coins are'} NOT included in this total.`;

  return { amountText, basis: pluralCoins(amount.counted), caveat };
}
