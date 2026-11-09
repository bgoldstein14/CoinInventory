 /*
 * collection-totals.ts — the headline figures, with their gaps attached.
 * ---- WHY EVERY TOTAL IS A TRIPLE AND NOT A NUMBER ----
 * The obvious way to write a totals panel is the way the existing Reports
 * dialog writes it:
 *
 *     const totalValue = inv.reduce((s, c) => s + c.currentValue, 0);
 *
 * On a collection where 31 of 125 coins have never been appraised, that line
 * produces a number that LOOKS like the value of 125 coins and is actually
 * the value of 94, understated by an unknown amount. Nothing on screen says
 * so. The reader has no way to find out.
 *
 * So every measure here is `{ total, knownCount, unknownCount }`:
 *
 *     total         the sum over the coins that HAVE the figure,
 *                   or null when not one of them does
 *     knownCount    how many coins that was
 *     unknownCount  how many coins were left out, so the view can say
 *                   "across 94 of 125 coins" in plain words underneath
 *
 * This is the project's own governing rule, stated at the top of
 * services/pm-reference.ts and enforced in `computeMeltValue`, applied to
 * sums instead of to single cells: a visible blank beats a silently wrong
 * number, because the blank is something the owner can go and fix.
 *
 * ---- "A ZERO IS NOT A PRICE" — THE JUDGEMENT CALL THIS FILE TURNS ON ----
 * `purchasePrice` and `currentValue` are non-optional `number` fields, so
 * there is no null to read. A coin that was never priced holds 0, and so does
 * a coin genuinely recorded as free. The schema cannot tell them apart.
 *
 * inventory-metrics.ts already rules on the identical ambiguity for spot
 * prices — "A ZERO IS NOT A PRICE — IT IS THE ABSENCE OF ONE" — and the same
 * reasoning holds here: nobody keeps a coin they believe to be worth nothing,
 * and a cost of exactly $0.00 on a coin you own is far more often an empty
 * field than a gift. So a non-positive figure is read as ABSENT.
 *
 * Being read as absent does NOT hide the coin. It is still in `coinCount`,
 * and it is counted in `unknownCount`, so the gap is on screen rather than
 * folded into the total as a zero.
 *
 * The cost of the call: a genuinely free coin is reported as "cost not
 * recorded" rather than "$0.00". That is the safer error of the two — it
 * invites the owner to look, where the other invites nobody to look — and it
 * is the direct consequence of a schema that cannot say "nil" out loud. A
 * nullable price column would end the ambiguity; see the project report.
 *
 * ---- WHY GAIN/LOSS IS ITS OWN MEASURE AND NOT value.total - cost.total ----
 * Those two totals are sums over two DIFFERENT populations. Subtracting the
 * cost of 112 coins from the value of 94 is not the gain on anything. Gain is
 * therefore computed coin by coin, over only the coins that know both halves,
 * and the percentage uses that same subset's cost as its denominator.
  */

import { CoinRecord, SpotPrices } from '../../types/coin.model';
import { computeMeltValue } from '../inventory/inventory-metrics';

/**
 * A sum, plus how much of the collection it actually covers.
 *
 * `total` is null — "we cannot say" — rather than 0 when `knownCount` is 0.
 */
export interface MeasureTotal {
  total: number | null;
  knownCount: number;
  unknownCount: number;
}

export interface CollectionTotals {
  /** Every coin on hand, whatever is or is not recorded about it. */
  coinCount: number;
  /** What the collection cost: the sum of recorded purchase prices. */
  cost: MeasureTotal;
  /** What it is worth today: the sum of recorded current values. */
  currentValue: MeasureTotal;
  /** Unrealised gain/loss, over the coins that know BOTH cost and value. */
  gainLoss: MeasureTotal;
  /**
   * That same gain as a percentage of the same coins' cost — or null when
   * those coins cost nothing, because a return on zero is not a number.
   */
  gainLossPercent: number | null;
  /** Melt value of the pure precious metal held, at today's spot prices. */
  melt: MeasureTotal;
  /** Proceeds actually realised: the sum of recorded sold prices. */
  realised: MeasureTotal;
}

/** An accumulator that turns into a MeasureTotal at the end. */
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

  /** The sum so far, or null if nothing was ever added. Not for display. */
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
 * A money figure off a coin record, or null when it was never recorded.
 *
 * Non-positive means absent — see the header. A negative cannot be reached
 * through the UI at all (the editor's number inputs are the only writers),
 * but a hand-edited JSON import can carry one, and a negative silently
 * subtracting from a total is precisely the kind of invisible wrongness this
 * whole file exists to refuse.
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

  // The denominator for gainLossPercent: the cost of exactly the coins that
  // contributed to gainLoss, not of every coin with a recorded cost.
  let comparableCost = 0;

  for (const coin of coins) {
    const paid = recordedAmount(coin.purchasePrice);
    const worth = recordedAmount(coin.currentValue);

    cost.add(paid);
    currentValue.add(worth);
    realised.add(recordedAmount(coin.soldPrice));

    // computeMeltValue already returns null for "cannot say" — no PM weight,
    // no metal, or no spot price for that metal. Delegating to it is what
    // keeps the melt TOTAL and the melt COLUMN from ever disagreeing, and it
    // is the only place the purity-applied-twice bug can be re-introduced.
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
