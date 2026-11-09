/*
 * catalog-seed-parity.spec.ts — THE THREE COPIES OF THE CATALOGUE LIST MUST
 * SAY THE SAME THING, AND THIS TEST IS WHAT MAKES THAT TRUE
 * The fifteen seeded catalogues are written down in three places, because
 * SQL cannot import a TypeScript module:
 *
 *   1. CATALOG_SEED in types/catalog-reference.ts  — what the app believes
 *   2. server/setup-database.sql                   — what a FRESH database gets
 *   3. server/migrations/012-add-catalog-references.sql
 *                                                  — what an EXISTING one gets
 *
 * Three hand-maintained copies of the same list is exactly the arrangement
 * that produces one wrong spelling nobody notices. The consequences are not
 * cosmetic: a name that differs between (2) and (3) means a fresh install and
 * a migrated install end up with DIFFERENT catalogues, so the same export
 * imports differently on two machines. A name that differs from (1) breaks
 * nothing visibly but makes the application's own documentation wrong.
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

const migrationRows = seededRows(readFileSync(MIGRATION_PATH, 'utf8'), 'migration 012');
const schemaRows = seededRows(readFileSync(SCHEMA_PATH, 'utf8'), 'setup-database.sql');

describe('the catalogue seed is the same in all three files', () => {
  it('found a non-empty list in each SQL file', () => {
    // Guards against the parser above quietly matching nothing, which would
    // make every comparison below trivially true.
    expect(migrationRows.length).toBe(CATALOG_SEED.length);
    expect(schemaRows.length).toBe(CATALOG_SEED.length);
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
