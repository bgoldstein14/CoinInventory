/**
 * Reading and writing a coin's catalogue references (CoinCatalogRefs).
 * The coin routes send and receive them as `catalogRefs`, an ordered list of
 * `{ catalogId, catalogNumber }`; a write replaces the whole list.
 */

import { DB_BINDINGS, DbRequest, DbTransaction, normalizeForeignKeyId, type DbConnection } from '../../db';

export interface CatalogRefRow {
  catalogId: number | null;
  catalogNumber: string;
}

/**
 * Cleans an incoming `catalogRefs` value: anything that isn't an array is
 * treated as empty, numbers are trimmed, entries without a number and exact
 * duplicates are dropped, ids go through the shared foreign-key normalizer.
 */
export function normalizeCatalogRefPayload(refs: unknown): CatalogRefRow[] {
  if (!Array.isArray(refs)) return [];
  const seen = new Set<string>();
  const result: CatalogRefRow[] = [];
  for (const item of refs) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const catalogNumber = typeof entry['catalogNumber'] === 'string'
      ? entry['catalogNumber'].trim()
      : String(entry['catalogNumber'] ?? '').trim();
    if (!catalogNumber) continue;
    const catalogId = normalizeForeignKeyId(entry['catalogId']);
    const key = `${catalogId ?? ''}|${catalogNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ catalogId, catalogNumber });
  }
  return result;
}

/** Inserts a coin's references in list order. */
export async function insertCatalogRefs(
  transaction: DbTransaction,
  coinId: string,
  refs: unknown
): Promise<void> {
  const rows = normalizeCatalogRefPayload(refs);
  for (let i = 0; i < rows.length; i++) {
    await new DbRequest(transaction)
      .input('coinId', DB_BINDINGS.coinId, coinId)
      .input('catalogId', DB_BINDINGS.catalogId, rows[i].catalogId)
      .input('catalogNumber', DB_BINDINGS.catalogNumber, rows[i].catalogNumber)
      .input('sortOrder', DB_BINDINGS.sortOrder, i)
      .query(
        'INSERT INTO CoinCatalogRefs (CoinId, CatalogId, CatalogNumber, SortOrder) ' +
          'VALUES (@coinId, @catalogId, @catalogNumber, @sortOrder)'
      );
  }
}

/** Replaces a coin's whole reference list on the given transaction. */
export async function replaceCatalogRefs(
  transaction: DbTransaction,
  coinId: string,
  refs: unknown
): Promise<void> {
  await new DbRequest(transaction)
    .input('coinId', DB_BINDINGS.coinId, coinId)
    .query('DELETE FROM CoinCatalogRefs WHERE CoinId = @coinId');
  await insertCatalogRefs(transaction, coinId, refs);
}

function toRef(row: Record<string, unknown>): CatalogRefRow {
  const id = row['CatalogId'];
  return {
    catalogId: id === null || id === undefined ? null : Number(id),
    catalogNumber: String(row['CatalogNumber'] ?? '')
  };
}

/** One coin's references, in order. */
export async function loadCatalogRefs(db: DbConnection, coinId: string): Promise<CatalogRefRow[]> {
  const result = await db.request()
    .input('coinId', DB_BINDINGS.coinId, coinId)
    .query('SELECT CatalogId, CatalogNumber FROM CoinCatalogRefs WHERE CoinId = @coinId ORDER BY SortOrder');
  return (result.recordset as Record<string, unknown>[]).map(toRef);
}

/** Every coin's references, keyed by CoinId, each list in order. */
export async function loadAllCatalogRefs(db: DbConnection): Promise<Map<string, CatalogRefRow[]>> {
  const result = await db.request().query(
    'SELECT CoinId, CatalogId, CatalogNumber FROM CoinCatalogRefs ORDER BY CoinId, SortOrder'
  );
  const byCoin = new Map<string, CatalogRefRow[]>();
  for (const row of result.recordset as Record<string, unknown>[]) {
    const coinId = row['CoinId'] as string;
    if (!byCoin.has(coinId)) byCoin.set(coinId, []);
    byCoin.get(coinId)!.push(toRef(row));
  }
  return byCoin;
}
