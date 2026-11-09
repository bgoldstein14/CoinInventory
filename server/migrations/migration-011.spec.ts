/**
 * migrations/migration-011.spec.ts — checking migration 011 by reading it.
 *
 * THERE IS NO SQL SERVER HERE AND THIS MIGRATION HAS NOT BEEN RUN
 * Same situation as migration-010.spec.ts, and the same answer: the file is
 * parsed rather than executed, and every assertion stands in for a specific
 * way a migration of this shape fails in the field. Nobody should read a
 * green run here as "the migration works".
 *
 * 011 is the FIRST of three steps and is deliberately the only one that
 * touches the schema:
 *
 *   011  this file — Issuers, Denominations.IssuerId/FaceValue,
 *        Coins.DenominationId. Nothing is seeded and nothing is resolved, so
 *        it changes no value the user can see and is entirely reversible.
 *   013  the generated seed (issuers and their denominations).
 *   014  resolution of existing coins, plus the unresolved report.
 *
 * (012 is the catalogue-references migration, built in parallel. The gap is
 * intentional and the numbers are not re-used.)
 *
 * WHAT GOES WRONG WITH A FILE LIKE THIS
 *
 *   - it disagrees with setup-database.sql, so a database built fresh and a
 *     database migrated end up with different schemas and every binding is
 *     right for only one of them. The three DDL blocks are therefore
 *     compared CHARACTER FOR CHARACTER between the two files, not merely
 *     pattern-matched in each;
 *
 *   - an ALTER is unguarded, so a second run dies with "Column names in each
 *     table must be unique" and whoever ran it cannot tell how much of the
 *     first run took effect;
 *
 *   - a new column is NOT NULL, so the ALTER is rejected outright against a
 *     table that already has rows;
 *
 *   - a FOREIGN KEY naming a column sits in the SAME batch as the ALTER that
 *     creates it. SQL Server compiles a batch before it runs any of it, so
 *     that batch dies with "Invalid column name" and the migration
 *     half-applies. This is the easiest mistake to make here and it is
 *     invisible to the eye;
 *
 *   - something writes Coins.Denomination. That column is READ-ONLY for the
 *     whole of this change, and that single rule is what makes
 *     every step recoverable.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const migrationPath = path.join(__dirname, '011-add-issuers-and-denomination-links.sql');

/** Line endings normalised so "character for character" is a fair question. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

const migration = lf(fs.readFileSync(migrationPath, 'utf8'));
const schema = lf(fs.readFileSync(path.join(__dirname, '..', 'setup-database.sql'), 'utf8'));

const coinsDdl = schema.match(/CREATE TABLE Coins \(([\s\S]*?)\n\);/)?.[1] ?? '';
const denominationsDdl = schema.match(/CREATE TABLE Denominations \(([\s\S]*?)\n\);/)?.[1] ?? '';

/** The file split on its batch separators, so "same batch" is a real question. */
const batches = migration.split(/^\s*GO\s*$/m);

/**
 * A batch with its `--` comments and its string literals removed.
 *
 * SQL Server only compiles CODE. A column named in a comment or inside a
 * PRINT cannot cause an "Invalid column name", so counting raw occurrences
 * would flag this file's own explanatory prose as a bug.
 */
function executableSql(batch: string): string {
  return batch
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Every column assigned by an UPDATE in the file: the SET clause of each
 * UPDATE, chopped at the first FROM / WHERE / OUTPUT that ends it.
 *
 * Written as a helper rather than a regex over the whole file because
 * `WHERE Denomination = ...` is a perfectly legitimate READ of the column
 * and must not be mistaken for a write.
 */
function assignedColumns(sqlText: string): string[] {
  const assigned: string[] = [];
  const updates = executableSql(sqlText).matchAll(/\bUPDATE\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bFROM\b|\bWHERE\b|\bOUTPUT\b|;)/gi);
  for (const update of updates) {
    for (const assignment of update[1].matchAll(/([A-Za-z_][\w.]*)\s*=/g)) {
      assigned.push(assignment[1].split('.').pop() as string);
    }
  }
  return assigned;
}

/*
 * THE FILE ITSELF
  */

describe('the migration file itself', () => {
  it('is numbered 011, following 010', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(
      fs.existsSync(path.join(__dirname, '010-add-collection-status-and-storage-location.sql'))
    ).toBe(true);
  });

  it('targets the right database and says how to run it', () => {
    expect(migration).toMatch(/USE CoinInventory;/);
    expect(migration).toMatch(/sqlcmd -S localhost -d CoinInventory/);
  });

  it('parsed into several batches, so the batching tests below are not vacuous', () => {
    // If the GO-splitting regex ever stopped matching, every "different
    // batches" test would pass by accident, which is worse than no test.
    expect(batches.length).toBeGreaterThan(5);
  });

  it('says it is the schema step and names the two that follow', () => {
    // The next person has to know that 011 on its own leaves every
    // DenominationId null, and that this is correct rather than a failure.
    expect(migration).toMatch(/013-seed-issuers-and-denominations\.sql/);
    expect(migration).toMatch(/014-resolve-coin-denominations\.sql/);
  });
});

/*
 * Issuers
  */

/** The CREATE TABLE Issuers block, exactly as it must read in BOTH files. */
const ISSUERS_DDL = `CREATE TABLE Issuers (
    IssuerId            INT                 IDENTITY(1,1) PRIMARY KEY,
    Name                NVARCHAR(100)       NOT NULL,       -- 'Mexico', 'Roman Empire', 'Great Britain'
    IsoCode             CHAR(2)             NULL,           -- 'MX' where one exists; NULL for ancients and historical states
    Kind                NVARCHAR(20)        NOT NULL,       -- 'modern' | 'historical' | 'ancient'
    ValidFrom           INT                 NULL,           -- Year this authority began issuing
    ValidTo             INT                 NULL,           -- Year it stopped; NULL means it still does
    SortOrder           INT                 NOT NULL DEFAULT 0,
    IsActive            BIT                 NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Issuers_Name UNIQUE (Name)
);`;

describe('Issuers is created identically by the migration and by a fresh install', () => {
  it('appears character for character in the migration', () => {
    expect(migration).toContain(ISSUERS_DDL);
  });

  it('appears character for character in setup-database.sql', () => {
    // The failure this prevents: a migrated database and a fresh one differ,
    // and the seed generator's INSERT is right for only one of them.
    expect(schema).toContain(ISSUERS_DDL);
  });

  it('is guarded on the table not already existing', () => {
    expect(migration).toMatch(
      /IF OBJECT_ID\('dbo\.Issuers', 'U'\) IS NULL/
    );
    expect(migration).toMatch(/Issuers already exists - nothing to do/);
  });

  it('is dropped by setup-database.sql after Denominations, not before', () => {
    // Denominations carries a FK to Issuers, so dropping Issuers first fails
    // with a constraint violation and the whole re-run script stops.
    const dropDenominations = schema.indexOf("IF OBJECT_ID('Denominations', 'U') IS NOT NULL DROP TABLE Denominations;");
    const dropIssuers = schema.indexOf("IF OBJECT_ID('Issuers', 'U') IS NOT NULL DROP TABLE Issuers;");
    expect(dropDenominations).toBeGreaterThan(-1);
    expect(dropIssuers).toBeGreaterThan(dropDenominations);
  });

  it('makes the issuer name unique, because the seed joins on it', () => {
    // 013 inserts "WHERE NOT EXISTS (... WHERE Name = ...)" and links
    // denominations to issuers BY NAME. Two issuers called 'Mexico' would
    // make that join multiply rows silently.
    expect(ISSUERS_DDL).toContain('CONSTRAINT UQ_Issuers_Name UNIQUE (Name)');
  });
});

/*
 * The three added columns
  */

interface AddedColumn {
  table: 'Denominations' | 'Coins';
  column: string;
  /** Exactly as the ALTER must read, and as the CREATE TABLE must declare. */
  alter: string;
  declaration: RegExp;
  ddl: () => string;
}

const ADDED: AddedColumn[] = [
  {
    table: 'Denominations',
    column: 'IssuerId',
    alter: 'ALTER TABLE Denominations\n        ADD IssuerId INT NULL;',
    declaration: /IssuerId\s+INT\s+NULL,/,
    ddl: () => denominationsDdl,
  },
  {
    table: 'Denominations',
    column: 'FaceValue',
    alter: 'ALTER TABLE Denominations\n        ADD FaceValue DECIMAL(18,6) NULL;',
    declaration: /FaceValue\s+DECIMAL\(18,6\)\s+NULL,/,
    ddl: () => denominationsDdl,
  },
  {
    table: 'Coins',
    column: 'DenominationId',
    alter: 'ALTER TABLE Coins\n        ADD DenominationId INT NULL;',
    declaration: /DenominationId\s+INT\s+NULL,/,
    ddl: () => coinsDdl,
  },
];

describe.each(ADDED)('$table.$column', ({ table, column, alter, declaration, ddl }) => {
  it('is added by exactly that ALTER', () => {
    expect(migration).toContain(alter);
  });

  it('is declared the same way by setup-database.sql', () => {
    expect(ddl()).toMatch(declaration);
  });

  it('is NULLABLE, so the ALTER cannot be rejected on existing rows', () => {
    // NOT NULL without a default is refused outright on a non-empty table,
    // and NOT NULL *with* a default would invent an issuer or a denomination
    // for every row that has none — which is the one thing called a
    // failure even if it works.
    expect(alter).toMatch(/NULL;$/);
    expect(alter).not.toMatch(/NOT NULL/);
    expect(alter).not.toMatch(/DEFAULT/);
  });

  it('is guarded on the column not already existing', () => {
    const guard = new RegExp(
      `IF NOT EXISTS \\(\\s*SELECT 1 FROM sys\\.columns\\s*WHERE object_id = OBJECT_ID\\('dbo\\.${table}'\\) AND name = '${column}'\\s*\\)`
    );
    expect(migration).toMatch(guard);
  });

  it('says so out loud when there is nothing to do', () => {
    expect(migration).toContain(`${table}.${column} already exists - nothing to do`);
  });
});

/*
 * The two foreign keys
  */

const FK_DENOMINATIONS = `ALTER TABLE Denominations
        ADD CONSTRAINT FK_Denominations_Issuer
            FOREIGN KEY (IssuerId) REFERENCES Issuers(IssuerId);`;

const FK_COINS = `ALTER TABLE Coins
        ADD CONSTRAINT FK_Coins_Denomination
            FOREIGN KEY (DenominationId) REFERENCES Denominations(DenominationId);`;

describe('foreign keys', () => {
  it.each([
    ['FK_Denominations_Issuer', FK_DENOMINATIONS],
    ['FK_Coins_Denomination', FK_COINS],
  ])('%s is written identically in the migration and in setup-database.sql', (name, block) => {
    // Both files use an ALTER rather than an inline constraint SPECIFICALLY
    // so that the two can be compared as text. Coins is created before
    // Denominations in setup-database.sql, so its FK has to be an ALTER
    // there anyway; making the other one match costs nothing and buys this
    // test.
    expect(migration).toContain(block);
    expect(schema).toContain(block);
    expect(block).toContain(name);
  });

  it.each([
    ['FK_Denominations_Issuer', 'Denominations'],
    ['FK_Coins_Denomination', 'Coins'],
  ])('%s is guarded on the constraint not already existing', (name, table) => {
    const guard = new RegExp(
      `IF NOT EXISTS \\(\\s*SELECT 1 FROM sys\\.foreign_keys\\s*WHERE name = '${name}' AND parent_object_id = OBJECT_ID\\('dbo\\.${table}'\\)\\s*\\)`
    );
    expect(migration).toMatch(guard);
  });

  it('names every constraint rather than letting SQL Server generate one', () => {
    // A generated name (FK__Coins__Denomin__1A2B3C4D) differs on every
    // database, so the next migration that needs to drop it has to go
    // hunting in sys.objects first. Counting rather than pattern-matching:
    // every FOREIGN KEY in the file must be attached to an ADD CONSTRAINT.
    const code = executableSql(migration);
    const keys = code.match(/FOREIGN KEY/g) ?? [];
    const named = code.match(/ADD CONSTRAINT FK_\w+\n\s+FOREIGN KEY/g) ?? [];
    expect(keys).toHaveLength(2);
    expect(named).toHaveLength(keys.length);
  });
});

/*
 * Indexes (both FKs get one)
  */

describe('indexes', () => {
  it.each([
    ['IX_Denominations_IssuerId', 'Denominations', 'IssuerId'],
    ['IX_Coins_DenominationId', 'Coins', 'DenominationId'],
  ])('%s exists in both files', (name, table, column) => {
    const create = new RegExp(`CREATE INDEX ${name}\\s+ON ${table}\\s+\\(${column}\\);`);
    expect(migration).toMatch(create);
    expect(schema).toMatch(create);
  });

  it.each([
    ['IX_Denominations_IssuerId', 'Denominations'],
    ['IX_Coins_DenominationId', 'Coins'],
  ])('%s is guarded, so a second run does not fail', (name, table) => {
    const guard = new RegExp(
      `IF NOT EXISTS \\(\\s*SELECT 1 FROM sys\\.indexes\\s*WHERE name = '${name}' AND object_id = OBJECT_ID\\('dbo\\.${table}'\\)\\s*\\)`
    );
    expect(migration).toMatch(guard);
  });
});

/*
 * BATCHING — the invisible failure
  */

describe('batching', () => {
  it.each([
    ['IssuerId', 'FK_Denominations_Issuer'],
    ['DenominationId', 'FK_Coins_Denomination'],
  ])('adds %s in an earlier batch than the foreign key that names it', (column, fk) => {
    const addBatch = batches.findIndex(b => new RegExp(`ADD ${column} INT NULL`).test(b));
    const fkBatch = batches.findIndex(b => new RegExp(`ADD CONSTRAINT ${fk}`).test(b));

    expect(addBatch).toBeGreaterThanOrEqual(0);
    expect(fkBatch).toBeGreaterThan(addBatch);
  });

  it.each([
    ['IssuerId', 'IX_Denominations_IssuerId'],
    ['DenominationId', 'IX_Coins_DenominationId'],
  ])('adds %s in an earlier batch than the index on it', (column, index) => {
    const addBatch = batches.findIndex(b => new RegExp(`ADD ${column} INT NULL`).test(b));
    const indexBatch = batches.findIndex(b => new RegExp(`CREATE INDEX ${index}`).test(b));

    expect(addBatch).toBeGreaterThanOrEqual(0);
    expect(indexBatch).toBeGreaterThan(addBatch);
  });

  it('creates Issuers in an earlier batch than the foreign key pointing at it', () => {
    const createBatch = batches.findIndex(b => /CREATE TABLE Issuers/.test(b));
    const fkBatch = batches.findIndex(b => /ADD CONSTRAINT FK_Denominations_Issuer/.test(b));

    expect(createBatch).toBeGreaterThanOrEqual(0);
    expect(fkBatch).toBeGreaterThan(createBatch);
  });

  it('never names a column it is creating in the same batch', () => {
    // THE failure mode of this kind of script, stated as a rule rather than
    // as three examples.
    for (const column of ['IssuerId', 'FaceValue', 'DenominationId']) {
      const creating = batches.filter(b => new RegExp(`ADD ${column} `).test(b));
      expect(creating, column).toHaveLength(1);

      const uses = executableSql(creating[0]).match(new RegExp(column, 'g')) ?? [];
      // One mention only: the ADD itself. The sys.columns guard names the
      // column as a STRING LITERAL, which is stripped above.
      expect(uses, column).toHaveLength(1);
    }
  });
});

/*
 * WHAT THE MIGRATION PROMISES
  */

describe('what the migration promises the owner', () => {
  it('never writes Coins.Denomination', () => {
    // That column is read-only for the whole of this change, and
    // that single rule is what makes every step recoverable. A migration
    // that "tidied" the text would destroy the only evidence of what the
    // source said, irreversibly.
    expect(assignedColumns(migration)).not.toContain('Denomination');
  });

  it('writes nothing at all — 011 is pure DDL', () => {
    // Stronger than the rule above, and true of THIS file specifically:
    // seeding is 013's job and resolving is 014's. Nothing here can change a
    // value the user can see, which is what makes it safe to run today.
    expect(assignedColumns(migration)).toEqual([]);
    expect(executableSql(migration)).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(executableSql(migration)).not.toMatch(/\bDELETE\b/i);
  });

  it('does not drop Denominations.Country', () => {
    // Kept as flagged debt: re-pointing Coins.Country at
    // IssuerId is a separate migration and bundling the two doubles the risk.
    expect(migration).not.toMatch(/DROP COLUMN Country/i);
    expect(denominationsDdl).toMatch(/Country\s+NVARCHAR\(100\)\s+NOT NULL/);
  });

  it('states in the file that DenominationId is left null on purpose', () => {
    expect(migration).toMatch(/EVERY COIN COMES OUT OF THIS MIGRATION WITH DenominationId NULL/);
  });
});
