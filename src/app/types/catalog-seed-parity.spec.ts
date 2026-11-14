/*
 * catalog-seed-parity.spec.ts — THE THREE COPIES OF THE CATALOGUE LIST MUST
 * SAY THE SAME THING, AND THIS TEST IS WHAT MAKES THAT TRUE
 * The fifteen seeded catalogues are written down in three places, because
 * SQL cannot import a TypeScript module:
 *
 *   1. CATALOG_SEED in types/catalog-reference.ts  — what the app believes
 *   2. CATALOG_SEED in server/db/seed.ts            — what a fresh SQLITE
 *                                                     database gets, which is
 *                                                     every new install
 *   3. server/setup-database.sql                   — what a fresh SQL SERVER
 *                                                     database got. LEGACY,
 *                                                     kept until the owner's
 *                                                     own data has moved
 *   4. server/migrations/012-add-catalog-references.sql
 *                                                  — what an EXISTING SQL
 *                                                     Server database gets
 *
 * FOUR hand-maintained copies of the same list, and the SQLite one (2) is
 * now the one that matters for every user. Four copies is exactly the
 * arrangement that produces one wrong spelling nobody notices. The
 * consequences are not cosmetic: a name that differs between (2) and (4)
 * means a fresh install and a migrated install end up with DIFFERENT
 * catalogues, so the same export imports differently on two machines. A name
 * that differs from (1) breaks nothing visibly but makes the application's
 * own documentation wrong.
 *
 * Why four and not one: SQL cannot import a TypeScript module, the server
 * package cannot import from src/, and the two SQL Server files stay in the
 * tree until Stage 2 of the SQLite migration has been run for real.
 *
 * So this reads all three off disk and compares them. It is the same
 * technique, for the same reason, as sql-pm-reference-parity.spec.ts, which
 * holds migration 007's alloy table against pm-reference.ts.
 *
 * WHY IT READS THE SQL RATHER THAN TRUSTING THE SERVER SPEC
 *   server/migrations/migration-012.spec.ts also checks the seeded names, but
 *   against a literal list of its own. That is deliberate duplication: the
 *   server suite must be able to fail on its own, without the Angular side
 *   present. THIS test is the one that ties the SQL back to the TypeScript
 *   the application actually runs on.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CATALOG_SEED } from './catalog-reference';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, '../../../server/migrations/012-add-catalog-references.sql');
const SCHEMA_PATH = resolve(HERE, '../../../server/setup-database.sql');
const SQLITE_SEED_PATH = resolve(HERE, '../../../server/db/seed.ts');

/**
 * The catalogue names a `FROM (VALUES ...) AS Seed(Name, SortOrder)` block
 * inserts, paired with their sort order, in file order.
 *
 * Deliberately crude — this is a tripwire on the exact strings that matter,
 * not a SQL parser. The `expect` on the block being found is what stops a
 * renamed seed block turning this whole file into a silent pass, which would
 * be worse than having no test because it looks like cover.
 */
function seededRows(sql: string, label: string): Array<{ name: string; sortOrder: number }> {
  const block = sql.match(/FROM \(VALUES([\s\S]*?)\) AS Seed\(Name, SortOrder\)/)?.[1];
  expect(block, `no catalogue seed block found in ${label}`).toBeTruthy();

  return [...(block ?? '').matchAll(/\(\s*N?'((?:[^']|'')*)'\s*,\s*(\d+)\s*\)/g)].map(match => ({
    name: match[1].replace(/''/g, "'"),
    sortOrder: Number(match[2])
  }));
}

/**
 * The names in server/db/seed.ts's `CATALOG_SEED` array literal, in file
 * order. That file cannot be imported from here — it is CommonJS in the
 * server package, and importing it would drag `node:sqlite` into the Angular
 * test run — so it is read as text, by the same crude-tripwire principle as
 * the SQL above. The `expect` is what stops a reformatted array turning this
 * into a silent pass.
 *
 * SortOrder is not in that literal: db/seed.ts numbers the catalogues by
 * their position (index + 1), so the order of the array IS the SortOrder and
 * the two cannot drift apart.
 */
function sqliteSeedRows(source: string): string[] {
  const block = source.match(
    /export const CATALOG_SEED: readonly string\[\] = \[([\s\S]*?)\];/
  )?.[1];
  expect(block, 'no CATALOG_SEED array found in server/db/seed.ts').toBeTruthy();

  return [...(block ?? '').matchAll(/'((?:[^']|\\')*)'/g)].map(match => match[1]);
}

const migrationRows = seededRows(readFileSync(MIGRATION_PATH, 'utf8'), 'migration 012');
const schemaRows = seededRows(readFileSync(SCHEMA_PATH, 'utf8'), 'setup-database.sql');
const sqliteRows = sqliteSeedRows(readFileSync(SQLITE_SEED_PATH, 'utf8'));

describe('the catalogue seed is the same in all four files', () => {
  it('found a non-empty list in each file', () => {
    // Guards against the parsers above quietly matching nothing, which would
    // make every comparison below trivially true.
    expect(migrationRows.length).toBe(CATALOG_SEED.length);
    expect(schemaRows.length).toBe(CATALOG_SEED.length);
    expect(sqliteRows.length).toBe(CATALOG_SEED.length);
  });

  it('server/db/seed.ts seeds exactly CATALOG_SEED, in order', () => {
    // THE ONE THAT MATTERS FOR EVERY NEW INSTALL. The two SQL files below
    // only affect databases that already exist on SQL Server.
    expect(sqliteRows).toEqual([...CATALOG_SEED]);
  });

  it('migration 012 seeds exactly CATALOG_SEED, in order', () => {
    expect(migrationRows.map(row => row.name)).toEqual([...CATALOG_SEED]);
  });

  it('setup-database.sql seeds exactly CATALOG_SEED, in order', () => {
    // A fresh install and a migrated install must not disagree about what
    // catalogues exist.
    expect(schemaRows.map(row => row.name)).toEqual([...CATALOG_SEED]);
  });

  it('numbers SortOrder 1..15 identically in both SQL files', () => {
    const expected = CATALOG_SEED.map((_, index) => index + 1);
    expect(migrationRows.map(row => row.sortOrder)).toEqual(expected);
    expect(schemaRows.map(row => row.sortOrder)).toEqual(expected);
  });
});
