/**
 * db/seed.spec.ts — the reference data, and the three ways re-seeding goes
 * wrong.
 *
 * db/seed.ts runs on EVERY open, which is what makes "is this a new
 * database?" a question nobody has to answer. That only works if the seed is
 * genuinely idempotent, and "idempotent" here means three separate things,
 * each with its own way of failing silently:
 *
 *   1. IT MUST NOT DUPLICATE. 70 issuers must stay 70 on the thousandth
 *      launch. The consequence of a duplicate is worse than untidiness —
 *      migrations/seed-sql.ts's header spells it out: two '8 Reales' rows
 *      under Mexico make every resolution of that text AMBIGUOUS, and
 *      ambiguous resolves to NULL. A duplicated seed row does not add a
 *      denomination, it DELETES one.
 *   2. IT MUST NOT OVERWRITE. A row the user renamed keeps his name.
 *   3. IT MUST NOT RESURRECT. A row the user soft-deleted stays deleted. An
 *      `INSERT OR REPLACE` would bring every removed denomination back on
 *      the next launch, which looks exactly like the delete button not
 *      working.
 *
 * Design §4.10b is why this exists at all: the seeded rows are REGENERATED
 * rather than migrated, so Stage 2 only has to move the owner's own
 * additions and his coins' links.
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

      // The numbers design §4.10b quotes. If the JSON grows these move, and
      // that is fine — what must not happen is a count that disagrees with
      // the file it was generated from.
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
    // The join is by issuer NAME, through ids AUTOINCREMENT assigned moments
    // earlier. A mistake here leaves rows with IssuerId NULL, which looks
    // like perfectly ordinary unresolved data and is invisible until the
    // user opens the picker and finds Mexico empty.
    const database = freshDatabase();
    try {
      seedReferenceData(database);
      expect(count(database, 'Denominations WHERE IssuerId IS NULL')).toBe(0);
    } finally {
      database.close();
    }
  });

  it('fills Country from the issuer ISO code where there is one, and the name otherwise', async () => {
    // Exactly what migration 013 does. The column is flagged debt (design
    // §4.2) but the editor dropdown still reads it, so a blank would make
    // every seeded row invisible there.
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
    // migrations/seed-sql.ts emits every non-ASCII character as NCHAR(n),
    // because a generated .sql file's correctness would otherwise depend on
    // sqlcmd picking the right code page. This seeder binds the strings as
    // parameters straight out of a UTF-8 JSON file, so they never become
    // text in a file at all and the convention does not apply — but the
    // characters still have to arrive.
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
    // The duplicate that DELETES a denomination rather than adding one.
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
      // ...and the seed did NOT take the now-free name as an invitation to
      // insert a second row. (It will: matching is by name, and the name is
      // no longer taken. That is the documented behaviour and it is what
      // migration 013 does too — recorded here so it is a known
      // consequence of renaming rather than a surprise.)
      expect(count(database, "Issuers WHERE Name = 'Mexico'")).toBe(1);
      // Crucially, the user's row kept its denominations; the new one has none.
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
    // The failure an `INSERT OR REPLACE` would introduce: every removed
    // catalogue comes back on the next launch, which reads to the user as
    // the delete button not working.
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
    // The lookup name columns are COLLATE NOCASE (see db/schema.sql), which
    // restores SQL Server's case-insensitive default. Without it 'sear'
    // would become a sixteenth catalogue on the next launch.
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
    // A coin struck in Philadelphia before 1980 carries no mint mark, and
    // Coins.MintMark stores the LABEL. "Tidying" the empty string into a
    // NULL would make those coins unselectable.
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
    // 1,274 guarded inserts outside a transaction would be 1,274 commits,
    // and a crash in the middle would leave a database that is seeded enough
    // to look finished and not enough to work.
    const database = freshDatabase();
    try {
      const seed = readSeedFile();
      const broken = {
        issuers: seed.issuers,
        // A label far past NVARCHAR(100) is not what fails here — SQLite
        // does not care — so break it with something SQLite does enforce:
        // a NOT NULL column.
        denominations: [
          ...seed.denominations.slice(0, 5),
          { issuer: seed.issuers[0].key, label: null as unknown as string, faceValue: null, sortOrder: 1 },
        ],
      };

      expect(() => seedReferenceData(database, broken as never)).toThrow();
      // Rolled all the way back: not one issuer survived either.
      expect(count(database, 'Issuers')).toBe(0);
      expect(count(database, 'Denominations')).toBe(0);
    } finally {
      database.close();
    }
  });
});

describe('what Stage 2 must know about the seeded ids', () => {
  it('assigns DenominationId by AUTOINCREMENT, so the numbers are local to this database', async () => {
    // Written as a test rather than only as a comment, because getting this
    // wrong in Stage 2 silently attaches the owner's Morgan dollars to
    // whatever happens to occupy that id here. His Coins.DenominationId must
    // be re-resolved by (issuer name, label), not copied.
    const [us] = await queryRows(
      "SELECT DenominationId AS id FROM Denominations WHERE Label = '$1' AND Country = 'US'"
    );
    // The legacy SQL Server database seeded '$1' at DenominationId 11.
    // There is no reason for the two to agree, and this asserts only that
    // the id is a real key — the point is that nothing may ASSUME 11.
    expect(typeof us['id']).toBe('number');
    expect(us['id']).toBeGreaterThan(0);
  });

  it('never reuses an id after a hard delete, because the keys are AUTOINCREMENT', async () => {
    // A bare INTEGER PRIMARY KEY picks max(rowid) + 1 and so RECYCLES the id
    // of a deleted row. AUTOINCREMENT does not. Without it, deleting the
    // last catalogue and adding another would hand the new one an id that
    // coins, exported CSVs and an open browser tab still believe means
    // something else.
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
