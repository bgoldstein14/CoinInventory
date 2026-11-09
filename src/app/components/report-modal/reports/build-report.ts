/*
 * build-report.ts — coins in, ReportDocument out. No DOM, no signals, no I/O.
 *
 * This is where every decision about a report's CONTENT is made: which coins
 * appear, which columns, what the totals are, and what has been left out and
 * why. It is pure so that all of that is testable under Node with no jsdom —
 * see the header of report-types.ts for the full reasoning.
 *
 * THE TWO REPORTS ARE NOT ONE FUNCTION WITH A FLAG. They differ in more than
 * their column list:
 *
 *   INSURANCE SCHEDULE          INVENTORY LISTING
 *   curated columns             the user's visible grid columns
 *   sold coins REMOVED          sold coins included
 *   totals insured value        totals cost AND value
 *   photographs are the point   photographs are off
 *   notes withheld              notes are not a column anyway
 *
 * Folding that into one function with a `kind` parameter would mean five
 * branches in a row, each of which is the interesting part of one report and
 * noise in the other. Two short functions over a shared helper reads better
 * and makes each one's intent obvious at a glance.
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
  /**
   * The coins to report on, ALREADY IN THE ORDER THEY SHOULD PRINT.
   *
   * The inventory listing is handed `filters.filteredInventory()`, which is
   * the grid's own filtered-and-sorted list. Re-sorting here would quietly
   * contradict the screen the user is looking at, and re-filtering would
   * duplicate rules that already live in InventoryFilterStore.
   */
  coins: readonly CoinRecord[];
  /** Stamped on the document. Injected rather than `new Date()` so it is testable. */
  generatedAt: Date;
  spotPrices?: SpotPrices;
  /*
   * THE TWO LOOKUPS A PRINTED CELL CANNOT DO WITHOUT. A coin record does not
   * contain the catalogue's NAME (it has `catalogId`) nor the denomination's
   * LABEL (it has `denominationId`); both live in lookups on
   * InventoryService, and both are needed for the document to say what the
   * screen says. See the header of formatReportCell().
   *
   * Optional, like `spotPrices`: a report built without them prints the bare
   * number and the raw column — a partial answer, never a blank or an
   * invented value.
   */
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
 * The date as a reader wants it: "November 8, 2026".
 *
 * Long month name on purpose. An insurance document can outlive the software
 * that produced it and may be read in another country, where "08/11/2026" is
 * genuinely ambiguous. A spelled-out month cannot be misread.
 *
 * Locale pinned for the same reason formatReportMoney pins it: a stable
 * string on every machine, which is also what makes it assertable in a test.
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
 * The coins as printable rows.
 *
 * Takes the WHOLE input rather than the three or four pieces it happens to
 * need today. Lookups a cell needs arrive as new positional arguments — spot
 * prices, the Catalogs lookup, the Denominations lookup — and a call site
 * that forgets to pass one on still compiles, then prints a document that
 * disagrees with the screen. Threading the input object means the next
 * lookup reaches both reports or neither.
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
 * Why each coin that is NOT on the schedule was left off, grouped by status.
 *
 * Grouped rather than one lump "6 coins excluded", because the two reasons
 * call for different reactions. "3 × Wanted" is the owner's own want list
 * behaving correctly. "3 × Sold" next to a coin he thinks he still owns is a
 * data-entry mistake he would want to know about.
 *
 * Statuses are walked in COLLECTION_STATUSES order, not in the order the
 * coins happen to arrive, so two runs of the same report list their
 * exclusions identically.
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
 * The insurance / appraisal schedule.
 *
 * WHY COINS THAT ARE NOT IN THE HOUSE ARE REMOVED RATHER THAN MARKED. A
 * want-list coin has a `currentValue` on it — the price the owner expects to
 * pay — and a sold coin still carries what it was worth. Leaving either on
 * the schedule buys cover on property that is not there: a premium paid every
 * year for nothing, and a claim that collapses the first time an adjuster
 * asks to see the coin. On a document whose entire purpose is to state a
 * claimable amount, that is the one direction of error that looks like fraud
 * rather than carelessness.
 *
 * The test is `isHeldInCollection()` from types/collection-status.ts and it
 * is NOT re-derived here: `InventoryFileIo.exportInsuranceCsv` filters with
 * the same function, so the CSV schedule and this printed one cannot reach
 * different conclusions about what "my collection" means.
 *
 * Note what that rule does NOT do: it never looks at `soldPrice` or
 * `soldDate`. A sale can fall through, and collection-status.ts is explicit
 * that only the owner's dropdown moves a coin out of the collection.
 *
 * Removing them SILENTLY would be its own problem: the owner counts 412 coins
 * on screen and 406 on the schedule and has no way to find out why. So the
 * removals are counted, grouped by reason, and printed on the document.
 */
export function buildInsuranceReport(input: ReportInput): ReportDocument {
  const kept = input.coins.filter(isHeldInCollection);

  // The melt column is appended only when there is a price table to compute
  // against. A column of em-dashes tells the reader nothing and costs page
  // width on a document that is already wide.
  const showMelt = hasReportMeltValues(input.spotPrices);
  const fields: ReportField[] = showMelt
    ? [...INSURANCE_REPORT_FIELDS, 'meltValue']
    : [...INSURANCE_REPORT_FIELDS];

  const totals: ReportTotal[] = [
    toTotal('Total insured value', 'Current Value', kept.map(insuredValue))
  ];

  if (showMelt) {
    // A SECOND total, not a replacement. Melt is the floor under a precious
    // metal coin — what the metal alone is worth if the numismatic premium
    // evaporates — and an adjuster may well ask for it. It is unknowable for
    // most coins (anything without a recorded pure-metal weight), so its own
    // unknown count is printed beside it rather than folded into the
    // insured-value caveat, where it would read as if those coins had no
    // value at all.
    totals.push(toTotal(
      'Total melt value (precious metal content)',
      'A melt value',
      kept.map(coin => reportMeltValue(coin, input.spotPrices)),
      // Not "recorded for" — nobody types a melt value in. It is derived
      // from the coin's pure-metal weight, its metal and a loaded spot
      // price, any of which can be missing.
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
 * The full inventory listing.
 *
 * Follows the screen: the coins the grid is currently showing, in the order
 * it is showing them, through the columns the user has ticked. "Print what I
 * am looking at" is the behaviour least likely to surprise, and it means a
 * column added to the grid later is printable the day it lands.
 *
 * Sold coins stay. This is a listing of what is on record, not of what is
 * insurable, and a collection's history is part of its record.
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
    // No exclusions by construction: this report prints every coin it is
    // given. The array is still here so the renderer has one shape to handle.
    exclusions: [],
    imageNote: input.imageNote ?? null,
    hasImages: rows.some(row => row.images.length > 0)
  };
}
