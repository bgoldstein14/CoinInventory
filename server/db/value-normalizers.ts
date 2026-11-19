/**
 * Small helpers for converting JSON values before binding them. Shared by
 * db/coin-fields.ts and the spot-price routes so dates are stored the same way.
 */

/**
 * Normalizes a value for a text date column (PurchaseDate / SoldDate are TEXT,
 * not DATE). Always stores "YYYY-MM-DD", which rowToCoin() returns unchanged.
 */
export function normalizeTextDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Default normalizer: JSON `undefined` becomes SQL NULL, everything else passes through. */
export function normalizeNullable(value: unknown): unknown {
  return value === undefined ? null : value;
}
