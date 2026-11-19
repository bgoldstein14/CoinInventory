/**
 * In-memory SQLite database for server specs, built from the real
 * db/schema.sql and seed, plus a recorder of executed statements.
 *
 * Usage:
 *
 *   import { resetTestDatabase, withTestDb } from '../test-support/sqlite-test-db';
 *
 *   beforeEach(async () => { await resetTestDatabase(); });
 *
 *   it('stores the weight', async () => {
 *     await request(app).post('/api/coins').send({ denomination: '$1', weight: 26.73 });
 *     const rows = await withTestDb((db) => db.prepare('SELECT Weight FROM Coins').all());
 *     expect(rows[0]['Weight']).toBe(26.73);
 *   });
 *
 * Each spec file gets its own private ':memory:' database.
 * Importing this module sets COIN_INVENTORY_DB_PATH to ':memory:' so the
 * real collection file is never opened.
 */

import { afterAll, beforeEach } from 'vitest';

import { DB_PATH_ENV_VAR, IN_MEMORY_DATABASE } from '../db/config';
import { getPool, resetPool } from '../db/pool';
import { setQueryObserver, type QueryEvent } from '../db/sql-api';
import type { SqliteDatabase } from '../db/driver';

// Must run before db/config.ts resolves the database path.
process.env[DB_PATH_ENV_VAR] = IN_MEMORY_DATABASE;

/**
 * Every statement executed since the last reset, in order, with its
 * parameters.
 */
export const executedQueries: QueryEvent[] = [];

/** Every bound parameter of every statement, flattened. */
export function capturedInputs(): Array<{ name: string; type: unknown; value: unknown }> {
  return executedQueries.flatMap((event) =>
    event.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      value: parameter.value,
    }))
  );
}

/** The SQL text of every statement executed since the last reset. */
export function executedSql(): string[] {
  return executedQueries.map((event) => event.sql);
}

/** The first executed statement whose text matches, or undefined. */
export function findQuery(pattern: RegExp | string): QueryEvent | undefined {
  return executedQueries.find((event) =>
    typeof pattern === 'string' ? event.sql.includes(pattern) : pattern.test(event.sql)
  );
}

/**
 * Opens the database if it is not already open, clears every table the tests
 * write to, and starts recording again.
 *
 * Seeded reference tables are left as they are; use rebuildTestDatabase()
 * if a test modifies them.
 */
export async function resetTestDatabase(): Promise<void> {
  process.env[DB_PATH_ENV_VAR] = IN_MEMORY_DATABASE;

  const connection = await getPool();

  await connection.withLock(() => {
    const database = rawDatabase(connection);
    // Child tables first: foreign keys are enforced.
    for (const table of ['CoinCatalogRefs', 'CoinImages', 'Coins', 'SpotPrices', 'AppSettings']) {
      database.exec(`DELETE FROM ${table}`);
    }
  });

  executedQueries.length = 0;
  setQueryObserver((event) => {
    executedQueries.push(event);
  });
}

/**
 * Discards the database and builds a fresh one, restoring the seeded
 * reference tables (Issuers, Denominations, Catalogs, etc.).
 */
export async function rebuildTestDatabase(): Promise<void> {
  setQueryObserver(null);
  await resetPool();
  await resetTestDatabase();
}

/**
 * Runs `work` against the raw SQLite handle, holding the connection lock.
 * Use it to set up or inspect table contents directly.
 */
export async function withTestDb<T>(work: (database: SqliteDatabase) => T): Promise<T> {
  const connection = await getPool();
  return connection.withLock(() => work(rawDatabase(connection)));
}

/** Every row of a query, as plain objects. */
export async function queryRows(
  sql: string,
  parameters: Record<string, string | number | null> = {}
): Promise<Record<string, unknown>[]> {
  return withTestDb((database) =>
    database.prepare(sql).all(parameters).map((row) => Object.assign({}, row))
  );
}

/**
 * Inserts one coin with the given columns and returns its id. `CatalogId` and
 * `CatalogNumber`, if given, become the coin's single CoinCatalogRefs row.
 */
export async function insertCoin(
  coin: Record<string, string | number | null> & { CoinId: string }
): Promise<string> {
  const { CatalogId, CatalogNumber, ...row } = coin;
  const columns = Object.keys(row);
  await withTestDb((database) => {
    database
      .prepare(
        `INSERT INTO Coins (${columns.join(', ')}) ` +
          `VALUES (${columns.map((column) => `@${column}`).join(', ')})`
      )
      .run(row);
    if (CatalogId !== undefined || CatalogNumber !== undefined) {
      database
        .prepare('INSERT INTO CoinCatalogRefs (CoinId, CatalogId, CatalogNumber, SortOrder) VALUES (@coinId, @catalogId, @catalogNumber, 0)')
        .run({ coinId: coin.CoinId, catalogId: CatalogId ?? null, catalogNumber: String(CatalogNumber ?? '1') });
    }
  });
  return coin.CoinId;
}

/**
 * Reaches past DbConnection to the driver handle, which production code
 * intentionally cannot access.
 */
function rawDatabase(connection: unknown): SqliteDatabase {
  return (connection as { database: SqliteDatabase }).database;
}

afterAll(() => {
  setQueryObserver(null);
});

// Clean database for every test, even if the spec has no beforeEach.
beforeEach(async () => {
  await resetTestDatabase();
});
