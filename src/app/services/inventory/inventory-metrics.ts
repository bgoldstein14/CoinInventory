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

// NOTE: a `distinctDealers()` lived here, alongside the three functions above.
// It was removed with the coin-level dealer field. Its only caller was
// InventoryService.inventoryDealers, which no UI ever read -- the dealer filter
// was a free-text box, not a dropdown -- so nothing lost a feature.

/**
 * Value of a coin's precious metal content at today's spot price.
 *
 * Returns null — meaning "we cannot say" rather than "it is worth nothing" —
 * when the pure-metal weight, the metal name, or a spot price for that metal
 * is missing.
 *
 * ---------------------------------------------------------------------------
 * PURITY IS NOT APPLIED HERE, AND THAT IS THE FIX FOR A REAL BUG
 * ---------------------------------------------------------------------------
 * This used to end with:
 *
 *     (pmWeight / GRAMS_PER_TROY_OZ) * (pmPct / 100) * spotPerOz
 *
 * which discounted by purity a second time. `pmWeightGrams` is already the
 * weight of the PURE precious metal, not the gross weight of the coin — see
 * the header of services/pm-reference.ts, which states it outright and gives
 * the worked example of a $20 Saint-Gaudens: 33.44 g gross, 90% fine, so
 * pmWeightGrams = 30.09, which IS the 0.9675 oz AGW the trade quotes.
 *
 * Multiplying 30.09 g by 0.90 again produced 0.871 oz for a coin that holds
 * 0.9675 oz, understating every melt value by exactly the purity factor —
 * about 10% on US 90% silver and gold, and 60% on a 40% silver Kennedy half.
 *
 * So the correct sum is simply pure grams converted to troy ounces, priced at
 * spot. `pmPercent` remains on the record because it is genuinely useful
 * information (it is what the "90% Silver" style of composition means, and it
 * is how pmWeightGrams was derived in the first place), but it must NOT appear
 * in this calculation.
 *
 * It is also no longer required for a melt value to be produced. Purity is not
 * an input to the arithmetic any more, so demanding it would refuse an answer
 * for a coin whose pure weight and metal are both known — a .999 bullion round
 * recorded without a percentage, for instance.
 *
 * @param coin - needs pmWeightGrams (grams of PURE metal) and metalContent
 * @param prices - current spot prices, quoted per troy ounce
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
 * Has ANY spot price been loaded at all?
 *
 * ---------------------------------------------------------------------------
 * A ZERO IS NOT A PRICE — IT IS THE ABSENCE OF ONE
 * ---------------------------------------------------------------------------
 * Gold, silver, platinum and copper do not trade at zero and never will, so
 * throughout this app a 0 means "we have no price for that metal", exactly as
 * a null would. That invariant is what lets computeMeltValue() above say
 * `if (spotPerOz <= 0) return null` with a clear conscience, and it is why
 * nothing in the app may store, POST or adopt an all-zero price set:
 *
 *   - a FETCH that comes back all zeros is a failed fetch, not cheap metal;
 *   - a SAVE of all zeros would put permanent garbage in the history table,
 *     which the next start-up would faithfully read back in; and
 *   - a saved ROW of all zeros, if one is already there from before these
 *     guards existed, must be ignored rather than believed.
 *
 * This is the one predicate all three of those checks share. It is about the
 * SET as a whole: one real price and three zeros is a perfectly good set in
 * which three metals simply have no price.
 *
 * The UI also uses it to tell two identical-looking "—" cells apart: an empty
 * price table (fixable with one press of Fetch) versus a base-metal coin
 * (nothing to fix).
 */
export function hasAnySpotPrice(prices: SpotPrices): boolean {
  return prices.gold > 0 || prices.silver > 0 || prices.platinum > 0 || prices.copper > 0;
}

/** The four metals we hold a spot price for, in the order computeMeltValue tests them. */
const PRICED_METALS: ReadonlyArray<{ keyword: string; label: string; key: keyof SpotPrices }> = [
  { keyword: 'gold', label: 'Gold', key: 'gold' },
  { keyword: 'silver', label: 'Silver', key: 'silver' },
  { keyword: 'platinum', label: 'Platinum', key: 'platinum' },
  { keyword: 'copper', label: 'Copper', key: 'copper' }
];

/**
 * A one-sentence explanation of a coin's melt figure, suitable for a tooltip.
 *
 * WHY THIS EXISTS
 * A melt cell showing "—" is ambiguous, and the two things it can mean call
 * for opposite reactions from the user:
 *
 *   "no spot prices have ever been fetched"  -> fixable: open Spot Prices,
 *                                               press Fetch, every melt cell
 *                                               in the grid fills in at once
 *   "this coin has no precious metal"        -> not fixable, and not a fault:
 *                                               a clad quarter has no melt
 *                                               value worth quoting
 *
 * Without this, the first case looks exactly like the second and the feature
 * looks broken. The wording deliberately names the FIELD that is missing
 * (PM Weight, Metal) so the user knows what to go and fill in.
 *
 * Mirrors computeMeltValue()'s decision order so the two can never disagree:
 * weight, then metal, then a price for that metal.
 *
 * @param coin - the coin whose cell is being explained
 * @param prices - the spot prices currently in memory
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

  // The coin is fine — we simply have no price for its metal. Say whether the
  // price table is empty altogether (one Fetch away) or just missing this one.
  if (!hasAnySpotPrice(prices)) {
    return 'No melt value: no spot prices have been loaded yet. Open Spot Prices and press "Fetch COMEX Prices".';
  }
  return `No melt value: no ${priced.label.toLowerCase()} spot price is loaded. Open Spot Prices to enter or fetch one.`;
}
