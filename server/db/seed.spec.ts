/**
 * The reference data seed. It runs on every open, so it must be idempotent:
 *
 *   1. no duplicates (a duplicate '8 Reales' under Mexico would make that
 *      label ambiguous, which resolves to NULL);
 *   2. no overwriting a row the user renamed;
 *   3. no resurrecting a row the user soft-deleted.
 */

import { describe, it, expect } from 'vitest';

import { queryRows, withTestDb } from '../test-support/sqlite-test-db';
import { openSqliteDatabase } from './driver';
import { applySchema } from './schema';
import {
  CATALOG_SEED,
  CATEGORY_SEED,
  METAL_CONTENT_SEED,
  MINT_MARK_SEED,
  readSeedFile,
  seedReferenceData,
} from './seed';

/** A throwaway database, so a test can seed it as many times as it likes. */
function freshDatabase() {
  const database = openSqliteDatabase({
    filename: ':memory:',
    enableForeignKeyConstraints: true,
    busyTimeoutMs: 1000,
  });
  applySchema(database);
  return database;
}

const count = (database: ReturnType<typeof freshDatabase>, table: string): number =>
  Number(database.prepare(`SELECT COUNT(*) AS c FROM ${table}`).all()[0]['c']);

describe('the first seed', () => {
  it('inserts exactly what the authored JSON contains', () => {
    const seed = readSeedFile();
    const database = freshDatabase();
    try {
      const report = seedReferenceData(database, seed);

      // Counts must match the source file.
      expect(report.issuers).toBe(seed.issuers.length);
      expect(report.denominations).toBe(seed.denominations.length);
      expect(count(database, 'Issuers')).toBe(seed.issuers.length);
      expect(count(database, 'Denominations')).toBe(seed.denominations.length);

      expect(report.catalogs).toBe(CATALOG_SEED.length);
      expect(report.categories).toBe(CATEGORY_SEED.length);
      expect(report.metalContents).toBe(METAL_CONTENT_SEED.length);
      expect(report.mintMarks).toBe(MINT_MARK_SEED.length);
    } finally {
      database.close();
    }
  });

  it('links every denomination to its issuer', () => {
    // Denominations join to issuers by name; a mistake leaves IssuerId NULL.
    const database = freshDatabase();
    try {
      seedReferenceData(database);
      expect(count(database, 'Denominations WHERE IssuerId IS NULL')).toBe(0);
    } finally {
      database.close();
    }
  });

  it('fills Country from the issuer ISO code where there is one, and the name otherwise', async () => {
    // Country = IsoCode or Name, as migration 013 does; the editor dropdown reads it.
    const [mexican] = await queryRows(
      "SELECT Country FROM Denominations WHERE Label = '8 Reales' AND Country = 'MX' LIMIT 1"
    );
    expect(mexican?.['Country']).toBe('MX');

    const romanIssuers = await queryRows(
      "SELECT IsoCode FROM Issuers WHERE Name = 'Roman Empire'"
    );
    expect(romanIssuers[0]?.['IsoCode']).toBeNull();

    const roman = await queryRows(
      "SELECT DISTINCT Country FROM Denominations WHERE IssuerId = " +
        "(SELECT IssuerId FROM Issuers WHERE Name = 'Roman Empire')"
    );
    expect(roman.map((row) => row['Country'])).toEqual(['Roman Empire']);
  });

  it('carries the non-ASCII labels through intact', () => {
    // Non-ASCII characters must arrive intact (bound as parameters from UTF-8 JSON).
    const database = freshDatabase();
    try {
      seedReferenceData(database);
      const labels = database
        .prepare("SELECT Label FROM Denominations WHERE Country = 'US' ORDER BY SortOrder")
        .all()
        .map((row) => row['Label']);
      expect(labels).toContain('½¢');
      expect(labels).toContain('1¢');
      expect(
        database.prepare("SELECT Label FROM Denominations WHERE Label = '£1'").all().length
      ).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});

describe('re-seeding is idempotent', () => {
  it('inserts nothing the second time, or the tenth', () => {
    const seed = readSeedFile();
    const database = freshDatabase();
    try {
      seedReferenceData(database, seed);
      const after = {
        issuers: count(database, 'Issuers'),
        denominations: count(database, 'Denominations'),
        catalogs: count(database, 'Catalogs'),
        categories: count(database, 'Categories'),
        metalContents: count(database, 'MetalContents'),
        mintMarks: count(database, 'MintMarks'),
      };

      for (let run = 2; run <= 10; run++) {
        const report = seedReferenceData(database, seed);
        expect(report, `run ${run}`).toEqual({
          issuers: 0,
          denominations: 0,
          catalogs: 0,
          categories: 0,
          metalContents: 0,
          mintMarks: 0,
        });
      }

      expect({
        issuers: count(database, 'Issuers'),
        denominations: count(database, 'Denominations'),
        catalogs: count(database, 'Catalogs'),
        categories: count(database, 'Categories'),
        metalContents: count(database, 'MetalContents'),
        mintMarks: count(database, 'MintMarks'),
      }).toEqual(after);
    } finally {
      database.close();
    }
  });

  it('never produces the same label twice under one issuer', () => {
    // A duplicate would make the label ambiguous, effectively deleting it.
    const database = freshDatabase();
    try {
      seedReferenceData(database);
      seedReferenceData(database);

      const duplicates = database
        .prepare(
          'SELECT IssuerId, Label, COUNT(*) AS c FROM Denominations ' +
            'GROUP BY IssuerId, Label HAVING COUNT(*) > 1'
        )
        .all();
      expect(duplicates).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('does not overwrite a row the user has renamed', () => {
    const database = freshDatabase();
    try {
      seedReferenceData(database);
      database.prepare("UPDATE Issuers SET Name = 'Estados Unidos Mexicanos' WHERE Name = 'Mexico'").run();

      seedReferenceData(database);

      // The rename stands...
      expect(count(database, "Issuers WHERE Name = 'Estados Unidos Mexicanos'")).toBe(1);
      // ...but matching is by name, so the freed name 'Mexico' is seeded again
      // (same as migration 013).
      expect(count(database, "Issuers WHERE Name = 'Mexico'")).toBe(1);
      // The user's row kept its denominations; the new one has none.
      const renamed = database
        .prepare(
          'SELECT COUNT(*) AS c FROM Denominations WHERE IssuerId = ' +
            "(SELECT IssuerId FROM Issuers WHERE Name = 'Estados Unidos Mexicanos')"
        )
        .all()[0];
      expect(Number(renamed['c'])).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it('does not resurrect a row the user soft-deleted', () => {
    // INSERT OR REPLACE would bring deleted rows back on every launch.
    const database = freshDatabase();
    try {
      seedReferenceData(database);
      database.prepare("UPDATE Catalogs SET IsActive = 0 WHERE Name = 'Sear'").run();
      database.prepare("UPDATE Denominations SET IsActive = 0 WHERE Label = '3CS'").run();

      seedReferenceData(database);

      expect(
        database.prepare("SELECT IsActive FROM Catalogs WHERE Name = 'Sear'").all()[0]['IsActive']
      ).toBe(0);
      expect(count(database, 'Catalogs')).toBe(CATALOG_SEED.length);
      expect(count(database, "Denominations WHERE Label = '3CS' AND IsActive = 1")).toBe(0);
    } finally {
      database.close();
    }
  });

  it('matches case-insensitively, so a differently-cased row is not a second row', () => {
    // COLLATE NOCASE: 'sear' must not become a sixteenth catalogue.
    const database = freshDatabase();
    try {
      seedReferenceData(database);
      database.prepare("UPDATE Catalogs SET Name = 'SEAR' WHERE Name = 'Sear'").run();

      const report = seedReferenceData(database);
      expect(report.catalogs).toBe(0);
      expect(count(database, 'Catalogs')).toBe(CATALOG_SEED.length);
    } finally {
      database.close();
    }
  });

  it('leaves rows the user added alone', () => {
    const database = freshDatabase();
    try {
      seedReferenceData(database);
      database.prepare("INSERT INTO Catalogs (Name, SortOrder, IsActive) VALUES ('My Notebook', 99, 1)").run();

      seedReferenceData(database);

      expect(count(database, "Catalogs WHERE Name = 'My Notebook'")).toBe(1);
      expect(count(database, 'Catalogs')).toBe(CATALOG_SEED.length + 1);
    } finally {
      database.close();
    }
  });
});

describe('the small lookup seeds', () => {
  it('numbers the catalogues 1..15 in picker order', async () => {
    const rows = await queryRows('SELECT Name, SortOrder FROM Catalogs ORDER BY SortOrder');
    expect(rows.map((row) => row['Name'])).toEqual([...CATALOG_SEED]);
    expect(rows.map((row) => row['SortOrder'])).toEqual(CATALOG_SEED.map((_, i) => i + 1));
  });

  it('keeps the blank mint mark, which is a real value and not missing data', async () => {
    // Pre-1980 Philadelphia coins have no mint mark; Coins.MintMark stores the label.
    const rows = await queryRows("SELECT Label, Description FROM MintMarks WHERE Label = ''");
    expect(rows).toHaveLength(1);
    expect(rows[0]['Description']).toBe('No mintmark / Philadelphia pre-1980');
  });

  it('keeps the metal contents in their intended order', async () => {
    const rows = await queryRows('SELECT MetalContentName FROM MetalContents ORDER BY SortOrder');
    expect(rows.map((row) => row['MetalContentName'])).toEqual([...METAL_CONTENT_SEED]);
  });
});

describe('the whole seed runs in one transaction', () => {
  it('leaves nothing behind when it fails part way through', async () => {
    // One transaction: a crash mid-seed must not leave a half-seeded database.
    const database = freshDatabase();
    try {
      const seed = readSeedFile();
      const broken = {
        issuers: seed.issuers,
        // Break it with a NOT NULL violation (SQLite doesn't enforce lengths).
        denominations: [
          ...seed.denominations.slice(0, 5),
          { issuer: seed.issuers[0].key, label: null as unknown as string, faceValue: null, sortOrder: 1 },
        ],
      };

      expect(() => seedReferenceData(database, broken as never)).toThrow();
      // Rolled back completely: no issuers either.
      expect(count(database, 'Issuers')).toBe(0);
      expect(count(database, 'Denominations')).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe('what Stage 2 must know about the seeded ids', () => {
  it('assigns DenominationId by AUTOINCREMENT, so the numbers are local to this database', async () => {
    // Ids are assigned locally, so the SQL Server import must re-resolve
    // Coins.DenominationId by (issuer name, label), not copy it.
    const [us] = await queryRows(
      "SELECT DenominationId AS id FROM Denominations WHERE Label = '$1' AND Country = 'US'"
    );
    // The legacy database had '$1' at id 11; nothing may assume that here.
    expect(typeof us['id']).toBe('number');
    expect(us['id']).toBeGreaterThan(0);
  });

  it('never reuses an id after a hard delete, because the keys are AUTOINCREMENT', async () => {
    // AUTOINCREMENT: a deleted top row's id must not be reused.
    await withTestDb((database) => {
      database.prepare("INSERT INTO Catalogs (Name, SortOrder, IsActive) VALUES ('Temp', 98, 1)").run();
    });
    const [created] = await queryRows("SELECT CatalogId AS id FROM Catalogs WHERE Name = 'Temp'");

    await withTestDb((database) => {
      database.prepare("DELETE FROM Catalogs WHERE Name = 'Temp'").run();
      database.prepare("INSERT INTO Catalogs (Name, SortOrder, IsActive) VALUES ('Next', 98, 1)").run();
    });
    const [next] = await queryRows("SELECT CatalogId AS id FROM Catalogs WHERE Name = 'Next'");

    expect(next['id']).toBe((created['id'] as number) + 1);

    await withTestDb((database) => {
      database.prepare("DELETE FROM Catalogs WHERE Name = 'Next'").run();
    });
  });
});
