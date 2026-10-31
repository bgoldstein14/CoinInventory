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

/* ===========================================================================
 * The "Certified By" column
 * ---------------------------------------------------------------------------
 * The owner asked to see the grading COMPANY to the left of the grade, in a
 * narrow column headed "Certified By".
 *
 * The obvious-looking shortcut was to reuse the existing `certNumber` column,
 * which already sits next to Grade. These tests exist partly to rule that out
 * and keep it ruled out: `certNumber` renders a BADGE carrying company AND
 * number ("PCGS #12345678"), it is off by default, and some users will already
 * have switched it on and be relying on seeing the number. Narrowing it to
 * just the company would silently take away data they had asked for.
 *
 * So `certCompany` is its own column, and the pair of them must stay
 * distinguishable: one is the company alone, the other is the full slab label.
 * =========================================================================== */

describe('the Certified By column', () => {
  it(`is headed "Cert. By"`, () => {
    // Not "Cert" (that header belongs to the certNumber badge column) and not
    // "Company", which says nothing about coins.
    expect(inventoryColumnLabels.certCompany).toBe("Cert. By");
  });

  it('shows the grading company on its own, with no cert number', () => {
    const coin = makeCoin({ certCompany: 'NGC', certNumber: '9000002-001' });
    expect(formatInventoryCell(coin, 'certCompany')).toBe('NGC');
  });

  it('is NOT the same thing as the Cert column, even for the same coin', () => {
    // The whole justification for adding a column rather than repurposing one.
    // If these two ever render the same string, one of them is redundant and
    // somebody has quietly broken the other.
    const coin = makeCoin({ certCompany: 'PCGS', certNumber: '12345678' });

    expect(formatInventoryCell(coin, 'certCompany')).toBe('PCGS');
    expect(formatInventoryCell(coin, 'certNumber')).toContain('12345678');
    expect(certBadgeLabel(coin)).toBe('PCGS #12345678');
  });

  it('shows the usual dash for a raw (uncertified) coin', () => {
    // Most coins in a collection are raw. An empty cell would read as a bug;
    // the em-dash is how every other unknown cell in this grid says "nothing
    // recorded".
    const coin = makeCoin({ certCompany: '', certNumber: '' });
    expect(formatInventoryCell(coin, 'certCompany')).toBe('—');
  });

  it('shows the company even when the slab number was never typed in', () => {
    // A perfectly normal half-entered record: the user knows it is in an NGC
    // holder but has not keyed the number. The company is still true.
    const coin = makeCoin({ certCompany: 'NGC', certNumber: '' });
    expect(formatInventoryCell(coin, 'certCompany')).toBe('NGC');
  });

  it('is switched on by default', () => {
    // "We need to show the certification company" — a column the user has to
    // go and find in the Columns picker is not shown.
    expect(defaultVisibleColumns).toContain('certCompany');
  });

  it('appears exactly once in the canonical order', () => {
    expect(inventoryColumnOrder.filter(c => c === 'certCompany')).toHaveLength(1);
  });

  it('sits to the LEFT of Grade', () => {
    // The literal request.
    expect(inventoryColumnOrder.indexOf('certCompany'))
      .toBeLessThan(inventoryColumnOrder.indexOf('grade'));
  });

  it('sits immediately before the Cert column, which keeps Cert next to Grade', () => {
    // WHY NOT DIRECTLY BEFORE `grade`?
    // Because `certNumber` is already there, and "certNumber immediately
    // precedes grade" is itself an owner-stated invariant with tests of its
    // own (see inventory-columns.store.spec.ts). Wedging the new column into
    // that gap would have broken it.
    //
    // Putting Certified By immediately before Cert satisfies BOTH: the two
    // cert columns form one block that ends flush against Grade, and because
    // Cert is off by default, the column the user actually sees to the left of
    // Grade is Certified By — exactly what was asked for. See the default
    // visible order test in inventory-columns.store.spec.ts.
    expect(inventoryColumnOrder.indexOf('certNumber') - inventoryColumnOrder.indexOf('certCompany')).toBe(1);
    expect(inventoryColumnOrder.indexOf('grade') - inventoryColumnOrder.indexOf('certNumber')).toBe(1);
  });

  it('does not come between Year and Mint Mark', () => {
    // The oldest ordering invariant in this file. Any insertion has to be
    // checked against it, because the failure is silent: "1916" and "D" simply
    // drift apart.
    expect(inventoryColumnOrder.indexOf('mintMark') - inventoryColumnOrder.indexOf('year')).toBe(1);
  });
});
