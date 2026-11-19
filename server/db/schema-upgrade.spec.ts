/**
 * Opening a version-1 file (one catalogue reference stored on Coins) copies
 * that reference into CoinCatalogRefs.
 */

import { describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabase } from './driver';
import { applySchema, readSchemaSql, readSchemaVersion, stampSchemaVersion, upgradeSchema } from './schema';

/** A database shaped like version 1: today's schema plus the old Coins columns. */
function versionOneDatabase(): SqliteDatabase {
  const database = openSqliteDatabase({ filename: ':memory:', enableForeignKeyConstraints: true, busyTimeoutMs: 1000 });
  const oldSchema = readSchemaSql()
    .replace(
      '    StorageLocation     TEXT        NULL,',
      '    StorageLocation     TEXT        NULL,\n    CatalogId INTEGER NULL REFERENCES Catalogs (CatalogId),\n    CatalogNumber TEXT NULL,'
    )
    .replace(/CREATE TABLE IF NOT EXISTS CoinCatalogRefs \([\s\S]*?\n\);/, '')
    .replace(/CREATE INDEX IF NOT EXISTS IX_CoinCatalogRefs[^\n]*\n/g, '');
  database.exec(oldSchema);
  database.exec("INSERT INTO Catalogs (CatalogId, Name, SortOrder) VALUES (1, 'Sear', 1)");
  database.exec(`INSERT INTO Coins (CoinId, Denomination, CatalogId, CatalogNumber) VALUES
    ('with-ref', 'Denarius', 1, ' 6819 '),
    ('number-only', 'Denarius', NULL, 'RRC 44/5'),
    ('catalogue-only', 'Denarius', 1, ''),
    ('none', 'Dollar', NULL, NULL)`);
  database.exec('PRAGMA user_version = 1');
  return database;
}

function refs(database: SqliteDatabase) {
  return database
    .prepare('SELECT CoinId, CatalogId, CatalogNumber, SortOrder FROM CoinCatalogRefs ORDER BY CoinId')
    .all()
    .map(row => ({ ...row }));
}

describe('upgrading a version-1 database', () => {
  it('copies each coin\'s single reference into CoinCatalogRefs', () => {
    const database = versionOneDatabase();
    applySchema(database);
    expect(upgradeSchema(database, readSchemaVersion(database))).toBe(2);

    expect(refs(database)).toEqual([
      { CoinId: 'number-only', CatalogId: null, CatalogNumber: 'RRC 44/5', SortOrder: 0 },
      { CoinId: 'with-ref', CatalogId: 1, CatalogNumber: '6819', SortOrder: 0 }
    ]);
  });

  it('runs once: a second open copies nothing more', () => {
    const database = versionOneDatabase();
    applySchema(database);
    upgradeSchema(database, readSchemaVersion(database));
    stampSchemaVersion(database);
    expect(upgradeSchema(database, readSchemaVersion(database))).toBe(0);
    expect(refs(database)).toHaveLength(2);
  });

  it('does nothing to a current database', () => {
    const database = openSqliteDatabase({ filename: ':memory:', enableForeignKeyConstraints: true, busyTimeoutMs: 1000 });
    applySchema(database);
    expect(upgradeSchema(database, 0)).toBe(0);
    expect(upgradeSchema(database, 2)).toBe(0);
  });
});
