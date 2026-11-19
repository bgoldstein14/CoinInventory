 /*
  * Headline totals for the statistics view.
  *
  * Every measure is `{ total, knownCount, unknownCount }`:
  *   total         sum over the coins that have the figure, or null if none do
  *   knownCount    how many coins contributed
  *   unknownCount  how many were left out, so the view can say "across 94 of 125 coins"
  * A plain sum would silently understate the total for unappraised coins.
  *
  * `purchasePrice` and `currentValue` are non-optional numbers, so an unpriced
  * coin holds 0. A non-positive amount is therefore treated as absent (the same
  * rule inventory-metrics.ts applies to spot prices). The coin still counts in
  * `coinCount` and `unknownCount`. A genuinely free coin shows as "not recorded".
  *
  * Gain/loss is computed per coin over coins with both cost and value, and its
  * percentage uses those same coins' cost; subtracting the two totals would mix
  * different populations.
  */

import { CoinRecord, SpotPrices } from '../../types/coin.model';
import { computeMeltValue } from '../inventory/inventory-metrics';

/** A sum plus how much of the collection it covers; `total` is null when `knownCount` is 0. */
export interface MeasureTotal {
  total: number | null;
  knownCount: number;
  unknownCount: number;
}

export interface CollectionTotals {
  /** Every coin on hand. */
  coinCount: number;
  /** Sum of recorded purchase prices. */
  cost: MeasureTotal;
  /** Sum of recorded current values. */
  currentValue: MeasureTotal;
  /** Unrealised gain/loss over coins with both cost and value. */
  gainLoss: MeasureTotal;
  /** Gain as a percentage of those coins' cost; null when that cost is 0. */
  gainLossPercent: number | null;
  /** Melt value of the pure precious metal held, at current spot prices. */
  melt: MeasureTotal;
  /** Sum of recorded sold prices. */
  realised: MeasureTotal;
}

/** Accumulator that becomes a MeasureTotal. */
class Measure {
  private sum = 0;
  private known = 0;
  private unknown = 0;

  add(value: number | null): void {
    if (value === null) {
      this.unknown++;
      return;
    }
    this.sum += value;
    this.known++;
  }

  /** The sum so far, or null if nothing was added. Not for display. */
  get rawTotal(): number | null {
    return this.known > 0 ? this.sum : null;
  }

  get knownCount(): number {
    return this.known;
  }

  result(): MeasureTotal {
    return {
      total: this.rawTotal,
      knownCount: this.known,
      unknownCount: this.unknown
    };
  }
}

/**
 * A money figure from a coin record, or null if not recorded. Non-positive is
 * treated as absent (a negative can only come from a hand-edited import).
 */
function recordedAmount(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function computeCollectionTotals(
  coins: readonly CoinRecord[],
  prices: SpotPrices
): CollectionTotals {
  const cost = new Measure();
  const currentValue = new Measure();
  const gainLoss = new Measure();
  const melt = new Measure();
  const realised = new Measure();

  // Denominator for gainLossPercent: cost of exactly the coins in gainLoss.
  let comparableCost = 0;

  for (const coin of coins) {
    const paid = recordedAmount(coin.purchasePrice);
    const worth = recordedAmount(coin.currentValue);

    cost.add(paid);
    currentValue.add(worth);
    realised.add(recordedAmount(coin.soldPrice));

    // computeMeltValue returns null when it can't say; reusing it keeps the melt
    // total consistent with the grid's melt column.
    melt.add(computeMeltValue(coin, prices));

    if (paid !== null && worth !== null) {
      gainLoss.add(worth - paid);
      comparableCost += paid;
    } else {
      gainLoss.add(null);
    }
  }

  const gain = gainLoss.rawTotal;
  const gainLossPercent =
    gain !== null && comparableCost > 0 ? (gain / comparableCost) * 100 : null;

  return {
    coinCount: coins.length,
    cost: cost.result(),
    currentValue: currentValue.result(),
    gainLoss: gainLoss.result(),
    gainLossPercent,
    melt: melt.result(),
    realised: realised.result()
  };
}
