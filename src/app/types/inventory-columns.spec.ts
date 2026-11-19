import { describe, expect, it } from 'vitest';
import {
  certBadgeLabel, defaultVisibleColumns, formatInventoryCell, formatMeltValue,
  inventoryColumnLabels, inventoryColumnOrder
} from './inventory-columns';
import { CoinRecord, SpotPrices } from './coin.model';

describe('inventoryColumnOrder', () => {
  it('places Mint Mark immediately after Year', () => {
    expect(inventoryColumnOrder.indexOf('year')).toBeLessThan(inventoryColumnOrder.indexOf('mintMark'));
    expect(inventoryColumnOrder.indexOf('mintMark') - inventoryColumnOrder.indexOf('year')).toBe(1);
  });

  it('does not offer Source as a grid column', () => {
    // Source is still stored, filterable and exported; it is just not a grid column.
    expect([...inventoryColumnOrder]).not.toContain('source');
    expect(Object.keys(inventoryColumnLabels)).not.toContain('source');
    expect(defaultVisibleColumns).not.toContain('source');
  });

  it('still records where a coin came from, which is the point', () => {
    const coin = makeCoin({ source: 'quicken' });
    expect(coin.source).toBe('quicken');
  });

  it('agrees with its own label table, in both directions', () => {
    // Otherwise the picker could offer a column the grid cannot render.
    expect(Object.keys(inventoryColumnLabels).sort()).toEqual([...inventoryColumnOrder].sort());
  });
});

/*
 * Melt Value column: real figures formatted as currency, unknown shown as
 * '—' (never "$0.00"), and purity not applied twice.
 */

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
    // Only null is unknown; a number prints as currency.
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
    // pmWeightGrams already includes purity: (11.25 / 31.1035) * 30 = $10.85.
    const coin = makeCoin({ metalContent: '90% Silver', pmWeightGrams: 11.25, pmPercent: 90 });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('$10.85');
  });

  it('values a coin whose purity was never recorded', () => {
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035, pmPercent: undefined });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('$30.00');
  });

  it('shows a dash when no spot prices are passed in at all', () => {
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    expect(formatInventoryCell(coin, 'meltValue')).toBe('—');
  });

  it('shows a dash when no spot prices have been loaded', () => {
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    const noPrices: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };
    expect(formatInventoryCell(coin, 'meltValue', noPrices)).toBe('—');
  });

  it('shows a dash when this metal has no price even though others do', () => {
    // Metals are fetched independently, so one can be missing.
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
    const coin = makeCoin({ metalContent: 'Clad', pmWeightGrams: 5.67 });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe('—');
  });

  it('uses the same dash as every other unknown cell', () => {
    const coin = makeCoin({ metalContent: '', pmWeightGrams: 0, grade: '' });
    expect(formatInventoryCell(coin, 'meltValue', PRICES)).toBe(formatInventoryCell(coin, 'grade'));
  });

  it('leaves every other column untouched when prices are supplied', () => {
    // Only the meltValue case reads spot prices.
    const coin = makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 });
    for (const column of inventoryColumnOrder) {
      if (column === 'meltValue') continue;
      expect(formatInventoryCell(coin, column, PRICES)).toBe(formatInventoryCell(coin, column));
    }
  });
});

/*
 * Status and Storage columns. A missing status renders "Owned" (most coins
 * predate the field); a missing storage location is genuinely unknown: '—'.
 */

describe('the Status column', () => {
  it('is headed "Status"', () => {
    expect(inventoryColumnLabels.collectionStatus).toBe('Status');
  });

  it('shows the human label, not the stored token', () => {
    expect(formatInventoryCell(makeCoin({ collectionStatus: 'for-sale' }), 'collectionStatus'))
      .toBe('For Sale');
    expect(formatInventoryCell(makeCoin({ collectionStatus: 'wanted' }), 'collectionStatus'))
      .toBe('Wanted');
  });

  it('renders a coin with NO status as Owned, never as a dash', () => {
    const legacy = makeCoin();
    expect(legacy.collectionStatus).toBeUndefined();
    expect(formatInventoryCell(legacy, 'collectionStatus')).toBe('Owned');
    expect(formatInventoryCell(legacy, 'collectionStatus'))
      .not.toBe(formatInventoryCell(makeCoin({ grade: '' }), 'grade'));
  });

  it('is switched on by default', () => {
    // Defaults are unioned with saved preferences, so existing users get it too.
    expect(defaultVisibleColumns).toContain('collectionStatus');
  });

  it('appears exactly once in the canonical order', () => {
    expect(inventoryColumnOrder.filter(c => c === 'collectionStatus')).toHaveLength(1);
  });
});

describe('the Storage column', () => {
  it('is headed "Storage"', () => {
    // "Location" would read as country of origin.
    expect(inventoryColumnLabels.storageLocation).toBe('Storage');
  });

  it('shows the free text exactly as typed', () => {
    expect(formatInventoryCell(makeCoin({ storageLocation: 'Dansco 7070, page 4' }), 'storageLocation'))
      .toBe('Dansco 7070, page 4');
  });

  it('shows the ordinary dash when nothing has been recorded', () => {
    expect(formatInventoryCell(makeCoin(), 'storageLocation')).toBe('—');
    expect(formatInventoryCell(makeCoin({ storageLocation: '' }), 'storageLocation')).toBe('—');
  });

  it('is OFF by default', () => {
    expect(defaultVisibleColumns).not.toContain('storageLocation');
  });

  it('sits next to the Set column, which asks the other half of the question', () => {
    expect(inventoryColumnOrder.indexOf('storageLocation') - inventoryColumnOrder.indexOf('coinSet')).toBe(1);
  });
});

describe('the new columns keep every existing ordering invariant', () => {
  // Mint Mark after Year is asserted in the inventoryColumnOrder block above.

  it('leaves Cert immediately before Grade', () => {
    expect(inventoryColumnOrder.indexOf('grade') - inventoryColumnOrder.indexOf('certNumber')).toBe(1);
  });

  it('leaves the first four columns reading as a coin is described', () => {
    expect(inventoryColumnOrder.slice(0, 4)).toEqual(['year', 'mintMark', 'denomination', 'coinType']);
  });

  it('gives every column a label', () => {
    // The Record type enforces presence, but '' would still type-check.
    for (const column of inventoryColumnOrder) {
      expect(inventoryColumnLabels[column].trim()).not.toBe('');
    }
  });
});
