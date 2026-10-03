import { describe, expect, it } from 'vitest';
import {
  formatInventoryCell, formatMeltValue, inventoryColumnOrder
} from './inventory-columns';
import { CoinRecord, SpotPrices } from './coin.model';

describe('inventoryColumnOrder', () => {
  it('places Mint Mark immediately after Year', () => {
    expect(inventoryColumnOrder.indexOf('year')).toBeLessThan(inventoryColumnOrder.indexOf('mintMark'));
    expect(inventoryColumnOrder.indexOf('mintMark') - inventoryColumnOrder.indexOf('year')).toBe(1);
  });
});

/* ===========================================================================
 * The Melt Value column
 * ---------------------------------------------------------------------------
 * This column was a stub that returned a dash for every coin, no matter what.
 * These tests pin down the three things that matter now that it is real:
 *
 *   1. it shows a real figure, formatted like the other money columns;
 *   2. "cannot say" renders as the same em-dash the rest of the grid uses,
 *      and NEVER as "$0.00" — a missing weight or a missing spot price means
 *      unknown, not worthless; and
 *   3. purity is not applied twice. That was a live bug; see the comment at
 *      the `meltValue` case in inventory-columns.ts.
 * =========================================================================== */

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Half Dollar', year: '1964', coinType: 'Kennedy',
    category: 'Silver', country: 'United States', grade: 'MS65', certCompany: '',
    certNumber: '', variety: '', mintMark: 'P', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 10, currentValue: 15, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

const PRICES: SpotPrices = { gold: 2600, silver: 30, platinum: 950, copper: 4 };

describe('formatMeltValue', () => {
  it('renders a figure as currency to two decimals', () => {
    expect(formatMeltValue(1234.567)).toBe('$1234.57');
  });

  it('renders null as a dash, never as $0.00', () => {
    // null means "we cannot say", not "worth nothing".
    expect(formatMeltValue(null)).toBe('—');
  });

  it('still renders a genuine zero as currency', () => {
    // Only null is unknown. A computed 0 (which the arithmetic cannot
    // actually produce today) is a number and prints as one.
    expect(formatMeltValue(0)).toBe('$0.00');
  });
});

describe('formatInventoryCell — meltValue column', () => {
  it('shows the melt value of a coin with pure-metal weight and a priced metal', () => {
    // Exactly one troy ounce of pure silver at $30.
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('$30.00');
  });

  it('formats like the Purchase Price and Current Value columns', () => {
    const coin = makeCoin({
      metalContent: 'Gold', pmWeightGrams: 31.1035, purchasePrice: 30, currentValue: 30
    });
    const melt = formatInventoryCell(coin, 'meltValue', PRICES);

    expect(melt).toMatch(/^\$\d+\.\d{2}$/);
    expect(formatInventoryCell(coin, 'purchasePrice')).toMatch(/^\$\d+\.\d{2}$/);
    expect(formatInventoryCell(coin, 'currentValue')).toMatch(/^\$\d+\.\d{2}$/);
  });

  it('does NOT apply purity a second time', () => {
    // A 90% silver Walking Liberty half: 12.5 g gross, 11.25 g PURE silver.
    // pmWeightGrams already has purity baked in, so the answer is
    // (11.25 / 31.1035) * 30 = $10.85. The old doubled-discount bug gave
    // $9.77 — about 10% light. On a 40% Kennedy it was 60% light.
    const coin = makeCoin({ metalContent: '90% Silver', pmWeightGrams: 11.25, pmPercent: 90 });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('$10.85');
  });

  it('values a coin whose purity was never recorded', () => {
    // Purity is not an input to the arithmetic, so its absence must not
    // suppress an answer we can plainly give.
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035, pmPercent: undefined });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('$30.00');
  });

  it('shows a dash when no spot prices are passed in at all', () => {
    // The parameter is optional so existing callers keep compiling. Omitting
    // it is not a wrong answer: with no prices there is nothing to value the
    // metal at, which is exactly the "—" case.
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    expect(formatInventoryCell(coin, 'meltValue')).toBe('—');
  });

  it('shows a dash when no spot prices have been loaded', () => {
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    const noPrices: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };
    expect(formatInventoryCell(coin, 'meltValue', noPrices)).toBe('—');
  });

  it('shows a dash when this metal has no price even though others do', () => {
    // Per-metal partial failure is a real case: the four symbols are fetched
    // independently. Palladium-free platinum at 0 must read "—", not "$0.00".
    const coin = makeCoin({ metalContent: 'Platinum', pmWeightGrams: 31.1035 });
    expect(formatInventoryCell(coin, 'meltValue', { ...PRICES, platinum: 0 })).toBe('—');
  });

  it('shows a dash when the coin has no pure-metal weight', () => {
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: undefined });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('—');
  });

  it('shows a dash when the coin has no metal content', () => {
    const coin = makeCoin({ metalContent: '', pmWeightGrams: 31.1035 });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('—');
  });

  it('shows a dash for a base-metal coin', () => {
    // A clad quarter has no melt value worth quoting, and that is not a fault.
    const coin = makeCoin({ metalContent: 'Clad', pmWeightGrams: 5.67 });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('—');
  });

  it('uses the same dash as every other unknown cell', () => {
    const coin = makeCoin({ metalContent: '', pmWeightGrams: 0, grade: '' });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe(formatInventoryCell(coin, 'grade'));
  });

  it('leaves every other column untouched when prices are supplied', () => {
    // The third parameter is only read by the meltValue case; nothing else
    // may change behaviour because it is now present.
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    for (const column of inventoryColumnOrder) {
      if (column === 'meltValue') continue;
      expect(formatInventoryCell(coin, column, PRICES)).toBe(formatInventoryCell(coin, column));
    }
  });
});
