/**
 * db/value-normalizers.ts — tiny conversion helpers used when binding a value
 * that came in as JSON to a SQL Server parameter.
 *
 * These live on their own because more than one place needs them: the coin
 * column table (db/coin-fields.ts) and the transactions routes both store dates
 * in NVARCHAR columns and must normalize them the same way. Keeping one copy is
 * what stops the two paths drifting apart.
 */

/**
 * Normalizes a value destined for one of the text-based date columns
 * (PurchaseDate / SoldDate / Transactions.TransactionDate are NVARCHAR, not DATE).
 *
 * Binding a JS Date into an NVARCHAR column makes SQL Server stringify it in a
 * server-locale-dependent format that will not round-trip back through
 * rowToCoin(). We always store plain "YYYY-MM-DD" text, which is exactly what
 * rowToCoin() hands back to the frontend, so reads and writes stay symmetric.
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
