/*
 * migrations/generate-seed-migration.ts — regenerate migration 013
 *   cd server && npx tsx migrations/generate-seed-migration.ts
 *
 * Reads  server/migrations/seed-data/issuers-denominations.json
 * Writes server/migrations/013-seed-issuers-and-denominations.sql
 *
 * The .sql file is checked in deliberately: it is what the user actually
 * runs, and a generated artefact that only exists on somebody's machine is
 * not a migration. seed-sql.spec.ts regenerates it on every test run and
 * fails if the checked-in file is not exactly what the current JSON
 * produces, so the two cannot drift.
 *
 * A validation failure exits non-zero with every problem listed, and writes
 * NOTHING. A half-written seed is worse than no seed: the author would
 * review a file that does not say what the database will contain.
  */

import fs from 'fs';
import path from 'path';

import { generateSeedMigrationSql, SEED_DATA_PATH, SEED_MIGRATION_PATH } from './seed-files';
import { SeedValidationError } from './seed-sql';

function main(): void {
  let sql: string;
  try {
    sql = generateSeedMigrationSql();
  } catch (error) {
    if (error instanceof SeedValidationError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  fs.writeFileSync(SEED_MIGRATION_PATH, sql, 'utf8');
  const lines = sql.split('\n').length;
  console.log(`Wrote ${path.basename(SEED_MIGRATION_PATH)} (${lines} lines) from ${path.basename(SEED_DATA_PATH)}.`);
}

/* Run only when invoked directly, so nothing imports a file write. */
if (require.main === module) {
  main();
}
