/**
 * migrations/migration-010.spec.ts — checking migration 010 by reading it.
 *
 * WHY THIS FILE EXISTS: THE MIGRATION CANNOT BE RUN HERE
 * There is no SQL Server on the development machine, and there is no test
 * harness anywhere in this project that executes a .sql file — the mssql
 * driver is mocked in every spec. So migration 010 has NOT been run, and
 * nobody should claim it has.
 *
 * What CAN be done is to check the things that would actually go wrong, by
 * parsing the file. Every assertion below corresponds to a specific way a
 * migration of this shape fails in the field:
 *
 *   - the column it adds disagrees with setup-database.sql, so a database
 *     built fresh and a database migrated end up with different schemas and
 *     the parameter bindings are right for only one of them (this is the
 *     exact failure db/coin-fields.spec.ts was written for, one layer down);
 *
 *   - the ALTER is not guarded, so a second run fails with "Column names in
 *     each table must be unique" and whoever ran it cannot tell whether the
 *     first half took effect;
 *
 *   - the new column is nullable, or has no default, so every existing coin
 *     comes out of the migration with no status — which in this application
 *     means a collection that is silently worth nothing;
 *
 *   - the UPDATE that references the new column sits in the SAME batch as the
 *     ALTER that creates it. SQL Server compiles a batch before it runs any
 *     of it, so that whole batch dies with "Invalid column name" and the
 *     migration half-applies. This is the single easiest mistake to make in a
 *     file like this and it is invisible to the eye.
 *
 * The parsing is deliberately crude — these are not a SQL parser, they are
 * tripwires on the exact strings that matter. Each `it` says which real
 * failure it is standing in for.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  COLLECTION_STATUSES,
  DEFAULT_COLLECTION_STATUS,
  MAX_COLLECTION_STATUS_LENGTH,
} from '../db/collection-status';

const migrationPath = path.join(__dirname, '010-add-collection-status-and-storage-location.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

const schema = fs.readFileSync(path.join(__dirname, '..', 'setup-database.sql'), 'utf8');
const coinsDdl = schema.match(/CREATE TABLE Coins \(([\s\S]*?)\n\);/)?.[1] ?? '';

/** The file split on its batch separators, so "same batch" is a real question. */
const batches = migration.split(/^\s*GO\s*$/m);

/**
 * A batch with its `--` comments and its string literals removed.
 *
 * Needed because SQL Server only compiles CODE. A column named inside a
 * comment or inside a PRINT's text cannot cause an "Invalid column name", so
 * counting raw occurrences of a column name would flag this file's own
 * explanatory prose as a bug. Stripping first is what makes the batching test
 * below test the thing it claims to.
 */
function executableSql(batch: string): string {
  return batch
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
}

describe('the migration file itself', () => {
  it('is numbered 010, following 009', () => {
    // Nothing enforces the ordering but the filenames, and they are how the
    // next person knows what to run after what.
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '009-add-bullion-denominations.sql'))).toBe(true);
  });

  it('targets the right database and says how to run it', () => {
    expect(migration).toMatch(/USE CoinInventory;/);
    expect(migration).toMatch(/sqlcmd -S localhost -d CoinInventory/);
  });

  it('parsed into several batches, so the tests below are not vacuous', () => {
    // If the GO-splitting regex ever stopped matching, the "different
    // batches" test would pass by accident. That would be worse than having
    // no test, because it looks like cover.
    expect(batches.length).toBeGreaterThan(3);
  });
});

describe('CollectionStatus is added exactly as setup-database.sql declares it', () => {
  it('adds NVARCHAR(20) NOT NULL DEFAULT owned', () => {
    // The whole clause in one assertion, because the parts are only correct
    // together: NVARCHAR(20) NOT NULL with no default would reject the ALTER
    // outright on a non-empty table, and nullable-with-a-default would leave
    // existing rows NULL.
    expect(migration).toMatch(
      /ALTER TABLE Coins\s+ADD CollectionStatus NVARCHAR\(20\) NOT NULL\s+CONSTRAINT \w+ DEFAULT 'owned'/
    );
  });

  it('agrees with setup-database.sql, so fresh and migrated databases match', () => {
    // The failure this prevents: a database built from setup-database.sql and
    // one brought forward by this migration end up with different column
    // definitions, and the bindings in db/coin-fields.ts can only be right
    // for one of them.
    expect(coinsDdl).toMatch(/CollectionStatus\s+NVARCHAR\(20\)\s+NOT NULL DEFAULT 'owned'/);
  });

  it('agrees with the length and default the server code binds', () => {
    expect(MAX_COLLECTION_STATUS_LENGTH).toBe(20);
    expect(DEFAULT_COLLECTION_STATUS).toBe('owned');
    expect(COLLECTION_STATUSES).toContain(DEFAULT_COLLECTION_STATUS);
  });

  it('names its default constraint instead of letting SQL Server generate one', () => {
    // A generated name (DF__Coins__Collect__1A2B3C4D) differs on every
    // database, so the next migration that needs to drop it has to go hunting
    // in sys.objects first.
    expect(migration).toMatch(/CONSTRAINT DF_Coins_CollectionStatus DEFAULT 'owned'/);
  });
});

describe('StorageLocation is added exactly as setup-database.sql declares it', () => {
  it('adds NVARCHAR(200) NULL', () => {
    expect(migration).toMatch(/ALTER TABLE Coins\s+ADD StorageLocation NVARCHAR\(200\) NULL;/);
  });

  it('agrees with setup-database.sql', () => {
    expect(coinsDdl).toMatch(/StorageLocation\s+NVARCHAR\(200\)\s+NULL/);
  });

  it('is NOT given a default', () => {
    // "Nothing recorded" is the honest state of a field the user has not
    // filled in. A default would invent a location for every coin he owns.
    expect(migration).not.toMatch(/StorageLocation NVARCHAR\(200\)[^;]*DEFAULT/);
  });
});

describe('running it twice changes nothing', () => {
  it('guards both ALTERs on the column not already existing', () => {
    // Without this, a second run dies with "Column names in each table must
    // be unique" -- and the person who ran it has no way to tell how much of
    // the first run took effect.
    for (const column of ['CollectionStatus', 'StorageLocation']) {
      const guard = new RegExp(
        `IF NOT EXISTS \\(\\s*SELECT 1 FROM sys\\.columns\\s*WHERE object_id = OBJECT_ID\\('dbo\\.Coins'\\) AND name = '${column}'\\s*\\)`
      );
      expect(migration).toMatch(guard);
    }
  });

  it('says so out loud when there is nothing to do', () => {
    // House style, set by 009: the script reports what it did either way, so
    // a silent run never has to be interpreted.
    expect(migration).toMatch(/Coins\.CollectionStatus already exists - nothing to do/);
    expect(migration).toMatch(/Coins\.StorageLocation already exists - nothing to do/);
  });

  it('only ever backfills rows that currently say nothing', () => {
    // The sweep must be a no-op on a healthy database. A WHERE clause that
    // matched more than blanks would overwrite the user's own statuses on
    // every re-run -- silently turning his want list into owned coins.
    expect(migration).toMatch(
      /UPDATE Coins\s+SET CollectionStatus = 'owned'\s+WHERE CollectionStatus IS NULL\s+OR LTRIM\(RTRIM\(CollectionStatus\)\) = '';/
    );
  });
});

describe('batching', () => {
  it('never references CollectionStatus in the same batch that creates it', () => {
    // THE failure mode of this kind of script. SQL Server compiles a whole
    // batch before executing any of it, so an UPDATE naming a column the
    // ALTER above it has not created yet makes the entire batch fail with
    // "Invalid column name" -- and the migration half-applies.
    const creating = batches.filter(b => /ADD CollectionStatus/.test(b));
    expect(creating).toHaveLength(1);

    // Comments and PRINT text are stripped first -- SQL Server only compiles
    // code, and this file talks about the column at length in prose.
    const uses = executableSql(creating[0]).match(/CollectionStatus/g) ?? [];

    // Exactly two mentions survive stripping, and both are definitions
    // rather than references: `ADD CollectionStatus`, and the name of the
    // default constraint `DF_Coins_CollectionStatus`. (The sys.columns guard
    // also names the column, but as a STRING LITERAL -- it looks the column
    // up by name rather than reading it -- so it is stripped above and is
    // harmless either way.)
    //
    // A third mention would be executable code reading a column that does
    // not exist at compile time, which fails the whole batch.
    expect(uses).toHaveLength(2);
    expect(executableSql(creating[0])).toMatch(/ADD CollectionStatus NVARCHAR/);
    expect(executableSql(creating[0])).toMatch(/CONSTRAINT DF_Coins_CollectionStatus/);
    // Nothing in this batch may SELECT from or UPDATE the table.
    expect(executableSql(creating[0])).not.toMatch(/UPDATE Coins|FROM Coins\b/);
  });

  it('puts the backfill after the ALTER, not before it', () => {
    const alterBatch = batches.findIndex(b => /ADD CollectionStatus/.test(b));
    const updateBatch = batches.findIndex(b => /UPDATE Coins/.test(b));

    expect(alterBatch).toBeGreaterThanOrEqual(0);
    expect(updateBatch).toBeGreaterThan(alterBatch);
  });

  it('puts the summary counts in a batch of their own, after everything', () => {
    const summaryBatch = batches.findIndex(b => /Coins after migration 010/.test(b));
    const updateBatch = batches.findIndex(b => /UPDATE Coins/.test(b));

    expect(summaryBatch).toBeGreaterThan(updateBatch);
  });
});

describe('what the migration promises the owner', () => {
  it('states in the file that every existing coin becomes owned', () => {
    // Not decoration. This is the property the whole feature rests on, and
    // the next person to read this file must not have to infer it from an
    // ALTER statement.
    expect(migration).toMatch(/EVERY EXISTING COIN BECOMES 'owned'/);
  });
});
