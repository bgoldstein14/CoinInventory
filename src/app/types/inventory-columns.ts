import { CoinRecord, SpotPrices } from './coin.model';
import { CatalogOption, formatMainCatalogRef } from './catalog-reference';
import { collectionStatusLabel } from './collection-status';
import { computeMeltValue } from '../services/inventory/inventory-metrics';
import { denominationDisplay } from '../services/denominations/denomination-display';
import {
  PickerDenomination,
  denominationSelectionFor
} from '../components/coin-editor-form/denomination-picker';

/**
 * Canonical column order for the inventory table. The column picker lists
 * columns in this order and InventoryColumnsStore sorts visible columns by it,
 * so change the order here rather than in the template.
 */
export const inventoryColumnOrder = [
  'year',
  'mintMark',
  // Year / Mint Mark / Denomination read together, as on a holder ("1881-S Dollar").
  'denomination',
  'coinType',
  // Cert sits before Grade (slab and grade read as a pair). The cell shows
  // company and number, e.g. "PCGS #12345678"; there is no separate company column.
  'certNumber',
  'grade',
  // Status is on by default so want-list coins aren't mistaken for owned ones.
  // Never renders an em-dash: a coin with no stored status is Owned.
  'collectionStatus',
  'category',
  'country',
  'purchasePrice',
  'currentValue',
  'meltValue',
  'soldPrice',
  'variety',
  // Catalogue reference, e.g. "Sear 6819". Placed next to Variety, where
  // references were often typed before this column existed. Off by default.
  'catalogReference',
  'coinSet',
  // Storage (physical location) sits next to Set (conceptual grouping). Off by default.
  'storageLocation',
  'metalContent',
  'weight',
  'pmWeightGrams',
  'pmPercent'
  // `source` is intentionally not a grid column. It is still stored, filterable
  // and exported to CSV; a saved preference that included it is dropped on load.
] as const;

export type InventoryColumn = (typeof inventoryColumnOrder)[number];

/** Headers for the table and the column-selector panel. */
export const inventoryColumnLabels: Record<InventoryColumn, string> = {
  coinType: 'Type',
  grade: 'Grade',
  category: 'Category',
  denomination: 'Denom.',
  country: 'Country',
  year: 'Year',
  purchasePrice: 'Cost',
  currentValue: 'Value',
  meltValue: 'Melt Value',
  soldPrice: 'Sold Price',
  mintMark: 'MM',
  variety: 'Variety',
  // Spelled out: 'Cat.' would read as Category, 'Ref' as a cert number.
  catalogReference: 'Catalogue Ref.',
  certNumber: 'Cert',
  collectionStatus: 'Status',
  coinSet: 'Set',
  // 'Storage', not 'Location', which would read as country of origin.
  storageLocation: 'Storage',
  metalContent: 'Metal',
  // Unit in the header; both weight columns are grams.
  weight: 'Weight (g)',
  pmWeightGrams: 'PM Weight (g)',
  pmPercent: 'PM %'
};

/**
 * Columns visible on first load. Order here has no effect (it is re-sorted by
 * inventoryColumnOrder). Saved preferences are unioned with this list, so a
 * newly defaulted-on column reaches existing users on their next load.
 */
export const defaultVisibleColumns: InventoryColumn[] = [
  'year',
  'mintMark',
  'denomination',
  'coinType',
  'grade',
  'collectionStatus',
  'category',
  'country',
  'purchasePrice',
  'currentValue'
];

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: InventoryColumn;
  direction: SortDirection;
}

export function formatDenominationDisplay(value: string): string {
  const text = (value ?? '').trim();
  if (!text) return '—';

  return text
    .replace(/1\/-/gi, '1 sh')
    .replace(/2\/-/gi, '2 sh')
    .replace(/5\/-/gi, '5 sh')
    .replace(/1\s*shilling/gi, '1 sh')
    .replace(/2\s*shilling/gi, '2 sh')
    .replace(/5\s*shilling/gi, '5 sh');
}

/*
 * Denomination display.
 *
 * A coin has `denominationId` (canonical link, often null) and `denomination`
 * (source text, never rewritten). All read paths (grid, search, statistics,
 * reports) go through coinDenominationDisplay() so they match the editor.
 * When the id is null the text is resolved with the same resolver the editor
 * and importers use, so a coin reads the same before and after ids are
 * backfilled. Nothing here writes.
 *
 * The resolved label is normalised with formatDenominationDisplay (matching
 * the picker's options); the recorded text is shown verbatim. Normalise only
 * when a label exists: formatDenominationDisplay(null) returns '—', which
 * denominationDisplay() would treat as a real label.
 */

/** What `coinDenominationDisplay` needs off a coin. Widened for the reports. */
export interface DenominationBearing {
  denomination: string;
  denominationId?: number | null;
  country?: string;
}

/**
 * One coin's denomination as every screen shows it. The string itself is
 * built only by denominationDisplay().
 *
 * @param coin          the record; only three fields are read
 * @param denominations the in-memory Denominations lookup. Optional: without
 *                      it the coin's own text is shown (e.g. during start-up).
 */
export function coinDenominationDisplay(
  coin: DenominationBearing,
  denominations?: readonly PickerDenomination[]
): string {
  const label = resolvedDenominationLabel(coin, denominations ?? []);
  return denominationDisplay(label ? formatDenominationDisplay(label) : null, coin.denomination);
}

/** The lookup label this coin resolves to, or null. */
function resolvedDenominationLabel(
  coin: DenominationBearing,
  denominations: readonly PickerDenomination[]
): string | null {
  const selection = denominationSelectionFor(
    coin.denominationId,
    coin.denomination,
    coin.country,
    denominations
  );

  // `ready` is false while the lookup list is empty; fall back to the coin's text.
  if (!selection.ready) {
    const text = String(coin.denomination ?? '').trim();
    return text.length > 0 ? text : null;
  }

  return selection.label;
}

/**
 * Melt value for display, or an em-dash when null (null means "unknown", not
 * zero). Shared with the detail panel.
 */
export function formatMeltValue(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

/**
 * Formats one cell for the inventory table (currency, percentages, badges).
 * The optional lookups are needed only by columns that store a key: without
 * spot prices melt shows '—'; without catalogs the bare number is shown;
 * without denominations the coin's own text is shown.
 *
 * @param coin - The coin record to format
 * @param column - The column identifier
 * @param spotPrices - Current spot prices; only the `meltValue` column uses them
 * @param catalogs - The Catalogs lookup; only `catalogReference` uses it
 * @param denominations - The Denominations lookup; only `denomination` uses it
 * @returns Formatted string for display
 */
export function formatInventoryCell(
  coin: CoinRecord,
  column: InventoryColumn,
  spotPrices?: SpotPrices,
  catalogs?: readonly CatalogOption[],
  denominations?: readonly PickerDenomination[]
): string {
  switch (column) {
    case 'coinType':
      return coin.coinType || '—';

    case 'grade':
      return coin.grade || '—';

    case 'category':
      return coin.category || '—';

    // Resolved via the lookup so the grid matches the editor.
    case 'denomination':
      return coinDenominationDisplay(coin, denominations);

    case 'country':
      return coin.country || '—';

    case 'year': // a string, so that ranges like "1916-1945" survive
      return coin.year || '—';

    case 'purchasePrice':
      return `$${coin.purchasePrice.toFixed(2)}`;

    case 'currentValue':
      return `$${coin.currentValue.toFixed(2)}`;

    case 'meltValue':
      // Always use computeMeltValue(): pmWeightGrams is already pure-metal
      // weight, so applying pmPercent again would understate melt value.
      return formatMeltValue(spotPrices ? computeMeltValue(coin, spotPrices) : null);

    case 'soldPrice':
      return (coin.soldPrice ?? 0) > 0 ? `$${(coin.soldPrice ?? 0).toFixed(2)}` : '—';

    case 'mintMark':
      return coin.mintMark || '—';

    case 'variety':
      return coin.variety || '—';

    // The main reference (Sear if present) plus a count of the others.
    case 'catalogReference':
      return formatMainCatalogRef(catalogs, coin.catalogRefs) || '—';

    case 'certNumber':
      return coin.certCompany || coin.certNumber ? `${coin.certCompany} ${coin.certNumber}`.trim() || '—' : '—';

    // Never an em-dash: a missing status means Owned. collectionStatusLabel()
    // handles absent, empty and unrecognised values.
    case 'collectionStatus':
      return collectionStatusLabel(coin.collectionStatus);

    case 'coinSet':
      return coin.coinSet || '—';

    case 'storageLocation':
      return coin.storageLocation || '—';

    case 'metalContent':
      return coin.metalContent || '—';

    // Three decimals, matching pmWeightGrams (both grams). Display only;
    // the editor stores five.
    case 'weight':
      return (coin.weight ?? 0) > 0 ? `${(coin.weight ?? 0).toFixed(3)}` : '—';

    case 'pmWeightGrams':
      return coin.pmWeightGrams ? `${coin.pmWeightGrams.toFixed(3)}` : '—';

    case 'pmPercent':
      return coin.pmPercent ? `${coin.pmPercent.toFixed(1)}%` : '—';


    default:
      return '—';
  }
}

/**
 * Leading words that qualify a grade without changing which tier it is in:
 * "Choice VF" is a VF, "Gem BU" is a BU.
 */
const GRADE_TIER_MODIFIERS = /^(?:SUPERB|CHOICE|SELECT|NEARLY|NEAR|ABOUT|CH|SEL)[\s-]*/;

/**
 * Grade letters to colour tier. Keyed on the complete letter run (not a
 * prefix), so `VF` can never match `F` regardless of order.
 */
const GRADE_TIERS: Readonly<Record<string, string>> = {
  // Proof/specimen: own hue, not part of the circulated-to-mint ladder.
  PF: 'pf', PR: 'pf', SP: 'pf',
  // Uncirculated.
  MS: 'ms', BU: 'ms', UNC: 'ms', GEM: 'ms',
  AU: 'au',
  XF: 'xf', EF: 'xf',
  VF: 'vf',
  F: 'f',
  VG: 'vg',
  G: 'g',
  // The bottom of the scale: About Good, Fair, Poor.
  AG: 'basal', FR: 'basal', PO: 'basal'
};

/**
 * Colour-tier CSS class for a grade: strip a leading qualifier, take the
 * leading letters ("VF20" -> VF, "MS64RB" -> MS) and look them up.
 * Unrecognised grades get the neutral class. Colours are in styles/_controls.scss.
 */
export function gradeBadgeClass(grade: string): string {
  const normalized = (grade || '').trim().toUpperCase().replace(GRADE_TIER_MODIFIERS, '');
  if (!normalized) return 'badge badge--ungraded';

  // Leading letters only; the number and designations don't change the tier.
  const letters = /^[A-Z]+/.exec(normalized)?.[0] ?? '';
  const tier = GRADE_TIERS[letters];

  return tier ? `badge badge--grade-${tier}` : 'badge badge--ungraded';
}

export function certBadgeLabel(coin: CoinRecord): string | null {
  if (!coin.certCompany && !coin.certNumber) return null;
  const company = coin.certCompany || 'Cert';
  return coin.certNumber ? `${company} #${coin.certNumber}` : company;
}

export const METAL_CONTENT_OPTIONS = [
  'Gold',
  'Silver',
  'Platinum',
  'Copper',
  'Copper-Nickel',
  'Nickel',
  'Zinc',
  'Brass',
  'Bronze',
  'Steel',
  'Aluminum',
  'Nickel-Brass',
  'Clad',
  'Other'
] as const;
