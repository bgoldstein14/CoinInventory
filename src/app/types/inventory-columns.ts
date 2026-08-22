import { CoinRecord } from './coin.model';

export const inventoryColumnOrder = [
  'name',
  'grade',
  'category',
  'denomination',
  'country',
  'year',
  'purchasePrice',
  'currentValue',
  'profitLoss',
  'soldPrice',
  'mintMark',
  'variety',
  'certNumber',
  'dealer',
  'coinSet',
  'metalContent',
  'weight',
  'tags',
  'source'
] as const;

export type InventoryColumn = (typeof inventoryColumnOrder)[number];

export const inventoryColumnLabels: Record<InventoryColumn, string> = {
  name: 'Name',
  grade: 'Grade',
  category: 'Category',
  denomination: 'Denomination',
  country: 'Country',
  year: 'Year',
  purchasePrice: 'Cost',
  currentValue: 'Value',
  profitLoss: 'Gain/Loss',
  soldPrice: 'Sold Price',
  mintMark: 'Mint Mark',
  variety: 'Variety',
  certNumber: 'Cert',
  dealer: 'Dealer',
  coinSet: 'Set',
  metalContent: 'Metal',
  weight: 'Weight (oz)',
  tags: 'Tags',
  source: 'Source'
};

export const defaultVisibleColumns: InventoryColumn[] = [
  'name',
  'grade',
  'category',
  'denomination',
  'country',
  'year',
  'purchasePrice',
  'currentValue',
  'profitLoss'
];

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: InventoryColumn;
  direction: SortDirection;
}

export function formatInventoryCell(coin: CoinRecord, column: InventoryColumn): string {
  switch (column) {
    case 'name': return coin.name;
    case 'grade': return coin.grade || '—';
    case 'category': return coin.category || '—';
    case 'denomination': return coin.denomination || '—';
    case 'country': return coin.country || '—';
    case 'year': return coin.year ? String(coin.year) : '—';
    case 'purchasePrice': return `$${coin.purchasePrice.toFixed(2)}`;
    case 'currentValue': return `$${coin.currentValue.toFixed(2)}`;
    case 'profitLoss': {
      const pl = coin.currentValue - coin.purchasePrice;
      if (pl >= 0) return `+$${pl.toFixed(2)}`;
      return `-$${Math.abs(pl).toFixed(2)}`;
    }
    case 'soldPrice': return (coin.soldPrice ?? 0) > 0 ? `$${(coin.soldPrice ?? 0).toFixed(2)}` : '—';
    case 'mintMark': return coin.mintMark || '—';
    case 'variety': return coin.variety || '—';
    case 'certNumber':
      return coin.certCompany || coin.certNumber ? `${coin.certCompany} ${coin.certNumber}`.trim() || '—' : '—';
    case 'dealer': return coin.dealer || '—';
    case 'coinSet': return coin.coinSet || '—';
    case 'metalContent': return coin.metalContent || '—';
    case 'weight': return (coin.weight ?? 0) > 0 ? `${(coin.weight ?? 0).toFixed(4)}` : '—';
    case 'tags': return coin.tags.join(', ') || '—';
    case 'source': return coin.source;
    default: return '—';
  }
}

export function profitLossClass(coin: CoinRecord): string {
  const pl = coin.currentValue - coin.purchasePrice;
  if (pl > 0) return 'gain';
  if (pl < 0) return 'loss';
  return '';
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
