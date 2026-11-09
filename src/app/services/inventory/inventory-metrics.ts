import { CoinRecord, SpotPrices } from '../../types/coin.model';
import { heldCoins } from '../../types/collection-status';

 /*
 * Inventory metrics
 *
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
  */

/**
 * Grams in one troy ounce — the unit precious metal spot prices are quoted in.
 *
 * EXPORTED, and it must stay exported. The statistics view totals the pure
 * metal held and shows it in troy ounces as well as grams, and a second copy
 * of this constant living over there is a copy that can drift from the one
 * the melt value is computed with. One number, one home.
 */
export const GRAMS_PER_TROY_OZ = 31.1035;

 /*
 * THE THREE MONEY TOTALS COUNT ONLY COINS THE OWNER ACTUALLY HAS.
 *
 * All three filter through `heldCoins()` first. Before collection status
 * existed every row in the inventory was, by definition, a coin in the
 * collection, so "add up the rows" and "add up what I own" were the same sum.
 * They are not any more: the inventory can now hold a want list, and a want
 * list is a list of coins the owner is DREAMING about. Summing those into
 * "what is my collection worth" would report a collection several times
 * larger than the one in the safe, and — this is the dangerous part — it
 * would look completely plausible. There is nothing on screen that would
 * reveal the error.
 *
 * WHAT COUNTS is decided in exactly one place, `isHeldInCollection()` in
 * types/collection-status.ts, which the insurance export consults too. The
 * short version is that the test is POSSESSION: owned and for-sale count, and
 * wanted, ordered and sold do not. The reasoning for each is written out
 * there and is not repeated here, because two copies of a rule is how this
 * project got its melt-value bug (the same sum in two files, only one of them
 * fixed).
 *
 * The filtering is NOT pushed into the caller. It could have been
 * (`sumCurrentValue(heldCoins(inventory()))` at each of the three call sites
 * in inventory.service.ts) and that was rejected: it makes the safe behaviour
 * opt-in, so the fourth caller — whoever adds a statistics panel, a dashboard
 * tile, a report — gets the want list in his figures unless he happens to
 * know. Here, it is impossible to get wrong.
  */

/** What the collection cost: the sum of every HELD coin's purchase price. */
export function sumPurchasePrice(coins: CoinRecord[]): number {
  return heldCoins(coins).reduce((sum, c) => sum + c.purchasePrice, 0);
}

/** What the collection is worth today: the sum of every HELD coin's value. */
export function sumCurrentValue(coins: CoinRecord[]): number {
  return heldCoins(coins).reduce((sum, c) => sum + c.currentValue, 0);
}

/** Overall profit/loss on the coins held: current value minus cost, coin by coin. */
export function sumProfit(coins: CoinRecord[]): number {
  return heldCoins(coins).reduce((sum, c) => sum + (c.currentValue - c.purchasePrice), 0);
}

 /*
 * THE DISTINCT-VALUE LISTS BELOW DELIBERATELY SEE EVERY COIN, HELD OR NOT.
 *
 * They are not valuations; they feed the filter dropdowns. The first thing
 * anybody does with a want list is filter to it, and if a wanted coin's
 * category were missing from the Category dropdown there would be no way to
 * reach that coin through the filter bar at all. Status changes what a coin
 * is WORTH to the collection, never whether it exists.
  */

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

/**
 * Value of a coin's precious metal content at today's spot price.
 *
 * Returns null — meaning "we cannot say" rather than "it is worth nothing" —
 * when the pure-metal weight, the metal name, or a spot price for that metal
 * is missing.
 *
 * ---- PURITY IS NOT APPLIED HERE ----
 * Do NOT write this as:
 *
 *     (pmWeight / GRAMS_PER_TROY_OZ) * (pmPct / 100) * spotPerOz
 *
 * That discounts by purity a second time. `pmWeightGrams` is already the
 * weight of the PURE precious metal, not the gross weight of the coin — see
 * the header of services/pm-reference.ts, which gives the worked example of a
 * $20 Saint-Gaudens: 33.44 g gross, 90% fine, so pmWeightGrams = 30.09, which
 * IS the 0.9675 oz AGW the trade quotes. Multiplying 30.09 g by 0.90 again
 * gives 0.871 oz for a coin that holds 0.9675 oz — understating every melt
 * value by the purity factor, about 10% on US 90% silver and gold and 60% on
 * a 40% silver Kennedy half.
 *
 * So the correct sum is pure grams converted to troy ounces, priced at spot.
 * `pmPercent` stays on the record because it is genuinely useful information,
 * but it must NOT appear in this calculation.
 *
 * It is also not required for a melt value to be produced. Purity is not an
 * input to the arithmetic, so demanding it would refuse an answer for a coin
 * whose pure weight and metal are both known — a .999 bullion round recorded
 * without a percentage, for instance.
 *
 * ---- COLLECTION STATUS IS NOT CONSULTED HERE, AND THAT IS A DECISION ----
 * A wanted coin gets a melt figure exactly like an owned one. The three money
 * TOTALS above exclude coins the owner does not have, because summing a want
 * list into "what my collection is worth" would be a lie. This is a different
 * kind of number: it is a fact about a lump of metal — 30.09 g of gold is
 * worth what gold is worth whoever happens to be holding it — and it is at
 * its most useful on exactly the coins the owner does NOT have yet, because
 * the melt floor is what tells him what is safe to bid. Blanking it out for
 * want-list rows would remove the figure precisely where it earns its keep.
 *
 * There is no collection-wide melt TOTAL anywhere in the app. If one is ever
 * added it must filter through `heldCoins()` first, for the same reason the
 * three sums above do.
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
 * ---- A ZERO IS NOT A PRICE — IT IS THE ABSENCE OF ONE ----
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
