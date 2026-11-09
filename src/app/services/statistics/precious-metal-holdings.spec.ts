 /*
 * precious-metal-holdings.spec.ts
 *
 * "How much gold do I actually hold?" is the question a bullion-minded
 * collector asks first, and it is the one most easily answered wrongly,
 * because there are THREE weights on a coin record and only one of them is
 * the right one:
 *
 *     weight            gross — the whole coin, alloy included
 *     pmPercent         the fineness
 *     pmWeightGrams     the PURE precious metal — THIS one
 *
 * pm-reference.ts works the example through on a $20 Saint-Gaudens: 33.436 g
 * gross, 90% fine, 30.09 g of actual gold. Summing `weight` would overstate
 * the holding by the alloy; multiplying `pmWeightGrams` by `pmPercent` would
 * understate it by the purity a second time — the exact bug that was fixed in
 * computeMeltValue and is documented at length in inventory-columns.ts.
 *
 * The other half of these tests is the honest gap: `pmWeightGrams` is
 * optional and frequently blank. A coin recorded as "Gold" with no weight is
 * NOT zero grams of gold. It is a coin whose gold weight is unknown, and the
 * panel has to say so.
  */

import { describe, expect, it } from 'vitest';
import { statsCoin } from '../../testing/stats-coins.fixture';
import { computePreciousMetalHoldings, gramsToTroyOunces } from './precious-metal-holdings';

describe('gramsToTroyOunces', () => {
  it('uses the same 31.1035 the melt maths uses', () => {
    expect(gramsToTroyOunces(31.1035)).toBeCloseTo(1, 12);
    expect(gramsToTroyOunces(30.09)).toBeCloseTo(0.96742, 5);
  });

  it('maps zero to zero', () => {
    expect(gramsToTroyOunces(0)).toBe(0);
  });
});

describe('computePreciousMetalHoldings — the empty collection', () => {
  it('reports no holdings and no gaps', () => {
    const held = computePreciousMetalHoldings([]);
    expect(held.holdings).toEqual([]);
    expect(held.unpricedMetalCoinCount).toBe(0);
    expect(held.noMetalCoinCount).toBe(0);
  });
});

describe('computePreciousMetalHoldings — the pure weight', () => {
  it('sums pmWeightGrams and NOT the gross weight', () => {
    const saint = statsCoin({
      metalContent: 'Gold',
      weight: 33.436,       // gross — must be ignored
      pmWeightGrams: 30.09, // pure — the answer
      pmPercent: 90
    });

    const held = computePreciousMetalHoldings([saint]);
    const gold = held.holdings.find(h => h.metal === 'Gold');

    expect(gold?.pureGrams).toBeCloseTo(30.09, 10);
  });

  it('does NOT apply pmPercent a second time', () => {
    // 30.09 * 0.90 = 27.081. If this test ever sees 27.081 the purity bug is
    // back; see inventory-metrics.ts.
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Gold', pmWeightGrams: 30.09, pmPercent: 90 })
    ]);
    expect(held.holdings[0].pureGrams).not.toBeCloseTo(27.081, 3);
    expect(held.holdings[0].pureGrams).toBeCloseTo(30.09, 10);
  });

  it('adds up several coins of the same metal', () => {
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Silver', pmWeightGrams: 24.057 }),
      statsCoin({ metalContent: 'Silver', pmWeightGrams: 24.057 }),
      statsCoin({ metalContent: '90% Silver', pmWeightGrams: 11.25 })
    ]);
    const silver = held.holdings.find(h => h.metal === 'Silver');

    expect(silver?.pureGrams).toBeCloseTo(59.364, 10);
    expect(silver?.coinsWithWeight).toBe(3);
  });

  it('matches the metal by keyword exactly as computeMeltValue does', () => {
    // "90% Silver", "Silver (.900)" and "silver" are all silver, because
    // computeMeltValue tests with `metal.includes('silver')`. If these two
    // ever disagree, a coin can have a melt value and no holding, or the
    // reverse.
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Silver (.900 fine)', pmWeightGrams: 10 }),
      statsCoin({ metalContent: 'silver', pmWeightGrams: 5 })
    ]);
    expect(held.holdings).toHaveLength(1);
    expect(held.holdings[0].pureGrams).toBeCloseTo(15, 10);
  });

  it('keeps the four priced metals apart and in the melt-value test order', () => {
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Copper', pmWeightGrams: 3 }),
      statsCoin({ metalContent: 'Platinum', pmWeightGrams: 31.1035 }),
      statsCoin({ metalContent: 'Silver', pmWeightGrams: 20 }),
      statsCoin({ metalContent: 'Gold', pmWeightGrams: 8 })
    ]);
    expect(held.holdings.map(h => h.metal)).toEqual(['Gold', 'Silver', 'Platinum', 'Copper']);
  });

  it('omits a metal nobody in the collection holds, rather than showing it at zero', () => {
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Gold', pmWeightGrams: 8 })
    ]);
    expect(held.holdings.map(h => h.metal)).toEqual(['Gold']);
  });
});

describe('computePreciousMetalHoldings — the honest gaps', () => {
  it('counts a gold coin with no PM weight as unknown, NOT as zero grams', () => {
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Gold', pmWeightGrams: 31.1035 }),
      statsCoin({ metalContent: 'Gold' })
    ]);
    const gold = held.holdings[0];

    expect(gold.pureGrams).toBeCloseTo(31.1035, 10);
    expect(gold.coinsWithWeight).toBe(1);
    expect(gold.coinsMissingWeight).toBe(1);
  });

  it('gives a NULL weight when a metal is held but no coin of it has a weight', () => {
    // Three gold coins, none weighed. "0.00 g of gold" would be a flat lie
    // about a collection that might hold a kilo.
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Gold' }),
      statsCoin({ metalContent: 'Gold' }),
      statsCoin({ metalContent: 'Gold' })
    ]);

    expect(held.holdings).toHaveLength(1);
    expect(held.holdings[0].pureGrams).toBeNull();
    expect(held.holdings[0].coinsMissingWeight).toBe(3);
  });

  it('treats a zero or negative PM weight as absent, not as a measurement', () => {
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Silver', pmWeightGrams: 0 }),
      statsCoin({ metalContent: 'Silver', pmWeightGrams: -1 })
    ]);
    expect(held.holdings[0].pureGrams).toBeNull();
    expect(held.holdings[0].coinsMissingWeight).toBe(2);
  });

  it('counts a coin whose metal is recorded but unpriceable separately', () => {
    // Palladium is in the app's metal list and has no spot price, so it can
    // never produce a melt value. It is not a gap in the data; it is a gap in
    // the app, and the two read differently to a user.
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Palladium', pmWeightGrams: 31.1 }),
      statsCoin({ metalContent: 'Bronze' })
    ]);

    expect(held.holdings).toEqual([]);
    expect(held.unpricedMetalCoinCount).toBe(2);
  });

  it('counts a coin with no metal recorded at all separately again', () => {
    const held = computePreciousMetalHoldings([statsCoin(), statsCoin({ metalContent: '  ' })]);
    expect(held.noMetalCoinCount).toBe(2);
    expect(held.unpricedMetalCoinCount).toBe(0);
  });

  it('keeps the three populations disjoint so they can be added up on screen', () => {
    const coins = [
      statsCoin({ metalContent: 'Gold', pmWeightGrams: 8 }),
      statsCoin({ metalContent: 'Gold' }),
      statsCoin({ metalContent: 'Nickel' }),
      statsCoin()
    ];
    const held = computePreciousMetalHoldings(coins);
    const inHoldings = held.holdings.reduce(
      (sum, h) => sum + h.coinsWithWeight + h.coinsMissingWeight,
      0
    );

    expect(inHoldings + held.unpricedMetalCoinCount + held.noMetalCoinCount).toBe(coins.length);
  });
});

describe('computePreciousMetalHoldings — extremes', () => {
  it('handles a bullion hoard without losing precision', () => {
    const coins = Array.from({ length: 500 }, () =>
      statsCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 })
    );
    expect(computePreciousMetalHoldings(coins).holdings[0].pureGrams)
      .toBeCloseTo(15551.75, 6);
  });

  it('handles a gold fleck of a hundredth of a gram', () => {
    const held = computePreciousMetalHoldings([
      statsCoin({ metalContent: 'Gold', pmWeightGrams: 0.01 })
    ]);
    expect(held.holdings[0].pureGrams).toBeCloseTo(0.01, 12);
  });
});
