import { normalizeCollectionStatus } from './collection-status';

/**
 * Converts database rows (PascalCase columns) into the camelCase JSON the
 * Angular app expects. New frontend fields are added here.
 */

/** A Coins row, as the Angular app expects it. */
export function rowToCoin(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['CoinId'],
    denomination: row['Denomination'] ?? '',
    // The canonical denomination link, returned alongside the source text.
    // `?? null` (not undefined): "no link" is a single, normal state that the
    // client checks for, so the key is always present.
    denominationId: row['DenominationId'] ?? null,
    year: row['Year'] ?? '',
    coinType: row['CoinType'] ?? '',
    category: row['Category'] ?? '',
    country: row['Country'] ?? '',
    grade: row['Grade'] ?? '',
    certCompany: row['CertCompany'] ?? '',
    certNumber: row['CertNumber'] ?? '',
    variety: row['Variety'] ?? '',
    mintMark: row['MintMark'] ?? '',
    composition: row['Composition'] ?? '',
    purchaseDate: row['PurchaseDate'] ?? '',
    purchasePrice: row['PurchasePrice'] ?? 0,
    currentValue: row['CurrentValue'] ?? 0,
    notes: row['Notes'] ?? '',
    source: row['Source'] ?? 'manual',
    hasCacSticker: row['HasCacSticker'] === true || row['HasCacSticker'] === 1,
    soldPrice: row['SoldPrice'] ?? undefined,
    soldDate: row['SoldDate'] ?? undefined,
    // Gross weight in grams, same unit as pmWeightGrams.
    weight: row['Weight'] ?? undefined,
    metalContent: row['MetalContent'] ?? undefined,
    pmWeightGrams: row['PmWeightGrams'] ?? undefined,
    pmPercent: row['PmPercent'] ?? undefined,
    coinSet: row['CoinSet'] ?? undefined,
    // Always one of the valid tokens: older rows may have no value, and
    // unrecognised ones become 'owned'.
    collectionStatus: normalizeCollectionStatus(row['CollectionStatus']),
    // NULL -> undefined so JSON.stringify drops the key ("never recorded").
    storageLocation: row['StorageLocation'] ?? undefined,
  };
}

/** YYYY-MM-DD. Accepts a Date or a date string. */
export function formatDate(d: Date | string): string {
  if (typeof d === 'string') return d;
  return d.toISOString().slice(0, 10);
}
