/**
 * db/row-mappers.ts — turning SQL Server rows into the JSON the Angular app
 * expects.
 *
 * SQL Server hands us CamelCase column names (CoinId, PurchaseDate, ...) while
 * the frontend works in camelCase (id, purchaseDate, ...). Everything that
 * performs that translation lives here, so if the frontend ever needs a new
 * field there is exactly one place to add it.
 */

/**
 * Maps a database row (CamelCase SQL columns) to a camelCase JavaScript coin object.
 * Used by the coins routes when reading from the Coins table.
 */
export function rowToCoin(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['CoinId'],
    denomination: row['Denomination'] ?? '',
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
    dealer: row['Dealer'] ?? undefined,
    weight: row['Weight'] ?? undefined,
    metalContent: row['MetalContent'] ?? undefined,
    pmWeightGrams: row['PmWeightGrams'] ?? undefined,
    pmPercent: row['PmPercent'] ?? undefined,
    coinSet: row['CoinSet'] ?? undefined,
  };
}

/**
 * Formats a Date or string to YYYY-MM-DD string.
 * SQL Server returns Date objects; this normalizes them for JSON responses.
 */
export function formatDate(d: Date | string): string {
  if (typeof d === 'string') return d;
  return d.toISOString().slice(0, 10);
}
