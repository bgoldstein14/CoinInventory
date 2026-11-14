/**
 * The destination: what it looks like when it is opened, what counts as
 * "already in use", and what `--force` removes.
 */

import { describe, it, expect } from 'vitest';

import {
  clearOwnerData,
  inspectOccupancy,
  openTarget,
  targetColumns,
  targetCount,
  targetCounts,
  TargetNotEmptyError,
} from './target';
import { ALL_TABLES, OCCUPANCY_TABLES, REFERENCE_TABLES } from './tables';

describe('openTarget', () => {
  it('builds the schema and seeds the reference data', () => {
    const opened = openTarget(':memory:');

    expect(opened.seeded.issuers).toBe(70);
    expect(opened.seeded.denominations).toBe(1207);
    expect(opened.seeded.catalogs).toBe(15);
    expect(targetCount(opened.database, 'Issuers')).toBe(70);
  });

  it('reports the columns the application actually has, from PRAGMA', () => {
    // Derived from the live database rather than from a list in this tool,
    // so "what we intend to read" cannot drift away from db/schema.sql.
    const opened = openTarget(':memory:');

    expect(targetColumns(opened.database, 'Coins')).toHaveLength(30);
    expect(targetColumns(opened.database, 'Coins')).toContain('CollectionStatus');
    expect(targetColumns(opened.database, 'CoinImages')).toEqual([
      'ImageId',
      'CoinId',
      'ImageData',
      'SortOrder',
      'SourcePath',
    ]);
  });

  it('refuses a table name that is not a plain identifier', () => {
    const opened = openTarget(':memory:');
    expect(() => targetColumns(opened.database, 'Coins); DROP TABLE Coins --')).toThrow(
      /Refusing to build SQL/
    );
  });

  it('counts all twelve tables', () => {
    const counts = targetCounts(openTarget(':memory:').database);
    expect(Object.keys(counts).sort()).toEqual([...ALL_TABLES].sort());
  });
});

describe('is the target already in use?', () => {
  it('a freshly seeded database is NOT occupied', () => {
    // The point of excluding the reference tables: they are full on a first
    // open, and a check that counted them would refuse every migration.
    const opened = openTarget(':memory:');
    expect(targetCount(opened.database, 'Denominations')).toBe(1207);
    expect(inspectOccupancy(opened.database).occupied).toBe(false);
  });

  it('the occupancy tables and the reference tables do not overlap', () => {
    for (const table of OCCUPANCY_TABLES) {
      expect(REFERENCE_TABLES as readonly string[]).not.toContain(table);
    }
  });

  it('one coin is enough to make it occupied, and it is named', () => {
    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO Coins (CoinId, CollectionStatus) VALUES ('c1', 'owned')")
      .run();

    const occupancy = inspectOccupancy(opened.database);
    expect(occupancy.occupied).toBe(true);
    expect(occupancy.occupiedTables).toEqual([{ table: 'Coins', rows: 1 }]);
  });

  it('a setting on its own is enough — the owner has been using this file', () => {
    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO AppSettings (SettingKey, SettingValue) VALUES ('theme', 'dark')")
      .run();

    expect(inspectOccupancy(opened.database).occupied).toBe(true);
  });

  it('the refusal says what to do, not just what is wrong', () => {
    const occupancy = {
      occupied: true,
      occupiedTables: [{ table: 'Coins' as const, rows: 3 }],
    };
    const error = new TargetNotEmptyError('C:\\data\\coin-inventory.db', occupancy);

    expect(error.message).toContain('C:\\data\\coin-inventory.db');
    expect(error.message).toContain('3 row(s)');
    expect(error.message).toContain('Nothing has been written');
    expect(error.message).toContain('--force');
    expect(error.message).toContain('--target');
    // The -wal trap: copying the .db alone from a running app loses the
    // most recent writes, silently.
    expect(error.message).toContain('-wal');
  });
});

describe('--force', () => {
  it('deletes the owner tables and leaves the reference data alone', () => {
    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO Coins (CoinId, CollectionStatus) VALUES ('c1', 'owned')")
      .run();
    opened.database
      .prepare("INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES ('c1', 'x', 0)")
      .run();
    opened.database.prepare("INSERT INTO CoinSets (SetName) VALUES ('Mine')").run();

    const deleted = clearOwnerData(opened.database);

    expect(deleted['Coins']).toBe(1);
    expect(deleted['CoinSets']).toBe(1);
    expect(targetCount(opened.database, 'CoinImages')).toBe(0);
    // The seed survives: reconciliation is idempotent by identity, so
    // clearing it would only throw away work and rebuild it.
    expect(targetCount(opened.database, 'Denominations')).toBe(1207);
    expect(targetCount(opened.database, 'Issuers')).toBe(70);
  });

  it('deletes child rows before parents', () => {
    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO Coins (CoinId, CollectionStatus) VALUES ('c1', 'owned')")
      .run();
    opened.database
      .prepare(
        "INSERT INTO Transactions (TransactionId, CoinId, TransactionType, TransactionDate, Amount) " +
          "VALUES ('t1', 'c1', 'purchase', '2020-01-01', 1)"
      )
      .run();

    expect(() => clearOwnerData(opened.database)).not.toThrow();
    expect(targetCount(opened.database, 'Transactions')).toBe(0);
  });
});
