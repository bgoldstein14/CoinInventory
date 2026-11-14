/**
 * db/seed.ts — the reference data a fresh database is born with.
 *
 * *** SEEDED ROWS ARE RE-GENERATED, NOT MIGRATED. *** Design §4.10b is
 * explicit about this and it is the single thing that makes the SQL Server
 * import (Stage 2) a small job instead of a large one: of the owner's data,
 * 70 issuers, 1,207 denominations, 15 catalogues, 15 metal contents and 9
 * mint marks are things the APPLICATION put there, not things he typed. They
 * are rebuilt here from the same reviewed source the SQL Server migration
 * used — server/migrations/seed-data/issuers-denominations.json — and only
 * his own additions and his coins' links have to travel.
 *
 * *** A CONSEQUENCE STAGE 2 MUST HANDLE, WRITTEN DOWN HERE SO IT IS NOT
 * DISCOVERED. *** Re-seeding means DenominationId values on this side are
 * NOT the same numbers as on the owner's SQL Server. His Coins.DenominationId
 * must be re-resolved by (issuer name, label) during the import; copying the
 * integer across would attach his Morgan dollars to whatever happens to
 * occupy that id here. The same applies to CatalogId. Nothing in this file
 * can enforce that — it is recorded so the Stage 2 author reads it.
 *
 * IDEMPOTENCE. This runs on EVERY open, so it must be safe to run a thousand
 * times. Every insert is guarded on the row not already being there, and
 * nothing is ever UPDATED or DELETED:
 *
 *   - a row the user edited keeps his edit, it is not reset to the seed;
 *   - a row the user soft-deleted (IsActive = 0) stays deleted, it is not
 *     resurrected on next launch — which is the bug a naive
 *     "INSERT OR REPLACE" would introduce;
 *   - a row the user added himself is never touched.
 *
 * Matching is by the same natural key the SQL Server seed used: Issuers by
 * Name, Denominations by (IssuerId, Label), and the small lookups by their
 * one text column. Those columns are COLLATE NOCASE (see db/schema.sql), so
 * 'sear' does not become a sixteenth catalogue alongside 'Sear'.
 *
 * NOTHING HERE EMITS SQL TEXT, so the NCHAR(n) convention that
 * migrations/seed-sql.ts uses does not apply and is not needed. That
 * convention exists because a generated .sql file has to survive sqlcmd
 * choosing a code page; this seeder binds the strings as parameters straight
 * out of a UTF-8 JSON file, so the cent sign and the vulgar half never
 * become text in a file at all. migrations/seed-sql.ts and migration 013 are
 * untouched and keep emitting NCHAR(n) for the SQL Server path, which the
 * owner still needs until Stage 2 has run.
 */

import fs from 'fs';
import path from 'path';

import type { SqliteDatabase } from './driver';
import { validateSeed, type SeedFile } from '../migrations/seed-sql';

/** The authored, reviewable source. The SAME file migration 013 is generated from. */
export const SEED_DATA_PATH = path.join(
  __dirname,
  '..',
  'migrations',
  'seed-data',
  'issuers-denominations.json'
);

/**
 * The fifteen reference catalogues, in picker order.
 *
 * *** A FOURTH COPY OF A LIST THAT ALREADY EXISTS IN THREE PLACES, AND THE
 * TRIPWIRE THAT MAKES THAT SURVIVABLE. *** The others are CATALOG_SEED in
 * src/app/types/catalog-reference.ts, server/setup-database.sql and
 * server/migrations/012-add-catalog-references.sql.
 * src/app/types/catalog-seed-parity.spec.ts reads all four off disk and
 * fails the build if any of them disagrees. SQL cannot import a TypeScript
 * module and the server package cannot import from src/, which is why there
 * are four rather than one. Keep the array literal below on one line per
 * entry, in quotes: that spec parses it as text.
 */
export const CATALOG_SEED: readonly string[] = [
  'Sear',
  'RIC',
  'Hendin',
  'RPC',
  'Svoronos',
  'BMC',
  'SNG',
  'Crawford',
  'Sydenham',
  'Cohen',
  'RSC',
  'Meshorer',
  'TJC',
  'Kraay',
  'Krause (KM)',
];

/** The two categories the app has always shipped with. */
export const CATEGORY_SEED: readonly string[] = ['20th Cent. Type', 'Odd Type Set'];

/** Canonical metal-content values, in display order. */
export const METAL_CONTENT_SEED: readonly string[] = [
  'Gold',
  'Silver',
  'Platinum',
  'Palladium',
  'Copper',
  'Nickel',
  'Copper-Nickel',
  'Bronze',
  'Brass',
  'Zinc',
  'Steel',
  'Aluminum',
  'Nickel-Brass',
  'Clad',
  'Other',
];

/**
 * Major US mints plus a blank and a catch-all.
 *
 * The blank label is deliberate and must not be "tidied" into a NULL: it is
 * what a Philadelphia coin struck before 1980 carries, and Coins.MintMark
 * stores the LABEL rather than an id.
 */
export const MINT_MARK_SEED: ReadonlyArray<{ label: string; description: string }> = [
  { label: '', description: 'No mintmark / Philadelphia pre-1980' },
  { label: 'P', description: 'Philadelphia' },
  { label: 'D', description: 'Denver/Dahlonega' },
  { label: 'S', description: 'San Francisco' },
  { label: 'W', description: 'West Point' },
  { label: 'O', description: 'New Orleans' },
  { label: 'CC', description: 'Carson City' },
  { label: 'C', description: 'Charlotte' },
  { label: 'Other', description: 'Catch-all for oddities like O/S' },
];

/** What a seed run did. Logged, and asserted on by db/seed.spec.ts. */
export interface SeedReport {
  issuers: number;
  denominations: number;
  catalogs: number;
  categories: number;
  metalContents: number;
  mintMarks: number;
}

/** Reads and validates the authored JSON. Throws SeedValidationError. */
export function readSeedFile(filePath: string = SEED_DATA_PATH): SeedFile {
  return validateSeed(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/**
 * Inserts every reference row that is not already present.
 *
 * Runs inside ONE transaction. 1,269 guarded inserts outside a transaction
 * are 1,269 fsyncs and take seconds on a spinning disk; inside one they are
 * a single commit and are imperceptible. It also means a crash half way
 * through leaves no half-seeded database.
 */
export function seedReferenceData(
  database: SqliteDatabase,
  seed: SeedFile = readSeedFile()
): SeedReport {
  const report: SeedReport = {
    issuers: 0,
    denominations: 0,
    catalogs: 0,
    categories: 0,
    metalContents: 0,
    mintMarks: 0,
  };

  database.exec('BEGIN IMMEDIATE');
  try {
    report.issuers = seedIssuers(database, seed);
    report.denominations = seedDenominations(database, seed);
    report.catalogs = seedCatalogs(database);
    report.categories = seedCategories(database);
    report.metalContents = seedMetalContents(database);
    report.mintMarks = seedMintMarks(database);
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }

  return report;
}

function seedIssuers(database: SqliteDatabase, seed: SeedFile): number {
  const insert = database.prepare(
    'INSERT INTO Issuers (Name, IsoCode, Kind, ValidFrom, ValidTo, SortOrder, IsActive) ' +
      'SELECT @name, @isoCode, @kind, @validFrom, @validTo, @sortOrder, 1 ' +
      'WHERE NOT EXISTS (SELECT 1 FROM Issuers WHERE Name = @name)'
  );

  let inserted = 0;
  for (const issuer of seed.issuers) {
    inserted += Number(
      insert.run({
        name: issuer.name,
        isoCode: issuer.isoCode,
        kind: issuer.kind,
        validFrom: issuer.validFrom,
        validTo: issuer.validTo,
        sortOrder: issuer.sortOrder,
      }).changes
    );
  }
  return inserted;
}

function seedDenominations(database: SqliteDatabase, seed: SeedFile): number {
  // The issuer ids as they ended up in THIS database. They are not the
  // numbers in the JSON (there are none) and not the numbers on the owner's
  // SQL Server; they are whatever AUTOINCREMENT assigned.
  const issuerIdByKey = new Map<string, number>();
  const findIssuer = database.prepare('SELECT IssuerId FROM Issuers WHERE Name = @name');

  for (const issuer of seed.issuers) {
    const row = findIssuer.all({ name: issuer.name })[0];
    if (row) issuerIdByKey.set(issuer.key, Number(row['IssuerId']));
  }

  const insert = database.prepare(
    'INSERT INTO Denominations (Label, Country, IssuerId, FaceValue, SortOrder, IsActive) ' +
      'SELECT @label, @country, @issuerId, @faceValue, @sortOrder, 1 ' +
      'WHERE NOT EXISTS ' +
      '(SELECT 1 FROM Denominations WHERE IssuerId = @issuerId AND Label = @label)'
  );

  // Country is filled with the issuer's IsoCode where it has one and its Name
  // otherwise, exactly as migration 013 does. The column is flagged debt
  // (design §4.2) but the editor dropdown still reads it, so leaving it blank
  // would make every seeded row invisible there.
  const countryByKey = new Map<string, string>();
  for (const issuer of seed.issuers) {
    countryByKey.set(issuer.key, issuer.isoCode ?? issuer.name);
  }

  let inserted = 0;
  for (const denomination of seed.denominations) {
    const issuerId = issuerIdByKey.get(denomination.issuer);
    // validateSeed() already refuses an unknown issuer key, so this cannot
    // normally happen; skipping rather than crashing keeps a hand-edited
    // file from making the application unopenable.
    if (issuerId === undefined) continue;

    inserted += Number(
      insert.run({
        label: denomination.label,
        country: countryByKey.get(denomination.issuer) ?? denomination.issuer,
        issuerId,
        faceValue: denomination.faceValue,
        sortOrder: denomination.sortOrder,
      }).changes
    );
  }
  return inserted;
}

function seedCatalogs(database: SqliteDatabase): number {
  const insert = database.prepare(
    'INSERT INTO Catalogs (Name, SortOrder, IsActive) ' +
      'SELECT @name, @sortOrder, 1 ' +
      'WHERE NOT EXISTS (SELECT 1 FROM Catalogs WHERE Name = @name)'
  );

  let inserted = 0;
  CATALOG_SEED.forEach((name, index) => {
    inserted += Number(insert.run({ name, sortOrder: index + 1 }).changes);
  });
  return inserted;
}

function seedCategories(database: SqliteDatabase): number {
  const insert = database.prepare(
    'INSERT INTO Categories (CategoryName) SELECT @name ' +
      'WHERE NOT EXISTS (SELECT 1 FROM Categories WHERE CategoryName = @name)'
  );

  let inserted = 0;
  for (const name of CATEGORY_SEED) {
    inserted += Number(insert.run({ name }).changes);
  }
  return inserted;
}

function seedMetalContents(database: SqliteDatabase): number {
  const insert = database.prepare(
    'INSERT INTO MetalContents (MetalContentName, SortOrder, IsActive) ' +
      'SELECT @name, @sortOrder, 1 ' +
      'WHERE NOT EXISTS (SELECT 1 FROM MetalContents WHERE MetalContentName = @name)'
  );

  let inserted = 0;
  METAL_CONTENT_SEED.forEach((name, index) => {
    inserted += Number(insert.run({ name, sortOrder: index + 1 }).changes);
  });
  return inserted;
}

function seedMintMarks(database: SqliteDatabase): number {
  const insert = database.prepare(
    'INSERT INTO MintMarks (Label, Description, IsActive) ' +
      'SELECT @label, @description, 1 ' +
      'WHERE NOT EXISTS (SELECT 1 FROM MintMarks WHERE Label = @label)'
  );

  let inserted = 0;
  for (const mark of MINT_MARK_SEED) {
    inserted += Number(insert.run({ label: mark.label, description: mark.description }).changes);
  }
  return inserted;
}
