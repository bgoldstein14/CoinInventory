/**
 * migrations/migration-012.spec.ts — checking migration 012 by reading it.
 *
 * THE MIGRATION HAS NOT BEEN RUN. NOBODY SHOULD SAY OTHERWISE.
 * There is no SQL Server on the development machine and no harness anywhere
 * in this project that executes a .sql file — the mssql driver is mocked in
 * every spec. So migration 012 is UNVERIFIED against a real database, and
 * this file does not change that. What it does is parse the script and check
 * the things that actually go wrong in a migration of this shape. The
 * technique, and every assertion style below, is taken from
 * migration-010.spec.ts; read that one first if this is unfamiliar.
 *
 * WHAT MIGRATION 012 DOES
 *   Creates the `Catalogs` lookup table, seeds it with the fifteen
 *   catalogues this collection uses, and adds two nullable columns to Coins:
 *   `CatalogId` (FK) and `CatalogNumber`. Nothing reads them yet when it
 *   runs, and it never writes to a column that already existed.
 *
 * THE FAILURES EACH BLOCK STANDS IN FOR
 *
 *   - THE SCRIPT AND setup-database.sql DISAGREE, so a database built fresh
 *     and one brought forward by this migration end up with different
 *     columns, and the parameter bindings in db/coin-fields.ts can only be
 *     right for one of them. That is the exact failure db/coin-fields.spec.ts
 *     exists for, one layer down.
 *
 *   - A SECOND RUN FAILS HALFWAY. Every step has to be guarded, and the
 *     SEED in particular has to be guarded row by row rather than "is the
 *     table empty" — a user who deleted `Kraay` must not have it silently
 *     resurrected, and a user who added `Peus` must not get fifteen
 *     duplicates.
 *
 *   - A COLUMN IS REFERENCED IN THE BATCH THAT CREATES IT. SQL Server
 *     compiles a whole batch before running any of it, so the FOREIGN KEY
 *     that names `CatalogId` must sit in a later batch than the ALTER that
 *     adds it. This is the single easiest mistake to make in a file like
 *     this and it is invisible to the eye.
 *
 *   - THE COLUMNS GET A DEFAULT. They must not. A default would attribute
 *     every coin in the collection to a catalogue nobody chose,
 *     which is precisely the "confidently wrong seeded data" the design
 *     names as a failure even if everything else works.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const migrationPath = path.join(__dirname, '012-add-catalog-references.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

const schema = fs.readFileSync(path.join(__dirname, '..', 'setup-database.sql'), 'utf8');
const coinsDdl = schema.match(/CREATE TABLE Coins \(([\s\S]*?)\n\);/)?.[1] ?? '';
const catalogsDdl = schema.match(/CREATE TABLE Catalogs \(([\s\S]*?)\n\);/)?.[1] ?? '';

/** The file split on its batch separators, so "same batch" is a real question. */
const batches = migration.split(/^\s*GO\s*$/m);

/**
 * A batch with its `--` comments and its string literals removed, because
 * SQL Server only compiles CODE. A column named inside a comment or inside a
 * PRINT cannot cause an "Invalid column name", so counting raw occurrences
 * would flag this file's own explanatory prose as a bug.
 */
function executableSql(batch: string): string {
  return batch
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * The catalogue names the migration seeds, in the order it seeds them.
 *
 * Read out of the VALUES list rather than asserted as one giant string, so a
 * failure says which catalogue is wrong instead of printing a forty-line
 * diff.
 */
function seededCatalogNames(): string[] {
  const seedBlock = migration.match(/FROM \(VALUES([\s\S]*?)\) AS Seed/)?.[1] ?? '';
  return [...seedBlock.matchAll(/\(\s*N?'((?:[^']|'')*)'\s*,/g)]
    .map(match => match[1].replace(/''/g, "'"));
}

describe('the migration file itself', () => {
  it('is numbered 012 and follows the 010 already in the tree', () => {
    // Deliberately NOT asserting that 011 exists. Catalogue references are
    // independent of the denomination work that owns that number (design
    // Nothing in the denomination work depends on it, and nothing in it
    // depends on the denomination work"), and the two are being built in
    // parallel. Requiring a file this change does not own would make this
    // spec fail for a reason that has nothing to do with this migration.
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(
      fs.existsSync(path.join(__dirname, '010-add-collection-status-and-storage-location.sql'))
    ).toBe(true);
  });

  it('targets the right database and says how to run it', () => {
    expect(migration).toMatch(/USE CoinInventory;/);
    expect(migration).toMatch(/sqlcmd -S localhost -d CoinInventory/);
  });

  it('parsed into several batches, so the tests below are not vacuous', () => {
    // If the GO-splitting regex ever stopped matching, the "different
    // batches" tests would pass by accident, which is worse than no test.
    expect(batches.length).toBeGreaterThan(4);
  });

  it('never writes to a column that existed before it ran', () => {
    // THE safety property of this migration, and the reason it is reversible
    // by hand: it only ever CREATES. There is no UPDATE of Coins anywhere in
    // it, so no existing value can be rewritten, trimmed or nulled.
    expect(executableSql(migration)).not.toMatch(/UPDATE\s+Coins/i);
  });
});

describe('the Catalogs table', () => {
  it('is created exactly as setup-database.sql declares it', () => {
    // Fresh-build and migrated databases must agree column for column.
    expect(migration).toMatch(/CREATE TABLE Catalogs \(/);
    expect(migration).toMatch(/CatalogId\s+INT\s+IDENTITY\(1,1\)\s+PRIMARY KEY/);
    expect(migration).toMatch(/Name\s+NVARCHAR\(60\)\s+NOT NULL/);
    expect(migration).toMatch(/SortOrder\s+INT\s+NOT NULL/);
    expect(migration).toMatch(/IsActive\s+BIT\s+NOT NULL/);

    expect(catalogsDdl).toMatch(/CatalogId\s+INT\s+IDENTITY\(1,1\)\s+PRIMARY KEY/);
    expect(catalogsDdl).toMatch(/Name\s+NVARCHAR\(60\)\s+NOT NULL/);
    expect(catalogsDdl).toMatch(/SortOrder\s+INT\s+NOT NULL DEFAULT 0/);
    expect(catalogsDdl).toMatch(/IsActive\s+BIT\s+NOT NULL DEFAULT 1/);
  });

  it('is guarded on the table not already existing', () => {
    expect(migration).toMatch(/IF OBJECT_ID\('dbo\.Catalogs', ?'U'\) IS NULL/);
    expect(migration).toMatch(/Catalogs table already exists - nothing to do/);
  });

  it('is dropped by setup-database.sql AFTER Coins, which references it', () => {
    // setup-database.sql re-runs from scratch. Dropping Catalogs before the
    // table whose foreign key points at it fails with a reference error and
    // leaves the script half-applied.
    const dropCoins = schema.indexOf("IF OBJECT_ID('Coins', 'U') IS NOT NULL DROP TABLE Coins;");
    const dropCatalogs = schema.indexOf("IF OBJECT_ID('Catalogs', 'U') IS NOT NULL DROP TABLE Catalogs;");
    expect(dropCoins).toBeGreaterThan(-1);
    expect(dropCatalogs).toBeGreaterThan(dropCoins);
  });

  it('has its foreign key added by an ALTER after both tables exist', () => {
    // The other half of the same ordering problem. Coins is created first in
    // setup-database.sql and Catalogs is a lookup table further down, so the
    // constraint CANNOT be an inline REFERENCES on the column -- the
    // referenced table does not exist yet at that point. It goes in the
    // "Foreign keys added after the tables" section instead, which is also
    // what lets this file and the migration read alike.
    const createCatalogs = schema.indexOf('CREATE TABLE Catalogs (');
    const alterFk = schema.indexOf('ADD CONSTRAINT FK_Coins_Catalog');
    expect(createCatalogs).toBeGreaterThan(-1);
    expect(alterFk).toBeGreaterThan(createCatalogs);
    // And the column itself must NOT carry an inline REFERENCES.
    expect(coinsDdl).not.toMatch(/CatalogId[^\n]*REFERENCES/);
  });
});

describe('the seeded catalogues', () => {
  const EXPECTED = [
    'Sear', 'RIC', 'Hendin', 'RPC', 'Svoronos', 'BMC', 'SNG', 'Crawford',
    'Sydenham', 'Cohen', 'RSC', 'Meshorer', 'TJC', 'Kraay', 'Krause (KM)'
  ];

  it('seeds the fourteen catalogues the image matcher knows, plus Krause', () => {
    // The list is not arbitrary: the first fourteen are CATALOG_PREFIXES
    // from src/app/services/image-matching/filename-vocabulary.ts, which was
    // built by reading real photo filenames. A frontend spec
    // (src/app/types/catalog-seed-parity.spec.ts) holds this file and
    // CATALOG_SEED together; this one pins the SQL on its own so a server
    // test failure names the problem without the Angular side being present.
    expect(seededCatalogNames()).toEqual(EXPECTED);
  });

  it('numbers SortOrder 1..15 so the picker opens in that order', () => {
    const orders = [...migration.matchAll(/\(\s*N?'(?:[^']|'')*'\s*,\s*(\d+)\s*\)/g)]
      .map(match => Number(match[1]));
    expect(orders).toEqual(EXPECTED.map((_, index) => index + 1));
  });

  it('seeds row by row, so a second run cannot duplicate or resurrect', () => {
    // NOT "insert everything if the table is empty". A user who removed
    // `Kraay` would have it silently returned, and a user who added one of
    // his own would get fifteen duplicates. The guard is per NAME.
    expect(migration).toMatch(
      /WHERE NOT EXISTS \(\s*SELECT 1 FROM Catalogs WHERE Catalogs\.Name = Seed\.Name\s*\)/
    );
  });

  it('seeds in a LATER batch than the one creating the table', () => {
    const createBatch = batches.findIndex(batch => /CREATE TABLE Catalogs/.test(batch));
    const seedBatch = batches.findIndex(batch => /INSERT INTO Catalogs/.test(batch));
    expect(createBatch).toBeGreaterThanOrEqual(0);
    expect(seedBatch).toBeGreaterThan(createBatch);
  });
});

describe('Coins.CatalogId and Coins.CatalogNumber', () => {
  it('are added exactly as setup-database.sql declares them', () => {
    expect(migration).toMatch(/ALTER TABLE Coins\s+ADD CatalogId INT NULL;/);
    expect(migration).toMatch(/ALTER TABLE Coins\s+ADD CatalogNumber NVARCHAR\(50\) NULL;/);

    expect(coinsDdl).toMatch(/CatalogId\s+INT\s+NULL/);
    expect(coinsDdl).toMatch(/CatalogNumber\s+NVARCHAR\(50\)\s+NULL/);
  });

  it('are NOT given a default', () => {
    // A default would attribute every coin in the collection to one nobody
    // never chose. "Nothing recorded" is the honest state of this field for
    // essentially every modern coin.
    expect(migration).not.toMatch(/ADD CatalogId INT[^;]*DEFAULT/);
    expect(migration).not.toMatch(/ADD CatalogNumber NVARCHAR\(50\)[^;]*DEFAULT/);
  });

  it('are nullable, because almost no coin has a catalogue reference', () => {
    expect(migration).not.toMatch(/ADD CatalogId INT NOT NULL/);
    expect(migration).not.toMatch(/ADD CatalogNumber NVARCHAR\(50\) NOT NULL/);
  });

  it('guards both ALTERs on the column not already existing', () => {
    for (const column of ['CatalogId', 'CatalogNumber']) {
      const guard = new RegExp(
        `IF NOT EXISTS \\(\\s*SELECT 1 FROM sys\\.columns\\s*WHERE object_id = OBJECT_ID\\('dbo\\.Coins'\\) AND name = '${column}'\\s*\\)`
      );
      expect(migration).toMatch(guard);
    }
  });

  it('says so out loud when there is nothing to do', () => {
    // House style, set by 009 and 010: the script reports what it did either
    // way, so a silent run never has to be interpreted.
    expect(migration).toMatch(/Coins\.CatalogId already exists - nothing to do/);
    expect(migration).toMatch(/Coins\.CatalogNumber already exists - nothing to do/);
  });
});

describe('the foreign key', () => {
  it('is named, not left to a generated name', () => {
    // A generated name differs on every database, so the next migration that
    // needs to drop it has to go hunting in sys.objects first.
    expect(migration).toMatch(
      /ADD CONSTRAINT FK_Coins_Catalog\s+FOREIGN KEY \(CatalogId\) REFERENCES Catalogs\(CatalogId\)/
    );
    expect(coinsDdl + schema).toMatch(/FK_Coins_Catalog/);
  });

  it('is guarded so a second run does not fail on it', () => {
    expect(migration).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM sys\.foreign_keys WHERE name = 'FK_Coins_Catalog'/);
  });

  it('does NOT cascade a delete', () => {
    // Deleting a catalogue must never delete coins. Removal in
    // the UI is a soft delete (IsActive = 0) and even a hand-run DELETE
    // should fail loudly rather than take the coins with it.
    expect(migration).not.toMatch(/FK_Coins_Catalog[\s\S]{0,200}ON DELETE CASCADE/);
  });
});

describe('batching', () => {
  it('never references CatalogId in the same batch that creates it', () => {
    // THE failure mode of this kind of script: SQL Server compiles a whole
    // batch before executing any of it, so a FOREIGN KEY naming a column the
    // ALTER above it has not created yet makes the entire batch fail with
    // "Invalid column name" — and the migration half-applies.
    const creating = batches.filter(batch => /ADD CatalogId/.test(batch));
    expect(creating).toHaveLength(1);

    // Comments and PRINT text are stripped first; this file discusses the
    // column at length in prose. Exactly ONE mention must survive, and it is
    // the ADD itself. (The sys.columns guard names it too, but as a string
    // literal, which is stripped — it looks the column up by name rather
    // than reading it, so it is harmless either way.)
    const uses = executableSql(creating[0]).match(/CatalogId/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(executableSql(creating[0])).toMatch(/ADD CatalogId INT NULL/);
    expect(executableSql(creating[0])).not.toMatch(/FOREIGN KEY|SELECT .* FROM Coins\b/);
  });

  it('adds the foreign key in a later batch than the column it constrains', () => {
    const alterBatch = batches.findIndex(batch => /ADD CatalogId/.test(batch));
    const fkBatch = batches.findIndex(batch => /FK_Coins_Catalog/.test(batch));
    expect(alterBatch).toBeGreaterThanOrEqual(0);
    expect(fkBatch).toBeGreaterThan(alterBatch);
  });

  it('puts the summary counts in a batch of their own, after everything', () => {
    const summaryBatch = batches.findIndex(batch => /Coins after migration 012/.test(batch));
    const fkBatch = batches.findIndex(batch => /FK_Coins_Catalog/.test(batch));
    expect(summaryBatch).toBeGreaterThan(fkBatch);
  });
});

describe('what the migration promises the owner', () => {
  it('states in the file that no existing coin is changed', () => {
    // Not decoration. This is the property the whole change rests on, and
    // the next person to read the file must not have to infer it from the
    // absence of an UPDATE.
    expect(migration).toMatch(/NO EXISTING COIN IS CHANGED/);
  });

  it('states that it does NOT look anything up', () => {
    // A catalogue reference cannot fill in year, type or composition: Sear,
    // Hendin and Krause have no machine-readable source. Saying so in the
    // migration is what stops the question being re-answered from memory.
    expect(migration).toMatch(/does NOT look anything up|no auto-fill/i);
  });
});
