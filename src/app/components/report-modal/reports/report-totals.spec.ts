/**
 * report-totals.spec.ts
 *
 * A report that totals unknowns as zero understates an insurance claim.
 * Every case below is a variation on that: a value we do not know must be
 * COUNTED AS UNKNOWN, never silently folded into a sum as a zero.
 */
import { describe, expect, it } from 'vitest';
import { CoinRecord, SpotPrices } from '../../../types/coin.model';
import {
  formatHonestTotal,
  formatReportMoney,
  insuredValue,
  purchaseCost,
  reportMeltValue,
  sumKnown
} from './report-totals';

function coin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'c1', denomination: 'Dollar', year: '1881', coinType: 'Morgan Dollar',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: 'PCGS',
    certNumber: '12345678', variety: '', mintMark: 'S', composition: '90% Silver',
    purchaseDate: '2024-03-15', purchasePrice: 1250, currentValue: 1400,
    notes: '', imagePaths: [], source: 'manual',
    ...overrides
  };
}

const noPrices: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };
const silverOnly: SpotPrices = { gold: 0, silver: 30, platinum: 0, copper: 0 };

describe('sumKnown', () => {
  it('adds up the values it knows', () => {
    expect(sumKnown([100, 200, 50])).toEqual({ total: 350, counted: 3, unknown: 0 });
  });

  it('leaves unknowns OUT of the total and counts them separately', () => {
    // The headline behaviour. 1400 + unknown must not be 1400 + 0 reported as
    // if it were the whole answer.
    expect(sumKnown([1400, null, null, 600])).toEqual({ total: 2000, counted: 2, unknown: 2 });
  });

  it('reports an all-unknown list as zero counted rather than a zero total', () => {
    expect(sumKnown([null, null])).toEqual({ total: 0, counted: 0, unknown: 2 });
  });

  it('handles an empty list', () => {
    expect(sumKnown([])).toEqual({ total: 0, counted: 0, unknown: 0 });
  });

  it('keeps a genuine zero that was passed as a number, not as null', () => {
    // sumKnown itself takes no view on what "unknown" means — that is the
    // caller's job (insuredValue/purchaseCost below). A 0 handed to it is a
    // real 0 and must be counted.
    expect(sumKnown([0, 10])).toEqual({ total: 10, counted: 2, unknown: 0 });
  });
});

describe('insuredValue', () => {
  it('is the coin current value when one is recorded', () => {
    expect(insuredValue(coin({ currentValue: 1400 }))).toBe(1400);
  });

  it('is null — not 0 — when no value has been recorded', () => {
    // This app stores "not recorded" as 0, so there is no way to tell a
    // genuine zero from a blank. For an insurance schedule the honest answer
    // is "unknown", because calling it $0 understates the claim.
    expect(insuredValue(coin({ currentValue: 0 }))).toBeNull();
  });

  it('is null for a negative value, which cannot be a real appraisal', () => {
    expect(insuredValue(coin({ currentValue: -5 }))).toBeNull();
  });
});

describe('purchaseCost', () => {
  it('is the purchase price when one is recorded', () => {
    expect(purchaseCost(coin({ purchasePrice: 1250 }))).toBe(1250);
  });

  it('is null when no cost has been recorded', () => {
    expect(purchaseCost(coin({ purchasePrice: 0 }))).toBeNull();
  });
});

describe('reportMeltValue', () => {
  it('is null when there are no spot prices at all', () => {
    expect(reportMeltValue(coin({ pmWeightGrams: 24.06, metalContent: 'Silver' }), undefined)).toBeNull();
  });

  it('is null when the metal has no loaded price', () => {
    expect(reportMeltValue(coin({ pmWeightGrams: 24.06, metalContent: 'Silver' }), noPrices)).toBeNull();
  });

  it('delegates to computeMeltValue rather than redoing the arithmetic', () => {
    // 24.06 g of pure silver at $30/troy oz = 24.06 / 31.1035 * 30.
    // Purity must NOT be applied a second time — see inventory-metrics.ts.
    const value = reportMeltValue(coin({ pmWeightGrams: 24.06, metalContent: 'Silver', pmPercent: 90 }), silverOnly);
    expect(value).toBeCloseTo((24.06 / 31.1035) * 30, 6);
  });
});

describe('formatReportMoney', () => {
  it('groups thousands, because a printed grand total is read by eye', () => {
    expect(formatReportMoney(1234567.5)).toBe('$1,234,567.50');
  });

  it('always shows two decimal places', () => {
    expect(formatReportMoney(40)).toBe('$40.00');
  });
});

describe('formatHonestTotal', () => {
  it('states the amount and how many coins are behind it', () => {
    const line = formatHonestTotal({ total: 2000, counted: 2, unknown: 0 }, 'Current Value');
    expect(line.amountText).toBe('$2,000.00');
    expect(line.basis).toBe('2 coins');
    expect(line.caveat).toBeNull();
  });

  it('names the excluded coins loudly when some value is unknown', () => {
    const line = formatHonestTotal({ total: 2000, counted: 2, unknown: 3 }, 'Current Value');
    expect(line.amountText).toBe('$2,000.00');
    expect(line.basis).toBe('2 coins');
    expect(line.caveat).toContain('3 coins');
    expect(line.caveat).toContain('Current Value');
    expect(line.caveat).toContain('NOT included');
  });

  it('uses the singular for exactly one excluded coin', () => {
    const line = formatHonestTotal({ total: 10, counted: 1, unknown: 1 }, 'Current Value');
    expect(line.basis).toBe('1 coin');
    expect(line.caveat).toContain('1 coin,');
    expect(line.caveat).toContain('that coin is NOT included');
    expect(line.caveat).not.toContain('1 coins');
    expect(line.caveat).not.toContain('those coins');
  });

  it('lets the caller say WHY a value is missing, not just that it is', () => {
    // "no Melt Value recorded" is wrong: nobody records a melt value, it is
    // calculated from the coin's metal and today's spot price. Telling the
    // reader to go and fill in a field that does not exist would send them
    // looking for a box that is not there.
    const line = formatHonestTotal({ total: 10, counted: 1, unknown: 2 }, 'Melt Value', 'calculable for');
    expect(line.caveat).toContain('Melt Value');
    expect(line.caveat).toContain('calculable');
    expect(line.caveat).not.toContain('recorded');
  });

  it('never renders an all-unknown total as a confident figure', () => {
    const line = formatHonestTotal({ total: 0, counted: 0, unknown: 4 }, 'Current Value');
    expect(line.amountText).toBe('—');
    expect(line.caveat).toContain('4 coins');
  });
});
