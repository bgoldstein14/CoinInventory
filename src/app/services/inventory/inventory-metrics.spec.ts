 /*
  * The money totals and collection status. Want-list coins must not inflate the
  * collection's value, and coins with no status (everything from before the
  * feature) must still count.
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
    // A 1913 Liberty nickel on the want list must not add millions to the total.
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
    // Until it is sold, a for-sale coin is still held and counts.
    const coins = [
      makeCoin({ purchasePrice: 100, currentValue: 150 }),
      makeCoin({ collectionStatus: 'for-sale', purchasePrice: 20, currentValue: 30 })
    ];

    expect(sumCurrentValue(coins)).toBe(180);
    expect(sumPurchasePrice(coins)).toBe(120);
    expect(sumProfit(coins)).toBe(60);
  });

  it('DOES count a coin with no status at all', () => {
    // Coins from before collection status existed.
    const coins = [makeCoin({ purchasePrice: 100, currentValue: 150 })];
    expect(coins[0].collectionStatus).toBeUndefined();

    expect(sumCurrentValue(coins)).toBe(150);
    expect(sumPurchasePrice(coins)).toBe(100);
    expect(sumProfit(coins)).toBe(50);
  });

  it('DOES count a coin whose status is unrecognised', () => {
    // An unknown status (future build or typo) is read as owned.
    const coins = [makeCoin({ collectionStatus: 'bequeathed' as CollectionStatus, currentValue: 150 })];
    expect(sumCurrentValue(coins)).toBe(150);
  });

  it('is unchanged for a collection where every coin is explicitly owned', () => {
    // The state migration 010 leaves databases in: no total may change.
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
    // These lists feed the filters, so want-list coins must appear in them.
    const coins = [
      makeCoin({ category: 'Silver' }),
      makeCoin({ category: 'Type Set', collectionStatus: 'wanted' })
    ];

    expect(distinctCategories(coins)).toEqual(['Silver', 'Type Set']);
  });
});

describe('melt value is a fact about the coin, not about owning it', () => {
  it('prices a wanted coin exactly as it prices an owned one', () => {
    // Melt value is shown for want-list coins too (useful when bidding); only the
    // totals exclude them.
    const owned = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    const wanted = makeCoin({
      metalContent: 'Silver', pmWeightGrams: 31.1035, collectionStatus: 'wanted'
    });

    expect(computeMeltValue(wanted, PRICES)).toBe(computeMeltValue(owned, PRICES));
    expect(computeMeltValue(wanted, PRICES)).toBeCloseTo(30, 4);
  });
});
