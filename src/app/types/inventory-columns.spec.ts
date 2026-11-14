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
    /* `Coins.Source` ('quicken', 'csv', 'manual') says where a ROW came
     * from, which is a fact about the import and not about the coin. It is
     * still written on every record, still filterable from the filter bar's
     * Source dropdown, still a CSV export column and still queryable in the
     * database; it simply stopped being one of the boxes in the Columns
     * panel, in a grid where every offered column costs width the money
     * columns need.
     *
     * This array is the whole mechanism -- the picker lists it, the store
     * sorts by it, and a stored preference is filtered against it -- so a
     * user who had Source ticked loses the tick on his next load with no
     * migration. */
    expect([...inventoryColumnOrder]).not.toContain('source');
    expect(Object.keys(inventoryColumnLabels)).not.toContain('source');
    expect(defaultVisibleColumns).not.toContain('source');
  });

  it('still records where a coin came from, which is the point', () => {
    /* The column went; the DATA did not. If this ever fails, the removal
     * has gone further than it was meant to. */
    const coin = makeCoin({ source: 'quicken' });
    expect(coin.source).toBe('quicken');
  });

  it('agrees with its own label table, in both directions', () => {
    // A column with no header, or a header with no column, is how the
    // picker ends up offering something the grid cannot render.
    expect(Object.keys(inventoryColumnLabels).sort()).toEqual([...inventoryColumnOrder].sort());
  });
});

/*
 * The Melt Value column
 * This column was a stub that returned a dash for every coin, no matter what.
 * These tests pin down the three things that matter now that it is real:
 *
 *   1. it shows a real figure, formatted like the other money columns;
 *   2. "cannot say" renders as the same em-dash the rest of the grid uses,
 *      and NEVER as "$0.00" — a missing weight or a missing spot price means
 *      unknown, not worthless; and
 *   3. purity is not applied twice. That was a live bug; see the comment at
 *      the `meltValue` case in inventory-columns.ts.
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

/*
 * The Status and Storage columns
 * Status is the grid's half of the want-list feature. The thing these tests
 * are really guarding is not the column's position but its EMPTY CASE: every
 * coin in the database predates the field, so the overwhelmingly common input
 * to this cell is `undefined`, and it must render "Owned". If it rendered the
 * em-dash the rest of the grid uses for unknowns, the owner would open the app
 * and see a gap in the record of every coin he has.
 *
 * Storage is the opposite: it genuinely is unknown until he types it, so it
 * takes the ordinary dash.
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
    // The pre-feature coin. This is the whole point.
    const legacy = makeCoin();
    expect(legacy.collectionStatus).toBeUndefined();
    expect(formatInventoryCell(legacy, 'collectionStatus')).toBe('Owned');
    expect(formatInventoryCell(legacy, 'collectionStatus'))
      .not.toBe(formatInventoryCell(makeCoin({ grade: '' }), 'grade'));
  });

  it('is switched on by default', () => {
    // A hidden Status column would make a wanted coin indistinguishable from
    // an owned one in the grid — which is the exact confusion the feature
    // exists to remove. Being in this list is also what makes it reach
    // EXISTING users: the columns store unions a saved preference with these
    // defaults, so no migration is needed.
    expect(defaultVisibleColumns).toContain('collectionStatus');
  });

  it('appears exactly once in the canonical order', () => {
    expect(inventoryColumnOrder.filter(c => c === 'collectionStatus')).toHaveLength(1);
  });
});

describe('the Storage column', () => {
  it('is headed "Storage"', () => {
    // Not "Location", which in a grid that already has a Country column reads
    // as "where in the world is this coin from".
    expect(inventoryColumnLabels.storageLocation).toBe('Storage');
  });

  it('shows the free text exactly as typed', () => {
    expect(formatInventoryCell(makeCoin({ storageLocation: 'Dansco 7070, page 4' }), 'storageLocation'))
      .toBe('Dansco 7070, page 4');
  });

  it('shows the ordinary dash when nothing has been recorded', () => {
    // Unlike Status, this one really is unknown until the user says.
    expect(formatInventoryCell(makeCoin(), 'storageLocation')).toBe('—');
    expect(formatInventoryCell(makeCoin({ storageLocation: '' }), 'storageLocation')).toBe('—');
  });

  it('is OFF by default', () => {
    // Long free text in a dense grid. Available in the Columns picker for
    // anyone who wants it, but it does not push the money columns off screen
    // for everybody else.
    expect(defaultVisibleColumns).not.toContain('storageLocation');
  });

  it('sits next to the Set column, which asks the other half of the question', () => {
    // Set = which grouping this coin belongs to; Storage = which shelf it is
    // on. Two different questions about organisation, so they read together.
    expect(inventoryColumnOrder.indexOf('storageLocation') - inventoryColumnOrder.indexOf('coinSet')).toBe(1);
  });
});

describe('the new columns keep every existing ordering invariant', () => {
  // Mint Mark immediately after Year is asserted by
  // `inventoryColumnOrder > places Mint Mark immediately after Year`, over
  // the same module constant, so it is not restated here.

  it('leaves Cert immediately before Grade', () => {
    // The long-standing invariant: the slab's certification and the grade
    // printed on that slab read as one idea, so they sit together.
    expect(inventoryColumnOrder.indexOf('grade') - inventoryColumnOrder.indexOf('certNumber')).toBe(1);
  });

  it('leaves the first four columns reading as a coin is described', () => {
    expect(inventoryColumnOrder.slice(0, 4)).toEqual(['year', 'mintMark', 'denomination', 'coinType']);
  });

  it('gives every column a label', () => {
    // The Record<InventoryColumn, string> type enforces this at compile time,
    // but a label of '' would type-check and render an empty header.
    for (const column of inventoryColumnOrder) {
      expect(inventoryColumnLabels[column].trim()).not.toBe('');
    }
  });
});
