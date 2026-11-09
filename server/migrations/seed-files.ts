/*
 * migrations/seed-files.ts — where the seed lives on disk
 * Split out from generate-seed-migration.ts for one reason: that file has a
 * `require.main === module` guard so it can be run as a script, and a spec
 * that imported it would evaluate that guard under a test runner that has no
 * `require`. The paths and the one pure read belong somewhere both the
 * script and the spec can import without side effects.
  */

import fs from 'fs';
import path from 'path';

import { buildSeedMigrationSql } from './seed-sql';

/** The authored, reviewable source. Owned by whoever curates the data. */
export const SEED_DATA_PATH = path.join(__dirname, 'seed-data', 'issuers-denominations.json');

/** The generated migration. Checked in, because it is what gets run. */
export const SEED_MIGRATION_PATH = path.join(__dirname, '013-seed-issuers-and-denominations.sql');

/**
 * Read the authored JSON and turn it into the text of migration 013.
 *
 * Throws SeedValidationError, with every problem listed, if the JSON is not
 * usable. Writes nothing: a half-written seed is worse than no seed, because
 * the author would review a file that does not say what the database will
 * contain.
 */
export function generateSeedMigrationSql(): string {
  const raw = fs.readFileSync(SEED_DATA_PATH, 'utf8');
  return buildSeedMigrationSql(JSON.parse(raw));
}
