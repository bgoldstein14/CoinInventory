 /*
  * Pure precious metal held, by metal.
  *
  *     weight          gross weight of the whole coin
  *     pmPercent       fineness
  *     pmWeightGrams   pure precious metal  <- the only one used here
  *
  * Example: a 1927 $20 Saint-Gaudens weighs 33.436 g, is 90% fine, and contains
  * 30.09 g of gold (0.9675 ozt AGW). Multiplying pmWeightGrams by pmPercent
  * would apply the purity twice.
  *
  * `pmWeightGrams` is often blank. A metal whose coins are all unweighed reports
  * `pureGrams: null`, and every metal reports how many coins it couldn't weigh.
  *
  * Metals are recognised by the same substrings, in the same order, as
  * computeMeltValue (gold, silver, platinum, copper), so the holdings and the
  * melt total cover the same coins.
  */

import { CoinRecord } from '../../types/coin.model';
import { GRAMS_PER_TROY_OZ } from '../inventory/inventory-metrics';

/**
 * Priced metals and the substring each is recognised by. Must match
 * PRICED_METALS in inventory-metrics.ts (same keywords, same order).
 */
const PRICED_METALS: ReadonlyArray<{ keyword: string; label: string }> = [
  { keyword: 'gold', label: 'Gold' },
  { keyword: 'silver', label: 'Silver' },
  { keyword: 'platinum', label: 'Platinum' },
  { keyword: 'copper', label: 'Copper' }
];

/** Grams to troy ounces (the unit spot prices are quoted in). */
export function gramsToTroyOunces(grams: number): number {
  return grams / GRAMS_PER_TROY_OZ;
}

export interface MetalHolding {
  /** "Gold", "Silver", "Platinum", "Copper". */
  metal: string;
  /** Total pure metal in grams, or null when no coin of this metal has a weight. */
  pureGrams: number | null;
  /** Coins of this metal that contributed a weight. */
  coinsWithWeight: number;
  /** Coins of this metal without a usable `pmWeightGrams`. */
  coinsMissingWeight: number;
}

export interface PreciousMetalHoldings {
  /**
   * One entry per priced metal present in the collection, in computeMeltValue's
   * order. Metals not held are omitted rather than shown at zero.
   */
  holdings: MetalHolding[];
  /**
   * Coins whose recorded metal the app doesn't price (palladium, bronze, clad...).
   * Separate from missing data because the user can't fix it.
   */
  unpricedMetalCoinCount: number;
  /** Coins with no Metal Content recorded (the user can fix these). */
  noMetalCoinCount: number;
}

/**
 * Pure precious metal held, by metal. The populations in `holdings`,
 * `unpricedMetalCoinCount` and `noMetalCoinCount` are disjoint and cover every coin.
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

    // A zero or negative weight means "not filled in".
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
      // Null, not 0, when nothing could be weighed.
      pureGrams: entry.withWeight > 0 ? entry.grams : null,
      coinsWithWeight: entry.withWeight,
      coinsMissingWeight: entry.missingWeight
    });
  }

  return { holdings, unpricedMetalCoinCount, noMetalCoinCount };
}
