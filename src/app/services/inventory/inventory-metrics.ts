import { CoinRecord, SpotPrices } from '../../types/coin.model';
import { heldCoins } from '../../types/collection-status';

 /*
  * Pure calculations over the coin list: money totals, distinct-value lists for
  * the filter dropdowns, and melt value.
  */

/**
 * Grams per troy ounce (the unit spot prices are quoted in). Exported so the
 * statistics view uses the same constant.
 */
export const GRAMS_PER_TROY_OZ = 31.1035;

 /*
  * The three money totals count only coins the user holds (via `heldCoins()`):
  * the inventory can include a want list, and summing it into the collection's
  * value would give a plausible but wrong figure. What counts is decided by
  * `isHeldInCollection()` in types/collection-status.ts (owned and for-sale;
  * not wanted, ordered or sold). Filtering happens here rather than at call
  * sites so new callers can't forget it.
  */

/** What the collection cost: the sum of held coins' purchase prices. */
export function sumPurchasePrice(coins: CoinRecord[]): number {
  return heldCoins(coins).reduce((sum, c) => sum + c.purchasePrice, 0);
}

/** What the collection is worth today: the sum of held coins' values. */
export function sumCurrentValue(coins: CoinRecord[]): number {
  return heldCoins(coins).reduce((sum, c) => sum + c.currentValue, 0);
}

/** Profit/loss on held coins: current value minus cost, coin by coin. */
export function sumProfit(coins: CoinRecord[]): number {
  return heldCoins(coins).reduce((sum, c) => sum + (c.currentValue - c.purchasePrice), 0);
}

 /*
  * The distinct-value lists see every coin, held or not: they feed the filter
  * dropdowns, and a want-list coin must be reachable by filtering.
  */

/** Distinct categories in use, in first-seen order (not sorted). */
export function distinctCategories(coins: CoinRecord[]): string[] {
  const categories = coins.map(c => c.category).filter(Boolean);
  return [...new Set(categories)];
}

/** Distinct countries in use, sorted, for the country filter. */
export function distinctCountries(coins: CoinRecord[]): string[] {
  const countries = coins.map(c => c.country).filter(Boolean);
  return [...new Set(countries)].sort();
}

/** Distinct import sources in use, sorted, for the source filter. */
export function distinctSources(coins: CoinRecord[]): string[] {
  const sources = coins.map(c => c.source).filter(Boolean);
  return [...new Set(sources)].sort();
}

/**
 * Value of a coin's precious metal at the current spot price, or null ("can't
 * say", not "worthless") when the pure weight, metal or that metal's price is
 * missing.
 *
 * Purity is not applied: `pmWeightGrams` is already the pure metal weight (e.g.
 * a $20 Saint-Gaudens: 33.44 g gross, 90% fine, pmWeightGrams 30.09 = 0.9675 oz
 * AGW; see pm-reference.ts). Multiplying by pmPercent again would understate
 * melt by the purity factor. So pmPercent is neither used nor required.
 *
 * Collection status is not consulted: melt is a property of the metal, and it
 * is most useful on want-list coins when deciding what to bid. Any future
 * collection-wide melt total must filter through `heldCoins()`.
 *
 * @param coin needs pmWeightGrams (grams of pure metal) and metalContent
 * @param prices spot prices per troy ounce
 */
export function computeMeltValue(coin: CoinRecord, prices: SpotPrices): number | null {
  const pmWeight = coin.pmWeightGrams ?? 0;
  const metal = (coin.metalContent ?? '').toLowerCase();

  if (pmWeight <= 0 || !metal) return null;

  let spotPerOz = 0;
  if (metal.includes('gold')) spotPerOz = prices.gold;
  else if (metal.includes('silver')) spotPerOz = prices.silver;
  else if (metal.includes('platinum')) spotPerOz = prices.platinum;
  else if (metal.includes('copper')) spotPerOz = prices.copper;

  if (spotPerOz <= 0) return null;

  return (pmWeight / GRAMS_PER_TROY_OZ) * spotPerOz;
}

/**
 * Whether any spot price is loaded. A 0 means "no price" (metals don't trade at
 * zero), so an all-zero set is treated as no prices: an all-zero fetch has
 * failed, must not be saved, and a saved all-zero row is ignored. This is the
 * shared predicate for those checks; it judges the set as a whole (one real
 * price is enough). The UI also uses it to tell "no prices fetched" apart from
 * "no precious metal".
 */
export function hasAnySpotPrice(prices: SpotPrices): boolean {
  return prices.gold > 0 || prices.silver > 0 || prices.platinum > 0 || prices.copper > 0;
}

/** The four metals with a spot price, in computeMeltValue's test order. */
const PRICED_METALS: ReadonlyArray<{ keyword: string; label: string; key: keyof SpotPrices }> = [
  { keyword: 'gold', label: 'Gold', key: 'gold' },
  { keyword: 'silver', label: 'Silver', key: 'silver' },
  { keyword: 'platinum', label: 'Platinum', key: 'platinum' },
  { keyword: 'copper', label: 'Copper', key: 'copper' }
];

/**
 * One-sentence tooltip explaining a coin's melt figure. A "—" can mean "no spot
 * prices fetched" (fixable with Fetch) or "no precious metal" (nothing to fix),
 * so the text says which, naming any missing field (PM Weight, Metal). Follows
 * computeMeltValue()'s order: weight, metal, then a price for that metal.
 *
 * @returns a sentence for a `title` attribute; never empty
 */
export function describeMeltValue(coin: CoinRecord, prices: SpotPrices): string {
  const melt = computeMeltValue(coin, prices);
  if (melt !== null) {
    return 'Melt value of this coin’s pure precious-metal content at the current spot price.';
  }

  if ((coin.pmWeightGrams ?? 0) <= 0) {
    return 'No melt value: this coin has no PM Weight (g) recorded — that is the weight of PURE precious metal, not the coin’s gross weight.';
  }

  const metal = (coin.metalContent ?? '').trim();
  if (!metal) {
    return 'No melt value: this coin has no Metal Content recorded.';
  }

  const priced = PRICED_METALS.find(m => metal.toLowerCase().includes(m.keyword));
  if (!priced) {
    return `No melt value: ${metal} is not a precious metal the app prices (gold, silver, platinum and copper only).`;
  }

  // The coin is fine; say whether there are no prices at all or just none for this metal.
  if (!hasAnySpotPrice(prices)) {
    return 'No melt value: no spot prices have been loaded yet. Open Spot Prices and press "Fetch COMEX Prices".';
  }
  return `No melt value: no ${priced.label.toLowerCase()} spot price is loaded. Open Spot Prices to enter or fetch one.`;
}
