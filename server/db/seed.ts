/**
 * Reference data a fresh database is born with (issuers, denominations,
 * catalogues, metal contents, mint marks, categories), built from
 * db/seed-data/issuers-denominations.json.
 *
 * Runs on every open, so it only inserts rows that are missing, matched by
 * natural key (Issuers by Name, Denominations by (IssuerId, Label), lookups by
 * their text column, all COLLATE NOCASE). It never updates or deletes, so user
 * edits, soft-deletes (IsActive = 0) and additions survive.
 *
 */

import fs from 'fs';
import path from 'path';

import type { SqliteDatabase } from './driver';
import { validateSeed, type SeedFile } from './seed-file';

/** The seed source. */
export const SEED_DATA_PATH = path.join(__dirname, 'seed-data', 'issuers-denominations.json');

/**
 * The fifteen reference catalogues, in picker order. Also listed in
 * src/app/types/catalog-reference.ts; src/app/types/catalog-seed-parity.spec.ts
 * checks the two agree. That spec parses this literal as text: keep one quoted entry per line.
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
 * Major US mints plus a blank and a catch-all. The blank label is intentional
 * (e.g. pre-1980 Philadelphia), and Coins.MintMark stores the label, so it
 * must not become NULL.
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
 * Inserts every reference row that is not already present, in one
 * transaction (one commit instead of ~1,300, and no half-seeded database).
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
  // Issuer ids as assigned by AUTOINCREMENT in this database.
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

  // Country is the issuer's IsoCode, else its Name (as migration 013 does);
  // the editor dropdown still reads this column.
  const countryByKey = new Map<string, string>();
  for (const issuer of seed.issuers) {
    countryByKey.set(issuer.key, issuer.isoCode ?? issuer.name);
  }

  let inserted = 0;
  for (const denomination of seed.denominations) {
    const issuerId = issuerIdByKey.get(denomination.issuer);
    // validateSeed() rejects unknown issuer keys; skip rather than crash on a hand-edited file.
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
