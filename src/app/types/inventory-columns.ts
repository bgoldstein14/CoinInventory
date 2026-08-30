import { CoinRecord } from './coin.model';

/**
 * Column order for the inventory table.
 * This defines the available columns and their default display order.
 *
 * Key changes from legacy schema:
 * - Replaced 'name' with 'coinType' (aligns with CoinRecord changes)
 * - Added 'pmWeightGrams', 'pmPercent', 'meltValue' for precious metal tracking
 */
export const inventoryColumnOrder = [
  'year',
  'coinType', // Changed from 'name' - displays the coin type/variant
  'grade',
  'category',
  'denomination',
  'country',
  'purchasePrice',
  'currentValue',
  'meltValue', // New: computed melt value based on PM content and spot prices
  'soldPrice',
  'mintMark',
  'variety',
  'certNumber',
  'dealer',
  'coinSet',
  'metalContent',
  'weight',
  'pmWeightGrams', // New: precious metal weight in grams
  'pmPercent', // New: precious metal purity percentage
  'tags',
  'source'
] as const;

export type InventoryColumn = (typeof inventoryColumnOrder)[number];

/**
 * Human-readable labels for each inventory column.
 * These labels are displayed in the table header and column selector UI.
 */
export const inventoryColumnLabels: Record<InventoryColumn, string> = {
  coinType: 'Type', // Changed from 'Name' - displays coin variant (e.g., "Walking Liberty")
  grade: 'Grade',
  category: 'Category',
  denomination: 'Denomination',
  country: 'Country',
  year: 'Year',
  purchasePrice: 'Cost',
  currentValue: 'Value',
  meltValue: 'Melt Value', // New: computed melt value
  soldPrice: 'Sold Price',
  mintMark: 'Mint Mark',
  variety: 'Variety',
  certNumber: 'Cert',
  dealer: 'Dealer',
  coinSet: 'Set',
  metalContent: 'Metal',
  weight: 'Weight (oz)',
  pmWeightGrams: 'PM Weight (g)', // New: precious metal weight in grams
  pmPercent: 'PM %', // New: precious metal purity percentage
  tags: 'Tags',
  source: 'Source'
};

/**
 * Default set of visible columns when the inventory table first loads.
 * Users can customize this via the column selector UI.
 */
export const defaultVisibleColumns: InventoryColumn[] = [
  'year',
  'coinType', // Changed from 'name'
  'grade',
  'category',
  'denomination',
  'country',
  'purchasePrice',
  'currentValue'
];

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: InventoryColumn;
  direction: SortDirection;
}

/**
 * Formats a cell value for display in the inventory table.
 * Each column has custom formatting logic (currency, percentages, badges, etc.).
 *
 * @param coin - The coin record to format
 * @param column - The column identifier
 * @returns Formatted string for display
 */
export function formatInventoryCell(coin: CoinRecord, column: InventoryColumn): string {
  switch (column) {
    case 'coinType': // Changed from 'name' - displays coin variant
      return coin.coinType || '—';

    case 'grade':
      return coin.grade || '—';

    case 'category':
      return coin.category || '—';

    case 'denomination':
      return coin.denomination || '—';

    case 'country':
      return coin.country || '—';

    case 'year': // Now a string (not number|null), so no conversion needed
      return coin.year || '—';

    case 'purchasePrice':
      return `$${coin.purchasePrice.toFixed(2)}`;

    case 'currentValue':
      return `$${coin.currentValue.toFixed(2)}`;

    case 'meltValue': // New: computed column (requires spot prices for full calculation)
      // TODO: Compute melt value based on pmWeightGrams, pmPercent, and current spot prices
      // Formula: (pmWeightGrams * pmPercent / 100) * spotPricePerGram
      // For now, return placeholder until spot price service is wired up
      if (coin.pmWeightGrams && coin.pmPercent) {
        return '—'; // Placeholder until spot prices are available
      }
      return '—';

    case 'soldPrice':
      return (coin.soldPrice ?? 0) > 0 ? `$${(coin.soldPrice ?? 0).toFixed(2)}` : '—';

    case 'mintMark':
      return coin.mintMark || '—';

    case 'variety':
      return coin.variety || '—';

    case 'certNumber':
      return coin.certCompany || coin.certNumber ? `${coin.certCompany} ${coin.certNumber}`.trim() || '—' : '—';

    case 'dealer':
      return coin.dealer || '—';

    case 'coinSet':
      return coin.coinSet || '—';

    case 'metalContent':
      return coin.metalContent || '—';

    case 'weight':
      return (coin.weight ?? 0) > 0 ? `${(coin.weight ?? 0).toFixed(4)}` : '—';

    case 'pmWeightGrams': // New: precious metal weight in grams
      return coin.pmWeightGrams ? `${coin.pmWeightGrams.toFixed(3)}` : '—';

    case 'pmPercent': // New: precious metal purity percentage
      return coin.pmPercent ? `${coin.pmPercent.toFixed(1)}%` : '—';

    case 'tags':
      return coin.tags.join(', ') || '—';

    case 'source':
      return coin.source;

    default:
      return '—';
  }
}

export function gradeBadgeClass(grade: string): string {
  const normalized = (grade || '').trim().toUpperCase();
  if (!normalized) return 'badge badge--ungraded';
  if (/^(MS|PR|PF)/.test(normalized)) return 'badge badge--mint';
  if (/^(AU|XF|VF)/.test(normalized)) return 'badge badge--circulated';
  return 'badge badge--worn';
}

export function certBadgeLabel(coin: CoinRecord): string | null {
  if (!coin.certCompany && !coin.certNumber) return null;
  const company = coin.certCompany || 'Cert';
  return coin.certNumber ? `${company} #${coin.certNumber}` : company;
}

export const METAL_CONTENT_OPTIONS = ['Gold', 'Silver', 'Platinum', 'Copper', 'Nickel', 'Zinc', 'Clad', 'Other'] as const;
