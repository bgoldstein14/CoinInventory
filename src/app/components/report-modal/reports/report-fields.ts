/*
 * report-fields.ts — which columns each report prints.
 *
 * The insurance schedule uses a curated column list; private notes, source
 * and sale fields are withheld. The inventory listing follows the user's
 * visible grid columns. Fields are named by grid column key and rendered with
 * the grid's own formatInventoryCell, so the page matches the screen.
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
 * Fields a printed report uses that the grid has no column for. Kept to an
 * explicit list so arbitrary CoinRecord fields (notably `notes`) never print.
 */
const REPORT_ONLY_FIELDS: Readonly<Record<string, { label: string; read: (coin: CoinRecord) => string }>> = {
  purchaseDate: { label: 'Purchase Date', read: coin => coin.purchaseDate },
  composition: { label: 'Composition', read: coin => coin.composition }
};

/**
 * Full-word headings for columns whose grid label is an abbreviation, or that
 * have no grid column. Anything not listed uses the grid's label.
 */
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

/** Columns that hold a quantity, and so are right-aligned on the page. */
const NUMERIC_FIELDS: ReadonlySet<string> = new Set<ReportField>([
  'purchasePrice', 'currentValue', 'meltValue', 'soldPrice',
  'weight', 'pmWeightGrams', 'pmPercent'
]);

/**
 * The insurance schedule's columns, in the order a coin is described
 * ("1881-S Morgan Dollar, MS63, PCGS"). `meltValue` is appended by
 * build-report.ts only when spot prices are loaded.
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

/** Fields deliberately kept off the insurance schedule. Exported so a test can pin it. */
export const INSURANCE_WITHHELD_FIELDS: readonly (keyof CoinRecord)[] = [
  'notes',
  'source',
  'soldPrice',
  'soldDate'
];

/** Columns for the inventory listing when the user has hidden every column. */
const INVENTORY_FALLBACK_FIELDS: readonly ReportField[] = [
  'year', 'mintMark', 'denomination', 'coinType', 'grade', 'currentValue'
];

/**
 * The inventory listing's columns: whatever the user has visible. Unknown
 * (stale, persisted) keys are dropped rather than printed as empty columns.
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
 * Money columns the grid shows as `$0.00` but a report prints as "—": a zero
 * here means "not recorded", and report-totals.ts counts it as unknown.
 */
const MONEY_BLANK_WHEN_ZERO: ReadonlySet<string> = new Set(['purchasePrice', 'currentValue']);

/**
 * One cell, formatted. Grid columns delegate to formatInventoryCell so the
 * report matches the screen; the spot prices and lookups are optional and
 * a missing one just yields a plainer value.
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
  // Same em-dash the grid uses for an empty cell.
  return (reportOnly ? reportOnly.read(coin) : '').trim() || '—';
}
