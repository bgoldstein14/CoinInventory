 /*
  * Each measure is a {total, knownCount, unknownCount} triple, with `total`
  * null rather than 0 when nothing is known (see collection-totals.ts).
  */

import { describe, expect, it } from 'vitest';
import { statsCoin } from '../../testing/stats-coins.fixture';
import { computeCollectionTotals } from './collection-totals';
import { SpotPrices } from '../../types/coin.model';

const NO_PRICES: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };
const PRICES: SpotPrices = { gold: 2650, silver: 31, platinum: 980, copper: 4.2 };

describe('computeCollectionTotals — the empty collection', () => {
  it('reports no coins and NO totals at all, rather than a screen of $0.00', () => {
    const totals = computeCollectionTotals([], PRICES);

    expect(totals.coinCount).toBe(0);
    expect(totals.cost.total).toBeNull();
    expect(totals.currentValue.total).toBeNull();
    expect(totals.gainLoss.total).toBeNull();
    expect(totals.melt.total).toBeNull();
    expect(totals.realised.total).toBeNull();
    expect(totals.gainLossPercent).toBeNull();
  });

  it('reports zero known and zero unknown — nothing is missing from nothing', () => {
    const totals = computeCollectionTotals([], PRICES);
    expect(totals.cost.knownCount).toBe(0);
    expect(totals.cost.unknownCount).toBe(0);
  });
});

describe('computeCollectionTotals — one coin', () => {
  it('sums a single fully recorded coin', () => {
    const totals = computeCollectionTotals(
      [statsCoin({ purchasePrice: 100, currentValue: 175 })],
      PRICES
    );

    expect(totals.coinCount).toBe(1);
    expect(totals.cost.total).toBe(100);
    expect(totals.currentValue.total).toBe(175);
    expect(totals.gainLoss.total).toBe(75);
    expect(totals.gainLossPercent).toBeCloseTo(75, 10);
  });
});

describe('computeCollectionTotals — a zero price is an ABSENT price', () => {
   /*
    * A 0 current value means "never appraised": the coin is excluded from the
    * total but still counted in `coinCount` and `unknownCount`.
    */

  it('excludes an unpriced coin from the value total and counts it as unknown', () => {
    const totals = computeCollectionTotals(
      [
        statsCoin({ purchasePrice: 100, currentValue: 150 }),
        statsCoin({ purchasePrice: 200, currentValue: 260 }),
        statsCoin({ purchasePrice: 0, currentValue: 0 })
      ],
      PRICES
    );

    expect(totals.coinCount).toBe(3);
    expect(totals.currentValue.total).toBe(410);
    expect(totals.currentValue.knownCount).toBe(2);
    expect(totals.currentValue.unknownCount).toBe(1);
    expect(totals.cost.total).toBe(300);
    expect(totals.cost.knownCount).toBe(2);
    expect(totals.cost.unknownCount).toBe(1);
  });

  it('refuses a gain figure for a coin that knows only half the sum', () => {
    // Cost recorded, never appraised: must not read as a -$100 loss.
    const totals = computeCollectionTotals(
      [statsCoin({ purchasePrice: 100, currentValue: 0 })],
      PRICES
    );

    expect(totals.gainLoss.total).toBeNull();
    expect(totals.gainLoss.knownCount).toBe(0);
    expect(totals.gainLoss.unknownCount).toBe(1);
  });

  it('refuses a gain figure for an appraised coin whose cost was never recorded', () => {
    // The reverse: a 0 cost must not read as 100% profit.
    const totals = computeCollectionTotals(
      [statsCoin({ purchasePrice: 0, currentValue: 500 })],
      PRICES
    );

    expect(totals.gainLoss.total).toBeNull();
    expect(totals.gainLoss.unknownCount).toBe(1);
  });

  it('computes gain only over the coins that know BOTH halves', () => {
    const totals = computeCollectionTotals(
      [
        statsCoin({ purchasePrice: 100, currentValue: 150 }), // +50, counted
        statsCoin({ purchasePrice: 400, currentValue: 300 }), // -100, counted
        statsCoin({ purchasePrice: 50, currentValue: 0 }),    // skipped
        statsCoin({ purchasePrice: 0, currentValue: 80 })     // skipped
      ],
      PRICES
    );

    expect(totals.gainLoss.total).toBe(-50);
    expect(totals.gainLoss.knownCount).toBe(2);
    expect(totals.gainLoss.unknownCount).toBe(2);
  });

  it('bases the gain PERCENTAGE on the same coins as the gain, not on every coin', () => {
    // Cost of the comparable pair is 500 and gain -50, so -10% (not -50/550).
    const totals = computeCollectionTotals(
      [
        statsCoin({ purchasePrice: 100, currentValue: 150 }),
        statsCoin({ purchasePrice: 400, currentValue: 300 }),
        statsCoin({ purchasePrice: 50, currentValue: 0 })
      ],
      PRICES
    );

    expect(totals.gainLoss.total).toBe(-50);
    expect(totals.gainLossPercent).toBeCloseTo(-10, 10);
  });

  it('gives no percentage when the comparable coins cost nothing to buy', () => {
    // All gifts, all appraised: a gain but no cost to express it as a percentage of.
    const totals = computeCollectionTotals(
      [statsCoin({ purchasePrice: 0, currentValue: 80 })],
      PRICES
    );
    expect(totals.gainLossPercent).toBeNull();
  });
});

describe('computeCollectionTotals — an all-blank collection', () => {
  it('reports every money total as unknown and names how many coins are blank', () => {
    const totals = computeCollectionTotals(
      [statsCoin(), statsCoin(), statsCoin()],
      PRICES
    );

    expect(totals.coinCount).toBe(3);
    expect(totals.cost.total).toBeNull();
    expect(totals.cost.unknownCount).toBe(3);
    expect(totals.currentValue.total).toBeNull();
    expect(totals.currentValue.unknownCount).toBe(3);
    expect(totals.melt.total).toBeNull();
    expect(totals.melt.unknownCount).toBe(3);
    expect(totals.gainLoss.total).toBeNull();
  });
});

describe('computeCollectionTotals — melt value', () => {
  const goldEagle = statsCoin({
    metalContent: 'Gold',
    pmWeightGrams: 31.1035,
    purchasePrice: 1800,
    currentValue: 2700
  });
  const cladQuarter = statsCoin({ metalContent: 'Clad', purchasePrice: 1, currentValue: 2 });
  const weightlessSilver = statsCoin({ metalContent: 'Silver', purchasePrice: 20, currentValue: 25 });

  it('sums only the coins computeMeltValue can actually price', () => {
    const totals = computeCollectionTotals([goldEagle, cladQuarter, weightlessSilver], PRICES);

    // Exactly one troy ounce of gold at $2,650.
    expect(totals.melt.total).toBeCloseTo(2650, 6);
    expect(totals.melt.knownCount).toBe(1);
    expect(totals.melt.unknownCount).toBe(2);
  });

  it('refuses the whole melt total when no spot price has been loaded', () => {
    // No spot prices: unknown, not $0.00.
    const totals = computeCollectionTotals([goldEagle], NO_PRICES);

    expect(totals.melt.total).toBeNull();
    expect(totals.melt.knownCount).toBe(0);
    expect(totals.melt.unknownCount).toBe(1);
  });

  it('delegates to computeMeltValue rather than re-deriving purity', () => {
    // pmWeightGrams is already the pure silver weight; don't apply pmPercent again.
    const morgan = statsCoin({
      metalContent: 'Silver',
      pmWeightGrams: 24.057,
      pmPercent: 90
    });
    const totals = computeCollectionTotals([morgan], PRICES);

    expect(totals.melt.total).toBeCloseTo((24.057 / 31.1035) * 31, 9);
  });
});

describe('computeCollectionTotals — realised proceeds', () => {
  it('sums sold prices and counts the coins that were never sold as unknown', () => {
    const totals = computeCollectionTotals(
      [
        statsCoin({ soldPrice: 500 }),
        statsCoin({ soldPrice: 250 }),
        statsCoin()
      ],
      PRICES
    );

    expect(totals.realised.total).toBe(750);
    expect(totals.realised.knownCount).toBe(2);
    expect(totals.realised.unknownCount).toBe(1);
  });

  it('gives no realised total at all when nothing has been sold', () => {
    const totals = computeCollectionTotals([statsCoin(), statsCoin()], PRICES);
    expect(totals.realised.total).toBeNull();
  });
});

describe('computeCollectionTotals — extreme values', () => {
  it('holds cent precision on a collection worth tens of millions', () => {
    const coins = Array.from({ length: 1000 }, () =>
      statsCoin({ purchasePrice: 12345.67, currentValue: 23456.78 })
    );
    const totals = computeCollectionTotals(coins, PRICES);

    expect(totals.cost.total).toBeCloseTo(12345670, 2);
    expect(totals.currentValue.total).toBeCloseTo(23456780, 2);
    expect(totals.gainLoss.total).toBeCloseTo(11111110, 2);
  });

  it('handles a sub-cent coin without rounding it out of existence', () => {
    const totals = computeCollectionTotals(
      [statsCoin({ purchasePrice: 0.01, currentValue: 0.02 })],
      PRICES
    );
    expect(totals.cost.total).toBeCloseTo(0.01, 10);
    expect(totals.gainLoss.total).toBeCloseTo(0.01, 10);
  });

  it('reports a collection that lost money as a negative, not an absolute', () => {
    const totals = computeCollectionTotals(
      [statsCoin({ purchasePrice: 5000, currentValue: 1200 })],
      PRICES
    );
    expect(totals.gainLoss.total).toBe(-3800);
    expect(totals.gainLossPercent).toBeCloseTo(-76, 10);
  });

  it('ignores a negative price as nonsense rather than subtracting it', () => {
    // Only a hand-edited import can produce a negative; it must not reduce the total.
    const totals = computeCollectionTotals(
      [statsCoin({ purchasePrice: -100, currentValue: 50 })],
      PRICES
    );
    expect(totals.cost.total).toBeNull();
    expect(totals.cost.unknownCount).toBe(1);
  });
});
