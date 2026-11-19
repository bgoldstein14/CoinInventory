/*
 * report-totals.ts — totals that report what is missing.
 *
 * purchasePrice and currentValue default to 0, so 0 is treated as "not
 * recorded": such coins are left out of a total and counted as unknown, and
 * the page says how many. See HonestTotal in report-types.ts.
 */

import { CoinRecord, SpotPrices } from '../../../types/coin.model';
import { computeMeltValue, hasAnySpotPrice } from '../../../services/inventory/inventory-metrics';
import { HonestTotal } from './report-types';

/**
 * Add up a list of known-or-null figures. A null is counted as unknown; a 0
 * passed here is a real zero and is counted.
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

/** What this coin is worth for insurance purposes, or null if not recorded (zero or negative). */
export function insuredValue(coin: CoinRecord): number | null {
  return coin.currentValue > 0 ? coin.currentValue : null;
}

/** What this coin cost, or null if no purchase price was ever recorded. */
export function purchaseCost(coin: CoinRecord): number | null {
  return coin.purchasePrice > 0 ? coin.purchasePrice : null;
}

/** The coin's melt value for a report, or null (also when no spot prices are loaded). */
export function reportMeltValue(coin: CoinRecord, prices: SpotPrices | undefined): number | null {
  if (!prices) return null;
  return computeMeltValue(coin, prices);
}

/**
 * Whether to print a melt column/total at all: true whenever any spot price
 * is loaded, even if no coin in the report has a melt value.
 */
export function hasReportMeltValues(prices: SpotPrices | undefined): boolean {
  return !!prices && hasAnySpotPrice(prices);
}

/**
 * Currency for a printed page: "$1,234,567.50". Unlike the grid formatter it
 * uses thousands separators; the locale is pinned so output is stable.
 */
const REPORT_MONEY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function formatReportMoney(value: number): string {
  return `$${REPORT_MONEY.format(value)}`;
}

/** "1 coin" / "7 coins". */
export function pluralCoins(count: number): string {
  return count === 1 ? '1 coin' : `${count} coins`;
}

/**
 * Turn an HonestTotal into the printed amount, basis and caveat.
 *
 * `fieldLabel` names the missing field in the caveat; `missingPhrase` lets
 * the melt total say "calculable for" instead of "recorded for". An
 * all-unknown total prints as "—", not "$0.00".
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
