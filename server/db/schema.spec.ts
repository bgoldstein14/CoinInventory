/**
 * The tables, and three SQLite differences that are easy to miss:
 *
 *   1. foreign keys are off unless enabled per connection;
 *   2. the default collation is case-sensitive (SQL Server's wasn't), so
 *      name columns need COLLATE NOCASE;
 *   3. a bare INTEGER PRIMARY KEY can reuse ids; AUTOINCREMENT prevents it.
 *
 * Decimal storage is covered by db/numeric-storage.spec.ts.
 */

import { describe, it, expect } from 'vitest';

import { queryRows, withTestDb, rebuildTestDatabase } from '../test-support/sqlite-test-db';
import { parseTable, readSchema } from '../test-support/schema-columns';

/** The tables the schema must create. */
const TABLES = [
  'AppSettings',
  'Catalogs',
  'Categories',
  'CoinCatalogRefs',
  'CoinImages',
  'CoinSets',
  'Coins',
  'Denominations',
  'Issuers',
  'MetalContents',
  'MintMarks',
  'SpotPrices',
];

describe('the twelve tables', () => {
  it('all exist', async () => {
    const rows = await queryRows(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    expect(rows.map((row) => row['name'])).toEqual(TABLES);
  });

  it('has the indexes the hot queries depend on', async () => {
    const rows = await queryRows(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'IX_%' ORDER BY name"
    );
    const names = rows.map((row) => row['name']);
    // Lets the imageCount COUNT(*) in routes/coins/list-query.ts skip the image data.
    expect(names).toContain('IX_CoinImages_CoinId_SortOrder');
    expect(names).toContain('IX_Coins_DenominationId');
    expect(names).toContain('IX_Denominations_IssuerId');
    expect(names).not.toContain('IX_Transactions_CoinId');
  });

  it('no longer has the tables and columns that were dropped', async () => {
    const tables = (
      await queryRows("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((row) => row['name']);
    // Migration 005.
    expect(tables).not.toContain('CoinTags');
    // Migration 006: no Dealer column anywhere.
    expect(parseTable('Coins').has('Dealer')).toBe(false);
    expect(tables).not.toContain('Transactions');
    // The columns that replaced the Transactions table.
    expect(parseTable('Coins').has('PurchasedFrom')).toBe(true);
    expect(parseTable('Coins').has('SoldTo')).toBe(true);
    expect(parseTable('Coins').has('TransactionNotes')).toBe(true);
    // The coin's own note is still separate.
    expect(parseTable('Coins').has('Notes')).toBe(true);
  });

  it('has the columns added after the original schema', () => {
    // Columns from later migrations, which a translation of the original
    // setup-database.sql would have missed.
    const coins = parseTable('Coins');
    expect(coins.has('CollectionStatus')).toBe(true); // 010
    expect(coins.has('StorageLocation')).toBe(true); // 010
    expect(coins.has('DenominationId')).toBe(true); // 011

    expect(parseTable('Denominations').has('IssuerId')).toBe(true); // 011
    expect(parseTable('Denominations').has('FaceValue')).toBe(true); // 011
    expect(parseTable('CoinImages').has('SourcePath')).toBe(true); // 002
  });
});

describe('foreign keys are enforced, not decorative', () => {
  it('declares the relationships, with cascade only where it belongs', async () => {
    const forCoins = await queryRows('PRAGMA foreign_key_list(Coins)');
    expect(
      forCoins.map((row) => ({ table: row['table'], from: row['from'], onDelete: row['on_delete'] }))
    ).toEqual(
      expect.arrayContaining([
        { table: 'Denominations', from: 'DenominationId', onDelete: 'NO ACTION' },
      ])
    );

    // CASCADE: DELETE /api/coins/:id relies on photos going with the coin.
    const forImages = await queryRows('PRAGMA foreign_key_list(CoinImages)');
    expect(forImages[0]['on_delete']).toBe('CASCADE');

    // References go with the coin; deleting a catalogue must not unlink them.
    const forRefs = await queryRows('PRAGMA foreign_key_list(CoinCatalogRefs)');
    expect(forRefs.map((row) => ({ table: row['table'], onDelete: row['on_delete'] }))).toEqual(
      expect.arrayContaining([
        { table: 'Coins', onDelete: 'CASCADE' },
        { table: 'Catalogs', onDelete: 'NO ACTION' },
      ])
    );
  });

  it('refuses a coin pointing at a denomination that does not exist', async () => {
    await expect(
      withTestDb((database) => {
        database
          .prepare("INSERT INTO Coins (CoinId, Denomination, DenominationId) VALUES ('x', '$1', 999999)")
          .run();
      })
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('cascades a coin delete to its photographs', async () => {
    await withTestDb((database) => {
      database.prepare("INSERT INTO Coins (CoinId, Denomination) VALUES ('casc', '$1')").run();
      database
        .prepare("INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES ('casc', 'a', 0)")
        .run();
      database.prepare("DELETE FROM Coins WHERE CoinId = 'casc'").run();
    });

    expect(await queryRows('SELECT ImageId FROM CoinImages')).toEqual([]);
  });

  it('enforces the BIT check constraints', async () => {
    // SQLite would otherwise accept 7 in a boolean column.
    await expect(
      withTestDb((database) => {
        database
          .prepare("INSERT INTO Coins (CoinId, Denomination, HasCacSticker) VALUES ('bit', '$1', 7)")
          .run();
      })
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe('collation: SQL Server was case-insensitive and SQLite is not', () => {
  it('treats Categories.CategoryName as case-insensitive, as the primary key did before', async () => {
    // Deleting 'gold' must still delete the row called 'Gold'.
    await withTestDb((database) => {
      database.prepare("INSERT INTO Categories (CategoryName) VALUES ('Gold')").run();
    });

    const found = await queryRows("SELECT CategoryName FROM Categories WHERE CategoryName = 'gold'");
    expect(found).toHaveLength(1);

    await expect(
      withTestDb((database) => {
        database.prepare("INSERT INTO Categories (CategoryName) VALUES ('GOLD')").run();
      })
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('treats Issuers.Name as case-insensitive, which is what the seed match relies on', async () => {
    await expect(
      withTestDb((database) => {
        database
          .prepare("INSERT INTO Issuers (Name, Kind, SortOrder) VALUES ('mexico', 'modern', 1)")
          .run();
      })
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('orders issuer names without putting every capital before every lower case', async () => {
    // ORDER BY Name must fold case (routes/lookups/issuers.ts relies on it).
    await withTestDb((database) => {
      const insert = database.prepare(
        'INSERT INTO Issuers (Name, Kind, SortOrder) VALUES (@name, @kind, 0)'
      );
      insert.run({ name: 'aardvark Empire', kind: 'ancient' });
      insert.run({ name: 'Zanzibar', kind: 'modern' });
    });

    const rows = await queryRows(
      "SELECT Name FROM Issuers WHERE Name IN ('aardvark Empire', 'Zanzibar') ORDER BY Name"
    );
    expect(rows.map((row) => row['Name'])).toEqual(['aardvark Empire', 'Zanzibar']);

    await rebuildTestDatabase();
  });

  it('leaves CatalogNumber case-SENSITIVE, because it is a key into a printed book', async () => {
    // CatalogNumber stays case-sensitive: '1A' and '1a' may be different references.
    await withTestDb((database) => {
      database
        .prepare("INSERT INTO Coins (CoinId, Denomination) VALUES ('cn', '$1')")
        .run();
      database
        .prepare("INSERT INTO CoinCatalogRefs (CoinId, CatalogNumber) VALUES ('cn', '1A')")
        .run();
    });

    expect(await queryRows("SELECT CoinId FROM CoinCatalogRefs WHERE CatalogNumber = '1a'")).toEqual([]);
    expect(await queryRows("SELECT CoinId FROM CoinCatalogRefs WHERE CatalogNumber = '1A'")).toHaveLength(1);
  });
});

describe('IDENTITY became AUTOINCREMENT, which is not the same as a bare INTEGER key', () => {
  it('declares AUTOINCREMENT on every surrogate key', () => {
    // Without AUTOINCREMENT, the id of a deleted top row would be reused.
    const schema = readSchema();
    for (const key of [
      'IssuerId',
      'DenominationId',
      'CatalogId',
      'ImageId',
      'SpotPriceId',
      'MintMarkId',
      'MetalContentId',
    ]) {
      expect(schema, key).toMatch(new RegExp(`\\n\\s+${key}\\s+INTEGER\\s+PRIMARY KEY AUTOINCREMENT`));
    }
  });

  it('does not recycle an id after the highest row is deleted', async () => {
    await withTestDb((database) => {
      database.prepare("INSERT INTO Coins (CoinId, Denomination) VALUES ('owner', '$1')").run();
      database
        .prepare("INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES ('owner', 'a', 0)")
        .run();
    });
    const [first] = await queryRows('SELECT ImageId AS id FROM CoinImages');

    await withTestDb((database) => {
      database.prepare('DELETE FROM CoinImages').run();
      database
        .prepare("INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES ('owner', 'b', 0)")
        .run();
    });
    const [second] = await queryRows('SELECT ImageId AS id FROM CoinImages');

    expect(second['id']).toBe((first['id'] as number) + 1);
  });
});

describe('what SQLite does NOT enforce, recorded so nobody assumes it does', () => {
  it('stores a string far longer than the declared width without complaint', async () => {
    // `Grade TEXT -- NVARCHAR(50)` is not enforced by the database;
    // db/bind-values.ts enforces it.
    await withTestDb((database) => {
      database
        .prepare("INSERT INTO Coins (CoinId, Denomination, Grade) VALUES ('wide', '$1', @g)")
        .run({ g: 'G'.repeat(4000) });
    });

    const [row] = await queryRows("SELECT length(Grade) AS n FROM Coins WHERE CoinId = 'wide'");
    expect(row['n']).toBe(4000);
  });

  it('does not restrict CollectionStatus to the five tokens', async () => {
    // No CHECK constraint: values are validated in db/collection-status.ts,
    // so writes must go through normalizeCollectionStatus().
    await withTestDb((database) => {
      database
        .prepare(
          "INSERT INTO Coins (CoinId, Denomination, CollectionStatus) VALUES ('odd', '$1', 'pondering')"
        )
        .run();
    });
    const [row] = await queryRows("SELECT CollectionStatus AS s FROM Coins WHERE CoinId = 'odd'");
    expect(row['s']).toBe('pondering');
  });
});
