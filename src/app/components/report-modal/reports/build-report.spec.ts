/**
 * build-report.spec.ts
 *
 * The report CONTENT lives in these pure builders precisely so it can be
 * tested here. This suite runs under Node with no jsdom, so nothing below
 * renders anything — it asserts on which rows, which columns, which totals,
 * and what has been left out and why. The template that turns a
 * ReportDocument into a printable page is deliberately thin (report-html.ts).
 */
import { describe, expect, it } from 'vitest';
import { CoinRecord, SpotPrices } from '../../../types/coin.model';
import { buildInsuranceReport, buildInventoryReport } from './build-report';
import {
  DENOMINATION_LOOKUP,
  MEXICO_8_REALES
} from '../../../testing/denomination-lookup.fixture';

/** A fixed local date, so the formatted stamp is the same in every timezone. */
const GENERATED_AT = new Date(2026, 10, 8, 14, 30);

const silverOnly: SpotPrices = { gold: 0, silver: 30, platinum: 0, copper: 0 };

function coin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'c1', denomination: 'Dollar', year: '1881', coinType: 'Morgan Dollar',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: 'PCGS',
    certNumber: '12345678', variety: '', mintMark: 'S', composition: '90% Silver',
    purchaseDate: '2024-03-15', purchasePrice: 1250, currentValue: 1400,
    notes: 'PRIVATE: bought from a confused dealer', imagePaths: [], source: 'manual',
    ...overrides
  };
}

function cellsOf(doc: { columns: { key: string }[]; rows: { cells: string[] }[] }, field: string, rowIndex = 0): string {
  const index = doc.columns.findIndex(column => column.key === field);
  expect(index, `report has no ${field} column`).toBeGreaterThanOrEqual(0);
  return doc.rows[rowIndex].cells[index];
}

describe('buildInsuranceReport', () => {
  it('is a dated, titled document', () => {
    const doc = buildInsuranceReport({ coins: [coin()], generatedAt: GENERATED_AT });
    expect(doc.kind).toBe('insurance');
    expect(doc.title).toContain('Insurance');
    expect(doc.generatedAt).toContain('2026');
    expect(doc.generatedAt).toContain('November');
    // A non-technical reader has to be able to tell what the document is for
    // without asking anybody.
    expect(doc.purpose.length).toBeGreaterThan(20);
  });

  it('writes one row per coin, carrying the identifying details', () => {
    const doc = buildInsuranceReport({ coins: [coin(), coin({ id: 'c2' })], generatedAt: GENERATED_AT });
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows[0].coinId).toBe('c1');
    expect(cellsOf(doc, 'coinType')).toBe('Morgan Dollar');
    expect(cellsOf(doc, 'grade')).toBe('MS63');
    expect(cellsOf(doc, 'currentValue')).toBe('$1400.00');
  });

  it('NEVER puts the owner private notes on the page', () => {
    const doc = buildInsuranceReport({ coins: [coin()], generatedAt: GENERATED_AT });
    expect(doc.columns.map(column => column.key)).not.toContain('notes');
    for (const row of doc.rows) {
      for (const cell of row.cells) expect(cell).not.toContain('PRIVATE');
    }
  });

  it('lists only the coins actually in the collection, and says what it dropped', () => {
    // Possession, not title. A want-list coin is not in the house, and a
    // schedule that insures it buys cover on property the owner does not own.
    // The rule is isHeldInCollection() in types/collection-status.ts — the
    // SAME one exportInsuranceCsv uses, so the two schedules cannot disagree
    // about what "my collection" means.
    //
    // Dropping them silently would be its own bug: the owner counts 4 coins
    // on screen and 2 on the schedule with no way to find out why.
    const doc = buildInsuranceReport({
      coins: [
        coin({ id: 'c1', collectionStatus: 'owned' }),
        coin({ id: 'c2', collectionStatus: 'for-sale' }),
        coin({ id: 'c3', collectionStatus: 'wanted' }),
        coin({ id: 'c4', collectionStatus: 'sold' })
      ],
      generatedAt: GENERATED_AT
    });

    // Owned and For Sale are both physically on the shelf.
    expect(doc.rows.map(row => row.coinId)).toEqual(['c1', 'c2']);

    expect(doc.exclusions).toEqual([
      { reason: 'Wanted — not in the collection, so not insurable', count: 1 },
      { reason: 'Sold — not in the collection, so not insurable', count: 1 }
    ]);
  });

  it('keeps a coin with an old sold PRICE whose status still says owned', () => {
    // collection-status.ts is explicit that nothing derives the status from
    // soldDate — a sale can fall through. The schedule must follow the
    // owner's dropdown and not second-guess it from a stale number.
    const doc = buildInsuranceReport({
      coins: [coin({ id: 'c1', soldPrice: 900, soldDate: '2025-02-01' })],
      generatedAt: GENERATED_AT
    });
    expect(doc.rows).toHaveLength(1);
    expect(doc.exclusions).toEqual([]);
  });

  it('treats a coin with no status at all as owned', () => {
    // A coin with no collection status reads as owned. If those dropped
    // out, the schedule would empty itself for anyone who has never touched
    // the field.
    const withoutStatus = coin({ id: 'c1' });
    delete (withoutStatus as unknown as Record<string, unknown>)['collectionStatus'];
    const doc = buildInsuranceReport({ coins: [withoutStatus], generatedAt: GENERATED_AT });
    expect(doc.rows).toHaveLength(1);
  });

  it('records no exclusion when nothing was excluded', () => {
    const doc = buildInsuranceReport({ coins: [coin()], generatedAt: GENERATED_AT });
    expect(doc.exclusions).toEqual([]);
  });

  it('totals the stated values and EXCLUDES the coins with none', () => {
    // The whole reason this feature exists. 1400 + 600, with two unvalued
    // coins reported as unknown rather than quietly added as $0.00.
    const doc = buildInsuranceReport({
      coins: [
        coin({ id: 'c1', currentValue: 1400 }),
        coin({ id: 'c2', currentValue: 600 }),
        coin({ id: 'c3', currentValue: 0 }),
        coin({ id: 'c4', currentValue: 0 })
      ],
      generatedAt: GENERATED_AT
    });

    const total = doc.totals.find(entry => /insured/i.test(entry.label));
    expect(total).toBeDefined();
    expect(total!.amount).toEqual({ total: 2000, counted: 2, unknown: 2 });
    expect(total!.caveat).toContain('2 coins');
    expect(total!.caveat).toContain('NOT included');
  });

  it('still lists an unvalued coin, showing a blank rather than a zero', () => {
    const doc = buildInsuranceReport({ coins: [coin({ currentValue: 0 })], generatedAt: GENERATED_AT });
    expect(doc.rows).toHaveLength(1);
    expect(cellsOf(doc, 'currentValue')).toBe('—');
  });

  it('adds a melt-value total when spot prices are loaded, with its own unknown count', () => {
    const doc = buildInsuranceReport({
      coins: [
        coin({ id: 'c1', pmWeightGrams: 24.06, metalContent: 'Silver' }),
        coin({ id: 'c2' }) // no precious metal — melt is genuinely unknowable
      ],
      generatedAt: GENERATED_AT,
      spotPrices: silverOnly
    });

    const melt = doc.totals.find(entry => /melt/i.test(entry.label));
    expect(melt).toBeDefined();
    expect(melt!.amount.counted).toBe(1);
    expect(melt!.amount.unknown).toBe(1);
    // A melt value is CALCULATED, never recorded. Saying "not recorded"
    // would send the reader looking for a field that does not exist.
    expect(melt!.caveat).toContain('calculable');
    expect(melt!.caveat).not.toContain('recorded');
    expect(melt!.amount.total).toBeCloseTo((24.06 / 31.1035) * 30, 6);
  });

  it('omits the melt total altogether when no spot price has ever been loaded', () => {
    // A melt column of nothing but dashes is noise on a printed page.
    const doc = buildInsuranceReport({ coins: [coin()], generatedAt: GENERATED_AT });
    expect(doc.totals.some(entry => /melt/i.test(entry.label))).toBe(false);
    expect(doc.columns.some(column => column.key === 'meltValue')).toBe(false);
  });

  it('attaches the photographs it was given, by coin id', () => {
    const doc = buildInsuranceReport({
      coins: [coin({ id: 'c1' }), coin({ id: 'c2' })],
      generatedAt: GENERATED_AT,
      images: new Map([['c1', ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']]])
    });
    expect(doc.rows[0].images).toEqual(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']);
    expect(doc.rows[1].images).toEqual([]);
    expect(doc.hasImages).toBe(true);
  });

  it('knows when no photographs were included at all', () => {
    const doc = buildInsuranceReport({ coins: [coin()], generatedAt: GENERATED_AT });
    expect(doc.hasImages).toBe(false);
  });

  it('copes with an empty collection without pretending the total is real', () => {
    const doc = buildInsuranceReport({ coins: [], generatedAt: GENERATED_AT });
    expect(doc.rows).toEqual([]);
    const total = doc.totals.find(entry => /insured/i.test(entry.label))!;
    expect(total.amount).toEqual({ total: 0, counted: 0, unknown: 0 });
  });
});

describe('buildInventoryReport', () => {
  it('keeps the order it is given, because that is the user current sort', () => {
    // The caller hands over filters.filteredInventory(), which is already
    // filtered and sorted. Re-sorting here would quietly contradict the screen
    // the user is looking at.
    const doc = buildInventoryReport({
      coins: [coin({ id: 'c3' }), coin({ id: 'c1' }), coin({ id: 'c2' })],
      generatedAt: GENERATED_AT
    });
    expect(doc.rows.map(row => row.coinId)).toEqual(['c3', 'c1', 'c2']);
  });

  it('uses the columns the user has visible in the grid', () => {
    const doc = buildInventoryReport({
      coins: [coin()],
      generatedAt: GENERATED_AT,
      fields: ['year', 'coinType', 'currentValue']
    });
    expect(doc.columns.map(column => column.key)).toEqual(['year', 'coinType', 'currentValue']);
  });

  it('records the active filter so a printed page is not mistaken for the whole collection', () => {
    const doc = buildInventoryReport({
      coins: [coin()],
      generatedAt: GENERATED_AT,
      scopeNote: 'Category: Silver'
    });
    expect(doc.scopeNote).toBe('Category: Silver');
  });

  it('totals cost and value, each with its own unknown count', () => {
    const doc = buildInventoryReport({
      coins: [
        coin({ id: 'c1', purchasePrice: 100, currentValue: 150 }),
        coin({ id: 'c2', purchasePrice: 0, currentValue: 40 })
      ],
      generatedAt: GENERATED_AT
    });

    const cost = doc.totals.find(entry => /cost/i.test(entry.label))!;
    expect(cost.amount).toEqual({ total: 100, counted: 1, unknown: 1 });

    const value = doc.totals.find(entry => /value/i.test(entry.label))!;
    expect(value.amount).toEqual({ total: 190, counted: 2, unknown: 0 });
  });

  it('includes coins the insurance schedule would drop', () => {
    // This one is a listing of what is on record, not of what is insurable.
    // A want list and a sold coin are both part of the record.
    const doc = buildInventoryReport({
      coins: [coin(), coin({ id: 'c2', collectionStatus: 'sold' }), coin({ id: 'c3', collectionStatus: 'wanted' })],
      generatedAt: GENERATED_AT
    });
    expect(doc.rows).toHaveLength(3);
    expect(doc.exclusions).toEqual([]);
  });

  it('is titled and dated like the other report', () => {
    const doc = buildInventoryReport({ coins: [], generatedAt: GENERATED_AT });
    expect(doc.kind).toBe('inventory');
    expect(doc.title).toContain('Inventory');
    expect(doc.generatedAt).toContain('2026');
    expect(doc.purpose.length).toBeGreaterThan(20);
  });
});

/*
 * THE LOOKUPS A DOCUMENT NEEDS
 *
 * A printed report has to say the same thing the screen says. Two of its
 * columns cannot be produced from the coin record alone — the catalogue
 * reference needs the Catalogs lookup and the denomination needs the
 * Denominations lookup — so both have to reach the row builder. They stay
 * optional: without them the document prints the bare stored values.
 */

describe('report documents carry the screen\u2019s denomination and catalogue', () => {
  it('prints the denomination the grid shows on an insurance schedule', () => {
    const doc = buildInsuranceReport({
      coins: [coin({ denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar' })],
      generatedAt: GENERATED_AT,
      denominations: DENOMINATION_LOOKUP
    });
    expect(cellsOf(doc, 'denomination')).toBe('8 Reales');
  });

  it('prints the denomination the grid shows on an inventory listing', () => {
    const doc = buildInventoryReport({
      coins: [coin({ denomination: 'Trade Dollar' })],
      generatedAt: GENERATED_AT,
      fields: ['year', 'denomination'],
      denominations: DENOMINATION_LOOKUP
    });
    expect(cellsOf(doc, 'denomination')).toBe('Other (Trade Dollar)');
  });

  it('prints the catalogue name beside the number when the listing shows it', () => {
    // Without the lookup reaching formatReportCell the grid prints "Sear
    // 6819" and the report prints "6819".
    const doc = buildInventoryReport({
      coins: [coin({ catalogId: 1, catalogNumber: '6819' })],
      generatedAt: GENERATED_AT,
      fields: ['catalogReference'],
      catalogs: [{ catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true }]
    });
    expect(cellsOf(doc, 'catalogReference')).toBe('Sear 6819');
  });

  it('falls back to the plain column when no lookups are supplied', () => {
    const doc = buildInsuranceReport({
      coins: [coin({ denomination: '2/-' })],
      generatedAt: GENERATED_AT
    });
    expect(cellsOf(doc, 'denomination')).toBe('2 sh');
  });
});
