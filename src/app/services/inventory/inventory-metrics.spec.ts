 /*
 * inventory-metrics.spec.ts — the money totals, and what a want list does
 * to them.
 * ---- WHAT THESE TESTS ARE REALLY ABOUT ----
 * Collection status lets the owner record coins he does NOT have. The moment
 * that is possible, "what is my collection worth" stops being "add up the
 * rows" — a want list full of the coins he is dreaming about would report a
 * collection several times larger than the one in his safe, and it would look
 * entirely plausible. That is the failure these tests exist to prevent.
 *
 * The opposite failure is just as bad and is why half of what follows is about
 * coins with NO status: every coin that predates this feature has none, and if
 * any of them stopped counting, the owner's collection would quietly shrink
 * overnight with no error to explain it.
  */

import { describe, expect, it } from 'vitest';
import {
  computeMeltValue,
  distinctCategories,
  sumCurrentValue,
  sumProfit,
  sumPurchasePrice
} from './inventory-metrics';
import { CoinRecord, SpotPrices } from '../../types/coin.model';
import { CollectionStatus } from '../../types/collection-status';

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: crypto.randomUUID(), denomination: 'Dollar', year: '1881', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: '',
    certNumber: '', variety: '', mintMark: 'S', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 100, currentValue: 150, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

const PRICES: SpotPrices = { gold: 2600, silver: 30, platinum: 950, copper: 4 };

describe('the totals count only coins actually in the collection', () => {
  it('ignores a wanted coin, however expensive', () => {
    // The headline case. A 1913 Liberty nickel on the want list must not make
    // the collection appear to be worth five million dollars.
    const coins = [
      makeCoin({ purchasePrice: 100, currentValue: 150 }),
      makeCoin({ collectionStatus: 'wanted', purchasePrice: 0, currentValue: 5_000_000 })
    ];

    expect(sumCurrentValue(coins)).toBe(150);
    expect(sumPurchasePrice(coins)).toBe(100);
    expect(sumProfit(coins)).toBe(50);
  });

  it('ignores an ordered coin — paid for is not the same as in hand', () => {
    const coins = [
      makeCoin({ purchasePrice: 100, currentValue: 150 }),
      makeCoin({ collectionStatus: 'ordered', purchasePrice: 900, currentValue: 1000 })
    ];

    expect(sumCurrentValue(coins)).toBe(150);
    expect(sumPurchasePrice(coins)).toBe(100);
  });

  it('ignores a sold coin', () => {
    const coins = [
      makeCoin({ purchasePrice: 100, currentValue: 150 }),
      makeCoin({ collectionStatus: 'sold', purchasePrice: 40, currentValue: 70 })
    ];

    expect(sumCurrentValue(coins)).toBe(150);
    expect(sumPurchasePrice(coins)).toBe(100);
  });

  it('DOES count a coin that is for sale', () => {
    // Until somebody actually buys it, it is still on the shelf and still
    // worth what it is worth.
    const coins = [
      makeCoin({ purchasePrice: 100, currentValue: 150 }),
      makeCoin({ collectionStatus: 'for-sale', purchasePrice: 20, currentValue: 30 })
    ];

    expect(sumCurrentValue(coins)).toBe(180);
    expect(sumPurchasePrice(coins)).toBe(120);
    expect(sumProfit(coins)).toBe(60);
  });

  it('DOES count a coin with no status at all', () => {
    // Every coin that existed before this feature. If this ever fails, the
    // owner's whole collection drops out of his totals.
    const coins = [makeCoin({ purchasePrice: 100, currentValue: 150 })];
    expect(coins[0].collectionStatus).toBeUndefined();

    expect(sumCurrentValue(coins)).toBe(150);
    expect(sumPurchasePrice(coins)).toBe(100);
    expect(sumProfit(coins)).toBe(50);
  });

  it('DOES count a coin whose status is unrecognised', () => {
    // A status written by a future build, or a typo that survived an import.
    // The safe reading is that the owner has the coin.
    const coins = [makeCoin({ collectionStatus: 'bequeathed' as CollectionStatus, currentValue: 150 })];
    expect(sumCurrentValue(coins)).toBe(150);
  });

  it('is unchanged for a collection where every coin is explicitly owned', () => {
    // The state migration 010 leaves every existing database in. The day this
    // feature ships, no total anywhere may move.
    const withStatus = [
      makeCoin({ collectionStatus: 'owned', purchasePrice: 10, currentValue: 25 }),
      makeCoin({ collectionStatus: 'owned', purchasePrice: 30, currentValue: 40 })
    ];
    const withoutStatus = [
      makeCoin({ purchasePrice: 10, currentValue: 25 }),
      makeCoin({ purchasePrice: 30, currentValue: 40 })
    ];

    expect(sumCurrentValue(withStatus)).toBe(sumCurrentValue(withoutStatus));
    expect(sumPurchasePrice(withStatus)).toBe(sumPurchasePrice(withoutStatus));
    expect(sumProfit(withStatus)).toBe(sumProfit(withoutStatus));
  });

  it('totals an empty collection as zero rather than throwing', () => {
    expect(sumCurrentValue([])).toBe(0);
    expect(sumPurchasePrice([])).toBe(0);
    expect(sumProfit([])).toBe(0);
  });
});

describe('the filter dropdowns still see every coin', () => {
  it('lists the category of a wanted coin', () => {
    // These lists exist so the user can FILTER, and filtering to "show me my
    // want list" is the first thing he will do. Hiding a want-list coin's
    // category would make its own coins unreachable through the category
    // filter. Status changes what a coin is WORTH to the collection, not
    // whether it exists.
    const coins = [
      makeCoin({ category: 'Silver' }),
      makeCoin({ category: 'Type Set', collectionStatus: 'wanted' })
    ];

    expect(distinctCategories(coins)).toEqual(['Silver', 'Type Set']);
  });
});

describe('melt value is a fact about the coin, not about owning it', () => {
  it('prices a wanted coin exactly as it prices an owned one', () => {
    // Deliberate: when deciding what to bid on a coin you do NOT have, its
    // melt floor is the single most useful number on the screen. Blanking it
    // out for want-list coins would remove the figure precisely where it
    // matters most. The want list is kept out of the TOTALS; it is not
    // censored row by row.
    const owned = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    const wanted = makeCoin({
      metalContent: 'Silver', pmWeightGrams: 31.1035, collectionStatus: 'wanted'
    });

    expect(computeMeltValue(wanted, PRICES)).toBe(computeMeltValue(owned, PRICES));
    expect(computeMeltValue(wanted, PRICES)).toBeCloseTo(30, 4);
  });
});
