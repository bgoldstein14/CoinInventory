/*
 * report-fields.ts — WHICH COLUMNS EACH REPORT PRINTS, AND WHY THEY DIFFER.
 *
 *   THE INSURANCE SCHEDULE is read by somebody outside the household. Its job
 *   is to identify each coin well enough that a loss adjuster can recognise
 *   it, and to state what it is worth and why that figure is believable. That
 *   is a CURATED list, written out below and changed only on purpose.
 *
 *   THE INVENTORY LISTING is the owner's own collection on paper. Its job is
 *   to show what is on screen, so it follows the grid: the columns the user
 *   has ticked, in the order the grid shows them.
 *
 * WHAT AN INSURANCE SCHEDULE MUST NOT CONTAIN. `notes` is the obvious one: a
 * free-text field the owner writes for himself ("think this is a fake",
 * "worth more than I told the wife") and is about to hand to an insurer. It
 * is withheld, and the withholding is pinned by a test. `source`, `soldPrice`
 * and `soldDate` are withheld for a quieter reason — they are internal
 * bookkeeping. Provenance ('quicken', 'csv') says nothing about the coin, and
 * sale history is about coins that are not on the schedule at all
 * (build-report.ts drops sold coins outright).
 *
 * ADDING A COIN FIELD LATER COSTS NOTHING HERE. Fields are named by their
 * GRID COLUMN KEY and rendered with the grid's own `formatInventoryCell`, so
 * a new column in `inventoryColumnOrder` is printable by the inventory
 * listing immediately, with no edit to this file or to the renderer. It does
 * NOT reach the insurance schedule by accident: putting a field in front of
 * an insurer is a decision, and it costs exactly one string in the array
 * below.
 */

import { PickerDenomination } from '../../coin-editor-form/denomination-picker';
import { CatalogOption } from '../../../types/catalog-reference';
import { CoinRecord, SpotPrices } from '../../../types/coin.model';
import {
  InventoryColumn,
  formatInventoryCell,
  inventoryColumnLabels,
  inventoryColumnOrder
} from '../../../types/inventory-columns';
import { ReportField } from './report-types';

/** Fast membership test for "is this a real grid column?". */
const GRID_COLUMNS: ReadonlySet<string> = new Set(inventoryColumnOrder);

/**
 * Fields a printed report wants that the GRID has no column for.
 *
 * Two of them, and both earn their place on an appraisal:
 *
 *   purchaseDate — with purchasePrice, the documentary evidence behind the
 *                  stated value; an adjuster asked to accept $1,400 wants to
 *                  see that $1,250 was paid for it.
 *   composition  — "90% Silver". The grid splits the same fact across
 *                  `metalContent` ("Silver") and `pmPercent` (90) so both can
 *                  be sorted on; on paper the one phrase reads better and
 *                  takes less width.
 *
 * Kept to a short, explicit list rather than "anything on CoinRecord":
 * falling back to `String(coin[key])` for an arbitrary field is how a report
 * ends up printing `[object Object]`, a raw ISO timestamp, or — worst —
 * `notes`.
 */
const REPORT_ONLY_FIELDS: Readonly<Record<string, { label: string; read: (coin: CoinRecord) => string }>> = {
  purchaseDate: { label: 'Purchase Date', read: coin => coin.purchaseDate },
  composition: { label: 'Composition', read: coin => coin.composition }
};

/**
 * Full-word headings for the columns whose grid label is an abbreviation.
 *
 * The grid abbreviates to save width in a 60px column. That trade is right on
 * screen and wrong on paper: this document is read by an insurer who is not a
 * coin collector, and "MM" means nothing to them.
 *
 * Anything NOT listed here falls through to the grid's own label, so a newly
 * added column with a sensible full-word heading needs no entry at all.
 */
// Keyed on ReportField rather than InventoryColumn, because the report prints
// a few fields the grid has no column for -- `certCompany` among them -- and
// those are exactly the ones with no grid label to fall back on.
const REPORT_LABEL_OVERRIDES: Readonly<Partial<Record<ReportField, string>>> = {
  mintMark: 'Mint Mark',
  denomination: 'Denomination',
  coinType: 'Coin Type',
  certCompany: 'Certified By',
  certNumber: 'Certification',
  purchasePrice: 'Purchase Price',
  currentValue: 'Current Value',
  soldPrice: 'Sold Price',
  weight: 'Weight (g)',
  pmWeightGrams: 'Precious Metal Weight (g)',
  pmPercent: 'Purity'
};

/**
 * Columns that hold a quantity, and so are right-aligned on the page.
 *
 * A printed money column that is not right-aligned is unreadable — the whole
 * value of a column of figures is that the decimal points queue up.
 */
const NUMERIC_FIELDS: ReadonlySet<string> = new Set<ReportField>([
  'purchasePrice', 'currentValue', 'meltValue', 'soldPrice',
  'weight', 'pmWeightGrams', 'pmPercent'
]);

/**
 * THE INSURANCE SCHEDULE'S COLUMNS. Curated; see the header of this file.
 *
 * Ordered the way a coin is spoken and written — "1881-S Morgan Dollar,
 * MS63, PCGS" — then its certification, then the money. The grid orders its
 * leading columns the same way, for the same reason.
 *
 * `meltValue` is NOT here. It is appended by build-report.ts, but only when
 * spot prices are actually loaded, because a melt column of nothing but
 * em-dashes is noise on a printed page.
 */
export const INSURANCE_REPORT_FIELDS: readonly ReportField[] = [
  'year',
  'mintMark',
  'denomination',
  'coinType',
  'variety',
  'grade',
  'certCompany',
  'certNumber',
  'composition',
  'purchaseDate',
  'purchasePrice',
  'currentValue'
];

/**
 * Fields deliberately kept OFF the insurance schedule.
 *
 * Exported so the decision is testable. Without this, "notes are withheld" is
 * a property of an omission, and an omission is exactly the kind of thing
 * that gets undone by accident.
 */
export const INSURANCE_WITHHELD_FIELDS: readonly (keyof CoinRecord)[] = [
  'notes',
  'source',
  'soldPrice',
  'soldDate'
];

/**
 * The columns a printed inventory listing should use when the user has
 * somehow hidden everything. Mirrors the grid's own first few columns.
 */
const INVENTORY_FALLBACK_FIELDS: readonly ReportField[] = [
  'year', 'mintMark', 'denomination', 'coinType', 'grade', 'currentValue'
];

/**
 * The inventory listing's columns: whatever the user currently has visible.
 *
 * Unknown keys are DROPPED rather than printed as an empty column. Column
 * preferences are persisted, and columns do get renamed and removed, so the
 * same hazard InventoryFilterStore.restoreFromStorage() guards against
 * applies here: a stale key must not become a silent column of dashes on a
 * document.
 */
export function inventoryReportFields(visibleColumns: readonly string[]): ReportField[] {
  const usable = visibleColumns.filter(column => GRID_COLUMNS.has(column)) as ReportField[];
  return usable.length > 0 ? usable : [...INVENTORY_FALLBACK_FIELDS];
}

/** The heading printed above a column. Never empty. */
export function reportFieldLabel(field: ReportField): string {
  const override = REPORT_LABEL_OVERRIDES[field as InventoryColumn];
  if (override) return override;

  const reportOnly = REPORT_ONLY_FIELDS[field];
  if (reportOnly) return reportOnly.label;

  return inventoryColumnLabels[field as InventoryColumn] ?? field;
}

export function reportFieldIsNumeric(field: ReportField): boolean {
  return NUMERIC_FIELDS.has(field);
}

/**
 * The money columns where the grid prints `$0.00` but a report must not —
 * the one place a report deliberately disagrees with the grid.
 *
 * `formatInventoryCell` renders `purchasePrice` and `currentValue` as
 * `$${n.toFixed(2)}` unconditionally, so a coin nobody has appraised shows
 * `$0.00`. On screen that is harmless: the owner knows his own collection and
 * the cell is one of forty.
 *
 * On an insurance schedule it is an assertion, in writing, that the coin is
 * worth nothing — and it is the same `0` that report-totals.ts counts as
 * UNKNOWN and leaves out of the grand total. Letting the two disagree would
 * produce the worst possible document: a row saying $0.00 and a footnote
 * saying that coin's value is unknown.
 *
 * `soldPrice`, `weight`, `pmWeightGrams`, `pmPercent` and `meltValue` already
 * do the right thing in `formatInventoryCell` (they test for a value first
 * and fall back to an em-dash), so only these two need the override.
 */
const MONEY_BLANK_WHEN_ZERO: ReadonlySet<string> = new Set(['purchasePrice', 'currentValue']);

/**
 * One cell, formatted.
 *
 * Delegates to `formatInventoryCell` for every field the grid already knows,
 * which is the single most important line in this file. It means:
 *
 *   - the melt column obeys formatMeltValue(), so an unknowable melt prints
 *     as "—" and never as "$0.00";
 *   - a missing value prints as the same em-dash the grid uses, so the
 *     document and the screen agree;
 *   - a column added to the grid is printable here the day it lands.
 *
 * A second formatter for reports would have drifted from the grid's.
 *
 * DELEGATING MEANS PASSING THE ARGUMENTS TOO, NOT JUST THE COIN. Three of the
 * grid's columns are not functions of the coin record alone: `meltValue`
 * needs today's spot prices, `catalogReference` needs the Catalogs lookup,
 * and `denomination` needs the Denominations lookup — the coin stores an id
 * and the label behind it lives on InventoryService. A dropped lookup is the
 * quietest possible disagreement between a page and the screen it was
 * printed from — nothing fails, and the reader cannot tell which document is
 * complete — so all three travel together.
 *
 * They stay OPTIONAL. Omitting one is a partial answer, never a wrong one:
 * no prices means an em-dash in the melt column, no catalogue list means the
 * bare number, no denominations list means the text the column holds — which
 * is exactly what these documents printed before the lookups existed.
 */
export function formatReportCell(
  coin: CoinRecord,
  field: ReportField,
  spotPrices?: SpotPrices,
  catalogs?: readonly CatalogOption[],
  denominations?: readonly PickerDenomination[]
): string {
  if (MONEY_BLANK_WHEN_ZERO.has(field)) {
    const recorded = coin[field as 'purchasePrice' | 'currentValue'];
    if (!(recorded > 0)) return '—';
  }

  if (GRID_COLUMNS.has(field)) {
    return formatInventoryCell(coin, field as InventoryColumn, spotPrices, catalogs, denominations);
  }

  const reportOnly = REPORT_ONLY_FIELDS[field];
  // The same em-dash the grid uses for an empty cell, so a blank Purchase
  // Date reads identically to a blank Grade.
  return (reportOnly ? reportOnly.read(coin) : '').trim() || '—';
}
