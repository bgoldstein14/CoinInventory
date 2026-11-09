 /*
 * precious-metal-holdings.ts — "how much gold do I actually hold?"
 * ---- THERE ARE THREE WEIGHTS ON A COIN AND ONLY ONE OF THEM IS THE ANSWER ----
 *     weight           GROSS — the whole coin, alloy and all
 *     pmPercent        the fineness of that alloy
 *     pmWeightGrams    the PURE precious metal  <- the only one used here
 *
 * The worked example lives in the header of services/pm-reference.ts: a 1927
 * $20 Saint-Gaudens weighs 33.436 g, is 90% fine, and therefore contains
 * 30.09 g of actual gold — which IS the 0.9675 ozt AGW the trade quotes.
 *
 * Two ways to get this wrong, both of which have already happened once in
 * this codebase:
 *
 *   SUMMING `weight`                overstates the holding by the alloy —
 *                                   you would be told you hold 33 g of gold
 *                                   that is really 30 g of gold and 3 g of
 *                                   copper.
 *   MULTIPLYING BY `pmPercent`      understates it by the purity a SECOND
 *                                   time (30.09 x 0.9 = 27.08). This is the
 *                                   exact melt-value bug written up at length
 *                                   in services/inventory/inventory-metrics.ts
 *                                   and again in types/inventory-columns.ts.
 *                                   It is about 10% on US gold and 90%
 *                                   silver, and 60% on a 40% silver Kennedy.
 *
 * ---- AND THE HONEST GAP ----
 * `pmWeightGrams` is OPTIONAL and is blank on a great many real records —
 * anything hand-entered, anything imported from a source that did not carry a
 * weight, anything whose year/denomination pm-reference deliberately refuses
 * to guess at (the 1942 nickel, the 1982 cent, the clad-or-silver Ike).
 *
 * A gold coin with no recorded weight is NOT zero grams of gold. So a metal
 * whose coins are all unweighed reports `pureGrams: null`, and every metal
 * reports how many of its coins it could not weigh. The panel prints that
 * count; it never quietly averages a blank in as a zero.
 *
 * ---- WHY THE SAME FOUR METALS AS computeMeltValue, IN THE SAME ORDER ----
 * `computeMeltValue` recognises a metal by substring — gold, silver,
 * platinum, copper — tested in that order, so "90% Silver" and "Silver
 * (.900 fine)" are both silver. This file matches with the SAME keywords in
 * the SAME order, because the two figures sit next to each other on screen:
 * if a coin counted toward "silver held" could not also count toward "melt
 * value", the panel would contradict itself and there would be no way to tell
 * which half was wrong.
 *
 * Copper is included for that reason even though nobody calls it precious. It
 * is one of the four the app prices, so leaving it out would make the metal
 * tiles and the melt total cover different populations.
  */

import { CoinRecord } from '../../types/coin.model';
import { GRAMS_PER_TROY_OZ } from '../inventory/inventory-metrics';

/**
 * The metals the app can price, with the substring each is recognised by.
 *
 * MUST stay in step with PRICED_METALS in inventory-metrics.ts — same
 * keywords, same order. See the header.
 */
const PRICED_METALS: ReadonlyArray<{ keyword: string; label: string }> = [
  { keyword: 'gold', label: 'Gold' },
  { keyword: 'silver', label: 'Silver' },
  { keyword: 'platinum', label: 'Platinum' },
  { keyword: 'copper', label: 'Copper' }
];

/** Grams of pure metal, converted to the unit spot prices are quoted in. */
export function gramsToTroyOunces(grams: number): number {
  return grams / GRAMS_PER_TROY_OZ;
}

export interface MetalHolding {
  /** "Gold", "Silver", "Platinum", "Copper". */
  metal: string;
  /**
   * Total PURE metal held, in grams — or null when not one coin of this
   * metal has a recorded weight. Null means "cannot say", never "none".
   */
  pureGrams: number | null;
  /** Coins of this metal that contributed a weight. */
  coinsWithWeight: number;
  /** Coins of this metal with no usable `pmWeightGrams`. */
  coinsMissingWeight: number;
}

export interface PreciousMetalHoldings {
  /**
   * One entry per priced metal the collection actually contains, in
   * computeMeltValue's test order. A metal nobody holds is absent rather than
   * present at zero — a "Platinum: 0.00 g" tile is noise on a collection that
   * has never contained any.
   */
  holdings: MetalHolding[];
  /**
   * Coins whose metal IS recorded but is not one the app prices (palladium,
   * bronze, clad...). Reported separately from a blank, because this is a gap
   * in the APP — no spot price for that metal — not a gap in the user's data,
   * and there is nothing for them to go and fix.
   */
  unpricedMetalCoinCount: number;
  /** Coins with no Metal Content recorded at all. These the user CAN fix. */
  noMetalCoinCount: number;
}

/**
 * Pure precious metal held, by metal.
 *
 * The three populations it reports — coins inside `holdings`,
 * `unpricedMetalCoinCount` and `noMetalCoinCount` — are disjoint and
 * exhaustive, so the panel can show them as a breakdown of the whole
 * collection and have the numbers add up. A spec asserts that.
 */
export function computePreciousMetalHoldings(coins: readonly CoinRecord[]): PreciousMetalHoldings {
  const byMetal = new Map<string, { grams: number; withWeight: number; missingWeight: number }>();
  let unpricedMetalCoinCount = 0;
  let noMetalCoinCount = 0;

  for (const coin of coins) {
    const metalText = (coin.metalContent ?? '').trim().toLowerCase();
    if (!metalText) {
      noMetalCoinCount++;
      continue;
    }

    const priced = PRICED_METALS.find(m => metalText.includes(m.keyword));
    if (!priced) {
      unpricedMetalCoinCount++;
      continue;
    }

    const entry = byMetal.get(priced.label) ?? { grams: 0, withWeight: 0, missingWeight: 0 };

    // A zero or negative weight is an ABSENT weight, not a measurement — the
    // same reading inventory-metrics.ts gives a zero spot price. No coin
    // weighs nothing, so a 0 here can only mean "never filled in".
    const pmWeight = coin.pmWeightGrams ?? 0;
    if (pmWeight > 0) {
      entry.grams += pmWeight;
      entry.withWeight++;
    } else {
      entry.missingWeight++;
    }

    byMetal.set(priced.label, entry);
  }

  const holdings: MetalHolding[] = [];
  for (const { label } of PRICED_METALS) {
    const entry = byMetal.get(label);
    if (!entry) continue;

    holdings.push({
      metal: label,
      // Null, not 0, when nothing could be weighed. See the header.
      pureGrams: entry.withWeight > 0 ? entry.grams : null,
      coinsWithWeight: entry.withWeight,
      coinsMissingWeight: entry.missingWeight
    });
  }

  return { holdings, unpricedMetalCoinCount, noMetalCoinCount };
}
