/*
 * build-report.ts — coins in, ReportDocument out. Pure: no DOM, signals or I/O.
 * Decides which coins, columns and totals each report contains.
 */

import { PickerDenomination } from '../../coin-editor-form/denomination-picker';
import { CatalogOption } from '../../../types/catalog-reference';
import { CoinRecord, SpotPrices } from '../../../types/coin.model';
import {
  COLLECTION_STATUSES,
  COLLECTION_STATUS_LABELS,
  isHeldInCollection,
  normalizeCollectionStatus
} from '../../../types/collection-status';
import {
  INSURANCE_REPORT_FIELDS,
  formatReportCell,
  inventoryReportFields,
  reportFieldIsNumeric,
  reportFieldLabel
} from './report-fields';
import {
  formatHonestTotal,
  hasReportMeltValues,
  insuredValue,
  purchaseCost,
  reportMeltValue,
  sumKnown
} from './report-totals';
import {
  HonestTotal,
  ReportColumn,
  ReportDocument,
  ReportExclusion,
  ReportField,
  ReportRow,
  ReportTotal
} from './report-types';

export interface ReportInput {
  /** The coins to report on, already in print order (the grid's filtered, sorted list). */
  coins: readonly CoinRecord[];
  /** Stamped on the document. Injected rather than `new Date()` so it is testable. */
  generatedAt: Date;
  spotPrices?: SpotPrices;
  /** The Catalogs lookup, so a reference prints as "Sear 6819". */
  catalogs?: readonly CatalogOption[];
  /** The Denominations lookup, so a denomination prints as the grid shows it. */
  denominations?: readonly PickerDenomination[];
  /** coinId -> thumbnails, from collectReportImages(). Never originals. */
  images?: ReadonlyMap<string, readonly string[]>;
  /** The paragraph describing what was done with the photographs. */
  imageNote?: string | null;
  /** Inventory listing only: the user's visible grid columns. */
  fields?: readonly string[];
  /** "Category: Silver" — what the user had filtered to, or null for everything. */
  scopeNote?: string | null;
}

/**
 * The date as "November 8, 2026". A spelled-out month cannot be misread
 * across locales; the locale is pinned so the string is stable.
 */
function formatGeneratedAt(when: Date): string {
  return when.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function toColumns(fields: readonly ReportField[]): ReportColumn[] {
  return fields.map(field => ({
    key: field,
    label: reportFieldLabel(field),
    numeric: reportFieldIsNumeric(field)
  }));
}

/**
 * The coins as printable rows. Takes the whole input so every lookup a cell
 * needs reaches both reports.
 */
function toRows(
  coins: readonly CoinRecord[],
  fields: readonly ReportField[],
  input: ReportInput
): ReportRow[] {
  return coins.map(coin => ({
    coinId: coin.id,
    cells: fields.map(
      field => formatReportCell(coin, field, input.spotPrices, input.catalogs, input.denominations)
    ),
    images: [...(input.images?.get(coin.id) ?? [])]
  }));
}

/** Assemble one printable total from a list of known-or-null figures. */
function toTotal(
  label: string,
  fieldLabel: string,
  values: (number | null)[],
  missingPhrase?: string
): ReportTotal {
  const amount: HonestTotal = sumKnown(values);
  const { amountText, basis, caveat } = formatHonestTotal(amount, fieldLabel, missingPhrase);
  return { label, amount, amountText, basis, caveat };
}

/**
 * Counts of coins left off the schedule, grouped by status in
 * COLLECTION_STATUSES order so the output is stable.
 */
function excludedByStatus(coins: readonly CoinRecord[]): ReportExclusion[] {
  const counts = new Map<string, number>();
  for (const coin of coins) {
    if (isHeldInCollection(coin)) continue;
    const status = normalizeCollectionStatus(coin.collectionStatus);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return COLLECTION_STATUSES
    .filter(status => counts.has(status))
    .map(status => ({
      reason: `${COLLECTION_STATUS_LABELS[status]} — not in the collection, so not insurable`,
      count: counts.get(status)!
    }));
}

/**
 * The insurance / appraisal schedule. Only held coins are listed (the same
 * isHeldInCollection() rule as the insurance CSV export); the coins left off
 * are counted by status and printed on the document.
 */
export function buildInsuranceReport(input: ReportInput): ReportDocument {
  const kept = input.coins.filter(isHeldInCollection);

  // The melt column is only added when there are spot prices to compute it from.
  const showMelt = hasReportMeltValues(input.spotPrices);
  const fields: ReportField[] = showMelt
    ? [...INSURANCE_REPORT_FIELDS, 'meltValue']
    : [...INSURANCE_REPORT_FIELDS];

  const totals: ReportTotal[] = [
    toTotal('Total insured value', 'Current Value', kept.map(insuredValue))
  ];

  if (showMelt) {
    // A separate total with its own unknown count, since melt value cannot be
    // calculated for coins without a recorded pure-metal weight.
    totals.push(toTotal(
      'Total melt value (precious metal content)',
      'A melt value',
      kept.map(coin => reportMeltValue(coin, input.spotPrices)),
      // Melt is derived, not entered, hence "calculable" rather than "recorded".
      'calculable for'
    ));
  }

  const exclusions = excludedByStatus(input.coins);
  const rows = toRows(kept, fields, input);

  return {
    kind: 'insurance',
    title: 'Insurance & Appraisal Schedule',
    purpose:
      'A dated record of the coins owned on this date, what each one is, and what it is worth. '
      + 'Intended for an insurer or appraiser. It does not contain the owner’s private notes.',
    generatedAt: formatGeneratedAt(input.generatedAt),
    scopeNote: input.scopeNote ?? null,
    columns: toColumns(fields),
    rows,
    totals,
    exclusions,
    imageNote: input.imageNote ?? null,
    hasImages: rows.some(row => row.images.length > 0)
  };
}

/**
 * The full inventory listing: the coins the grid is showing, in its order,
 * through the user's visible columns. Sold coins are included.
 */
export function buildInventoryReport(input: ReportInput): ReportDocument {
  const fields = inventoryReportFields(input.fields ?? []);

  const totals: ReportTotal[] = [
    toTotal('Total purchase cost', 'Purchase Price', input.coins.map(purchaseCost)),
    toTotal('Total current value', 'Current Value', input.coins.map(insuredValue))
  ];

  const rows = toRows(input.coins, fields, input);

  return {
    kind: 'inventory',
    title: 'Coin Inventory Listing',
    purpose:
      'The collection as it currently appears on screen, in a form that prints and files. '
      + 'Reflects the filters and the sort order in use when it was produced.',
    generatedAt: formatGeneratedAt(input.generatedAt),
    scopeNote: input.scopeNote ?? null,
    columns: toColumns(fields),
    rows,
    totals,
    // Always empty here; kept so the renderer handles one shape.
    exclusions: [],
    imageNote: input.imageNote ?? null,
    hasImages: rows.some(row => row.images.length > 0)
  };
}
