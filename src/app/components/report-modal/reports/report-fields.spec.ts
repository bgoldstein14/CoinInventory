/**
 * Pins which fields the insurance schedule withholds, and that new grid
 * columns reach the inventory listing but not the schedule.
 */
import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../../types/coin.model';
import {
  INSURANCE_REPORT_FIELDS,
  INSURANCE_WITHHELD_FIELDS,
  formatReportCell,
  inventoryReportFields,
  reportFieldLabel,
  reportFieldIsNumeric
} from './report-fields';
import {
  formatInventoryCell,
  inventoryColumnLabels,
  inventoryColumnOrder
} from '../../../types/inventory-columns';
import {
  DENOMINATION_LOOKUP,
  MEXICO_8_REALES
} from '../../../testing/denomination-lookup.fixture';

function coin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'c1', denomination: 'Dollar', year: '1881', coinType: 'Morgan Dollar',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: 'PCGS',
    certNumber: '12345678', variety: '', mintMark: 'S', composition: '90% Silver',
    purchaseDate: '2024-03-15', purchasePrice: 1250, currentValue: 1400,
    notes: 'Bought cheap from a confused dealer', imagePaths: [], source: 'manual',
    ...overrides
  };
}

describe('INSURANCE_REPORT_FIELDS', () => {
  it('identifies the coin and states its value', () => {
    for (const field of ['year', 'denomination', 'coinType', 'grade', 'currentValue']) {
      expect(INSURANCE_REPORT_FIELDS).toContain(field);
    }
  });

  it('carries the certification, which is what makes a value defensible', () => {
    expect(INSURANCE_REPORT_FIELDS).toContain('certCompany');
    expect(INSURANCE_REPORT_FIELDS).toContain('certNumber');
  });

  it('carries acquisition date and cost as evidence of value', () => {
    expect(INSURANCE_REPORT_FIELDS).toContain('purchaseDate');
    expect(INSURANCE_REPORT_FIELDS).toContain('purchasePrice');
  });

  it('withholds the owner private notes', () => {
    expect(INSURANCE_REPORT_FIELDS).not.toContain('notes');
    expect(INSURANCE_WITHHELD_FIELDS).toContain('notes');
  });

  it('withholds provenance and sale history', () => {
    for (const withheld of ['source', 'soldPrice', 'soldDate']) {
      expect(INSURANCE_REPORT_FIELDS).not.toContain(withheld);
      expect(INSURANCE_WITHHELD_FIELDS).toContain(withheld);
    }
  });

  it('lists nothing twice', () => {
    expect(new Set(INSURANCE_REPORT_FIELDS).size).toBe(INSURANCE_REPORT_FIELDS.length);
  });

  it('names only fields this report can actually render', () => {
    for (const field of INSURANCE_REPORT_FIELDS) {
      expect(formatReportCell(coin(), field)).not.toBe('');
      expect(reportFieldLabel(field)).not.toBe('');
    }
  });

  it('does NOT absorb a new grid column automatically', () => {
    const extras = (inventoryColumnOrder as readonly string[])
      .filter(column => !(INSURANCE_REPORT_FIELDS as readonly string[]).includes(column));
    expect(extras.length).toBeGreaterThan(0);
  });
});

describe('inventoryReportFields', () => {
  it('follows the columns the user has chosen to see', () => {
    expect(inventoryReportFields(['year', 'coinType', 'currentValue']))
      .toEqual(['year', 'coinType', 'currentValue']);
  });

  it('accepts EVERY column the grid knows about, including ones added later', () => {
    const all = inventoryReportFields([...inventoryColumnOrder]);
    expect(all).toEqual([...inventoryColumnOrder]);
    for (const field of all) {
      expect(reportFieldLabel(field)).not.toBe('');
    }
  });

  it('drops anything that is not a real column, rather than printing a blank one', () => {
    expect(inventoryReportFields(['year', 'thisWasDeletedTwoYearsAgo', 'grade'] as never[]))
      .toEqual(['year', 'grade']);
  });

  it('falls back to a readable default when the user has hidden everything', () => {
    const fallback = inventoryReportFields([]);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback).toContain('coinType');
  });
});

describe('reportFieldLabel', () => {
  it('spells out the abbreviations the grid uses to save width', () => {
    expect(reportFieldLabel('mintMark')).toBe('Mint Mark');
    expect(reportFieldLabel('denomination')).toBe('Denomination');
    expect(reportFieldLabel('certCompany')).toBe('Certified By');
    expect(reportFieldLabel('purchasePrice')).toBe('Purchase Price');
    expect(reportFieldLabel('currentValue')).toBe('Current Value');
  });

  it('reuses the grid label whenever it is already a full word', () => {
    expect(reportFieldLabel('grade')).toBe(inventoryColumnLabels.grade);
    expect(reportFieldLabel('country')).toBe(inventoryColumnLabels.country);
  });

  it('labels the report-only fields the grid has no column for', () => {
    expect(reportFieldLabel('purchaseDate')).toBe('Purchase Date');
    expect(reportFieldLabel('composition')).toBe('Composition');
  });
});

describe('formatReportCell', () => {
  it('reuses formatInventoryCell for anything the grid can already render', () => {
    expect(formatReportCell(coin({ currentValue: 1400 }), 'currentValue')).toBe('$1400.00');
    expect(formatReportCell(coin({ grade: '' }), 'grade')).toBe('—');
  });

  it('renders the melt value honestly when there is no spot price', () => {
    expect(formatReportCell(coin({ pmWeightGrams: 24, metalContent: 'Silver' }), 'meltValue')).toBe('—');
  });

  it('renders an UNRECORDED money value as a blank, not as $0.00', () => {
    // The grid prints `$0.00`; the report must match the total, which counts it as unknown.
    expect(formatReportCell(coin({ currentValue: 0 }), 'currentValue')).toBe('—');
    expect(formatReportCell(coin({ purchasePrice: 0 }), 'purchasePrice')).toBe('—');
  });

  it('still prints a recorded money value through the grid formatter', () => {
    expect(formatReportCell(coin({ purchasePrice: 1250 }), 'purchasePrice')).toBe('$1250.00');
  });

  it('renders the report-only fields', () => {
    expect(formatReportCell(coin({ purchaseDate: '2024-03-15' }), 'purchaseDate')).toBe('2024-03-15');
    expect(formatReportCell(coin({ purchaseDate: '' }), 'purchaseDate')).toBe('—');
    expect(formatReportCell(coin({ composition: '90% Silver' }), 'composition')).toBe('90% Silver');
  });
});

describe('reportFieldIsNumeric', () => {
  it('marks the money and weight columns so they can be right-aligned', () => {
    expect(reportFieldIsNumeric('currentValue')).toBe(true);
    expect(reportFieldIsNumeric('purchasePrice')).toBe(true);
    expect(reportFieldIsNumeric('meltValue')).toBe(true);
  });

  it('leaves text columns alone', () => {
    expect(reportFieldIsNumeric('coinType')).toBe(false);
    expect(reportFieldIsNumeric('year')).toBe(false);
  });
});

describe('formatReportCell passes the lookups through to the grid formatter', () => {
  const CATALOGS = [
    { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true }
  ];

  it('prints the catalogue NAME and number, not the bare number', () => {
    const ancient = coin({ catalogRefs: [{ catalogId: 1, catalogNumber: '6819' }] });
    expect(formatReportCell(ancient, 'catalogReference', undefined, CATALOGS))
      .toBe('Sear 6819');
  });

  it('still prints the number alone when no catalogue list is available', () => {
    const ancient = coin({ catalogRefs: [{ catalogId: 1, catalogNumber: '6819' }] });
    expect(formatReportCell(ancient, 'catalogReference')).toBe('6819');
  });

  it('prints the denomination the screen shows, resolving the id', () => {
    const imported = coin({ denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar' });
    expect(formatReportCell(imported, 'denomination', undefined, undefined, DENOMINATION_LOOKUP))
      .toBe('8 Reales');
  });

  it('agrees with the grid cell for every shape of denomination', () => {
    const coins = [
      coin({ denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar' }),
      coin({ denomination: 'Trade Dollar' }),
      coin({ denomination: 'Trime', country: 'United States' }),
      coin({ denomination: '' })
    ];
    for (const record of coins) {
      expect(formatReportCell(record, 'denomination', undefined, undefined, DENOMINATION_LOOKUP))
        .toBe(formatInventoryCell(record, 'denomination', undefined, undefined, DENOMINATION_LOOKUP));
    }
  });

  it('prints the plain text when no denominations list is available', () => {
    expect(formatReportCell(coin({ denomination: '2/-' }), 'denomination')).toBe('2 sh');
  });
});
