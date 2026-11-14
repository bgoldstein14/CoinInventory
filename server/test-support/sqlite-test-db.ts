/**
 * test-support/sqlite-test-db.ts — THE REAL DATABASE THE WHOLE SERVER SUITE
 * NOW RUNS AGAINST.
 *
 * It replaces test-support/mssql-mock.ts, a 164-line hand-written fake whose
 * behaviour was whatever its author imagined SQL Server did. Twenty-five spec
 * files drove it by queueing canned recordsets, which meant they proved that
 * the route called the mock in the expected order — not that the SQL was
 * valid, not that the schema had the column, not that the constraint fired,
 * and not that the row came back looking the way the route assumed.
 *
 * SQLite runs in memory. So the suite can use the REAL db/schema.sql, the
 * REAL seed, the REAL parameter binding and the REAL constraint enforcement,
 * and a spec that passes now means something it did not mean before. This is
 * a side effect of the engine change rather than extra work, and it is the
 * best thing in the migration.
 *
 * HOW A SPEC USES IT
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
 * ISOLATION. Every `resetTestDatabase()` closes the handle and the next
 * `getPool()` opens a brand-new `:memory:` database — a private one, because
 * that is what `:memory:` means: nothing survives between tests, in either
 * direction, and no two spec FILES can see each other's rows. A full build
 * (schema + 1,274 seeded rows) measures around 10 ms, so per-test isolation
 * is affordable and is the default.
 *
 * *** THE PRODUCTION DATABASE IS NEVER TOUCHED. *** COIN_INVENTORY_DB_PATH is
 * set to ':memory:' as this module loads, before db/config.ts is ever asked
 * where the file is. A suite that resolved the real path would truncate the
 * owner's collection on every `npm test`. Importing this module is what makes
 * that impossible, which is why it is imported for its side effect even by
 * specs that only want the recorder.
 */

import { afterAll, beforeEach } from 'vitest';

import { DB_PATH_ENV_VAR, IN_MEMORY_DATABASE } from '../db/config';
import { getPool, resetPool } from '../db/pool';
import { setQueryObserver, type QueryEvent } from '../db/sql-api';
import type { SqliteDatabase } from '../db/driver';

// Side effect, deliberately at module scope and deliberately first.
process.env[DB_PATH_ENV_VAR] = IN_MEMORY_DATABASE;

/**
 * Every statement executed since the last reset, in order.
 *
 * The mssql mock's `capturedInputs` was a flat list of every `.input()` ever
 * made, with no way to tell which statement each belonged to — so a spec
 * asserting "the UPDATE bound @weight" was really asserting "something,
 * somewhere, bound @weight". These are grouped per statement.
 */
export const executedQueries: QueryEvent[] = [];

/** Every `.input()` of every statement, flattened, for the assertions that
 *  genuinely do not care which statement a binding belonged to. */
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
 * Call it from `beforeEach`. It does NOT re-seed from scratch on every call —
 * the handle, and therefore the seeded reference data, is reused; only rows a
 * test could have added are removed. That keeps a test file's 40 cases at one
 * schema build instead of 40.
 */
export async function resetTestDatabase(): Promise<void> {
  process.env[DB_PATH_ENV_VAR] = IN_MEMORY_DATABASE;

  const connection = await getPool();

  await connection.withLock(() => {
    const database = rawDatabase(connection);
    // Child tables first. Foreign keys are ON, which is the point.
    for (const table of ['CoinImages', 'Transactions', 'Coins', 'SpotPrices', 'AppSettings']) {
      database.exec(`DELETE FROM ${table}`);
    }
  });

  executedQueries.length = 0;
  setQueryObserver((event) => {
    executedQueries.push(event);
  });
}

/**
 * Throws the whole database away, so the next `resetTestDatabase()` builds a
 * fresh one with the reference data back at its seeded state.
 *
 * Needed by any test that modifies the SEEDED tables — Issuers,
 * Denominations, Catalogs, MintMarks, Categories, CoinSets, MetalContents —
 * because `resetTestDatabase()` deliberately leaves those alone.
 */
export async function rebuildTestDatabase(): Promise<void> {
  setQueryObserver(null);
  await resetPool();
  await resetTestDatabase();
}

/**
 * Runs `work` against the raw SQLite handle, holding the connection lock.
 *
 * This is the "look at what is actually in the table" escape hatch, and it is
 * what most assertions should use: reading the row a route wrote proves more
 * than inspecting the SQL that wrote it.
 */
export async function withTestDb<T>(work: (database: SqliteDatabase) => T): Promise<T> {
  const connection = await getPool();
  return connection.withLock(() => work(rawDatabase(connection)));
}

/** Convenience: every row of a query, as plain objects. */
export async function queryRows(
  sql: string,
  parameters: Record<string, string | number | null> = {}
): Promise<Record<string, unknown>[]> {
  return withTestDb((database) =>
    database.prepare(sql).all(parameters).map((row) => Object.assign({}, row))
  );
}

/** Convenience: insert one coin with sensible defaults, returning its id. */
export async function insertCoin(
  coin: Record<string, string | number | null> & { CoinId: string }
): Promise<string> {
  const columns = Object.keys(coin);
  await withTestDb((database) => {
    database
      .prepare(
        `INSERT INTO Coins (${columns.join(', ')}) ` +
          `VALUES (${columns.map((column) => `@${column}`).join(', ')})`
      )
      .run(coin);
  });
  return coin.CoinId;
}

/**
 * Reaches past DbConnection to the driver handle.
 *
 * DbConnection deliberately does not expose it: production code must go
 * through the request API so that every value is converted and validated.
 * The test harness is the one caller that legitimately wants the raw handle,
 * to set up and inspect state without going through the layer under test.
 */
function rawDatabase(connection: unknown): SqliteDatabase {
  return (connection as { database: SqliteDatabase }).database;
}

// Leaving an observer attached after a file finishes would make the next
// file's statements pile up in an array nobody reads.
afterAll(() => {
  setQueryObserver(null);
});

// A spec file that forgets its own beforeEach still gets a clean database,
// rather than mysteriously seeing the previous test's coins.
beforeEach(async () => {
  await resetTestDatabase();
});
