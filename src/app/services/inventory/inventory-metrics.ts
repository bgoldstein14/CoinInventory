import { CoinRecord, SpotPrices } from '../../types/coin.model';

/* ===========================================================================
 * Inventory metrics
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Every "work it out from the coin list" calculation: the money totals, the
 *   distinct-value lists that feed the filter dropdowns, and the melt-value
 *   maths.
 *
 * WHY IT IS ITS OWN FILE
 *   These are PURE functions — same input, same output, no signals, no HTTP,
 *   no side effects. Pulling them out means InventoryService's `computed()`
 *   declarations read like a table of contents, and each calculation can be
 *   checked in isolation.
 * =========================================================================== */

/** Grams in one troy ounce — the unit precious metal spot prices are quoted in. */
const GRAMS_PER_TROY_OZ = 31.1035;

/** What the collection cost: the sum of every purchase price. */
export function sumPurchasePrice(coins: CoinRecord[]): number {
  return coins.reduce((sum, c) => sum + c.purchasePrice, 0);
}

/** What the collection is worth today: the sum of every current value. */
export function sumCurrentValue(coins: CoinRecord[]): number {
  return coins.reduce((sum, c) => sum + c.currentValue, 0);
}

/** Overall profit/loss: current value minus cost, coin by coin. */
export function sumProfit(coins: CoinRecord[]): number {
  return coins.reduce((sum, c) => sum + (c.currentValue - c.purchasePrice), 0);
}

/**
 * Distinct categories actually used by the coins on hand.
 *
 * NOTE: deliberately NOT sorted — this list preserves first-seen order, which
 * is what the category filter has always shown.
 */
export function distinctCategories(coins: CoinRecord[]): string[] {
  const categories = coins.map(c => c.category).filter(Boolean);
  return [...new Set(categories)];
}

/** Distinct countries in use, alphabetically, for the country filter. */
export function distinctCountries(coins: CoinRecord[]): string[] {
  const countries = coins.map(c => c.country).filter(Boolean);
  return [...new Set(countries)].sort();
}

/** Distinct import sources in use, alphabetically, for the source filter. */
export function distinctSources(coins: CoinRecord[]): string[] {
  const sources = coins.map(c => c.source).filter(Boolean);
  return [...new Set(sources)].sort();
}

/** Distinct dealers in use, alphabetically. `dealer` is optional, hence the `?? ''`. */
export function distinctDealers(coins: CoinRecord[]): string[] {
  const dealers = coins.map(c => c.dealer ?? '').filter(Boolean);
  return [...new Set(dealers)].sort();
}

/**
 * Value of a coin's precious metal content at today's spot price.
 *
 * Returns null — meaning "we cannot say" rather than "it is worth nothing" —
 * whenever any ingredient is missing: the weight, the purity, the metal name,
 * or a spot price for that metal.
 *
 * @param coin - needs pmWeightGrams (grams), pmPercent (0-100) and metalContent
 * @param prices - current spot prices, quoted per troy ounce
 */
export function computeMeltValue(coin: CoinRecord, prices: SpotPrices): number | null {
  const pmWeight = coin.pmWeightGrams ?? 0;
  const pmPct = coin.pmPercent ?? 0;
  const metal = (coin.metalContent ?? '').toLowerCase();

  if (pmWeight <= 0 || pmPct <= 0 || !metal) return null;

  let spotPerOz = 0;
  if (metal.includes('gold')) spotPerOz = prices.gold;
  else if (metal.includes('silver')) spotPerOz = prices.silver;
  else if (metal.includes('platinum')) spotPerOz = prices.platinum;
  else if (metal.includes('copper')) spotPerOz = prices.copper;

  if (spotPerOz <= 0) return null;

  return (pmWeight / GRAMS_PER_TROY_OZ) * (pmPct / 100) * spotPerOz;
}
