/**
 * db/schema.spec.ts — the twelve tables, and the three things about them
 * that are easy to get wrong and impossible to notice.
 *
 *   1. FOREIGN KEYS ARE OFF BY DEFAULT IN SQLITE. Not deprecated, not
 *      partially enforced — off, per connection, at the C-library level. A
 *      schema full of carefully argued FOREIGN KEY clauses that enforce
 *      nothing looks exactly like one that works.
 *   2. CASE SENSITIVITY FLIPPED. SQL Server's default collation on this
 *      database was case-insensitive; SQLite's is BINARY. Every equality
 *      comparison, every PRIMARY KEY on a name, every UNIQUE constraint and
 *      every ORDER BY changed meaning in the translation unless told not to.
 *   3. `INTEGER PRIMARY KEY` RECYCLES IDS. IDENTITY never did. The
 *      AUTOINCREMENT keyword is the difference and it is one word.
 *
 * db/numeric-storage.spec.ts covers the fourth, which is the big one.
 */

import { describe, it, expect } from 'vitest';

import { queryRows, withTestDb, rebuildTestDatabase } from '../test-support/sqlite-test-db';
import { parseTable, readSchema } from '../test-support/schema-columns';

/** The twelve tables design §4.10b says the migration has to carry. */
const TABLES = [
  'AppSettings',
  'Catalogs',
  'Categories',
  'CoinImages',
  'CoinSets',
  'Coins',
  'Denominations',
  'Issuers',
  'MetalContents',
  'MintMarks',
  'SpotPrices',
];

describe('the eleven tables', () => {
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
    // The one that matters most: the imageCount COUNT(*) in
    // routes/coins/list-query.ts is answered from this index without
    // touching a single base64 blob.
    expect(names).toContain('IX_CoinImages_CoinId_SortOrder');
    expect(names).toContain('IX_Coins_DenominationId');
    expect(names).toContain('IX_Denominations_IssuerId');
    // IX_Transactions_CoinId went with the Transactions table.
    expect(names).not.toContain('IX_Transactions_CoinId');
  });

  it('no longer has the tables and columns that were dropped', async () => {
    const tables = (
      await queryRows("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).map((row) => row['name']);
    // Migration 005.
    expect(tables).not.toContain('CoinTags');
    // Migration 006. There is no Dealer column anywhere any more: the
    // Transactions table that carried the surviving one has been dropped,
    // and its counterparty is two fields on Coins instead.
    expect(parseTable('Coins').has('Dealer')).toBe(false);
    expect(tables).not.toContain('Transactions');
    // The three columns that replaced the table.
    expect(parseTable('Coins').has('PurchasedFrom')).toBe(true);
    expect(parseTable('Coins').has('SoldTo')).toBe(true);
    expect(parseTable('Coins').has('TransactionNotes')).toBe(true);
    // And the coin's own note is still its own. Two notes columns that had
    // ended up with one name would be one column, silently.
    expect(parseTable('Coins').has('Notes')).toBe(true);
  });

  it('has the columns migrations 010, 011 and 012 added', () => {
    // db/schema.sql is a DESTINATION, not a replay. These are the columns a
    // naive translation of the pre-migration setup-database.sql would have
    // missed, so they are named explicitly.
    const coins = parseTable('Coins');
    expect(coins.has('CollectionStatus')).toBe(true); // 010
    expect(coins.has('StorageLocation')).toBe(true); // 010
    expect(coins.has('DenominationId')).toBe(true); // 011
    expect(coins.has('CatalogId')).toBe(true); // 012
    expect(coins.has('CatalogNumber')).toBe(true); // 012

    expect(parseTable('Denominations').has('IssuerId')).toBe(true); // 011
    expect(parseTable('Denominations').has('FaceValue')).toBe(true); // 011
    expect(parseTable('CoinImages').has('SourcePath')).toBe(true); // 002
  });
});

describe('foreign keys are enforced, not decorative', () => {
  it('declares the five relationships, with cascade only where it belongs', async () => {
    const forCoins = await queryRows('PRAGMA foreign_key_list(Coins)');
    expect(
      forCoins.map((row) => ({ table: row['table'], from: row['from'], onDelete: row['on_delete'] }))
    ).toEqual(
      expect.arrayContaining([
        // NO CASCADE on either. Deleting a catalogue must never delete the
        // owner's coins, and ON DELETE SET NULL would silently discard the
        // attribution on every affected coin.
        { table: 'Catalogs', from: 'CatalogId', onDelete: 'NO ACTION' },
        { table: 'Denominations', from: 'DenominationId', onDelete: 'NO ACTION' },
      ])
    );

    // CASCADE here, because DELETE /api/coins/:id relies on it and a coin's
    // photographs have no meaning without the coin.
    const forImages = await queryRows('PRAGMA foreign_key_list(CoinImages)');
    expect(forImages[0]['on_delete']).toBe('CASCADE');
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
    // SQLite would happily put 7 in a column the application treats as a
    // boolean.
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
    // `DELETE FROM Categories WHERE CategoryName = 'gold'` has to keep
    // deleting the row called 'Gold', or the maintenance screen's delete
    // button starts returning 404 for half its rows.
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
    // routes/lookups/issuers.ts says in so many words: "The default
    // collation is case-insensitive, so Name alone already folds case."
    // Under BINARY collation 'apple' would sort after 'Zebra' and a list of
    // 70 issuers would be unreadable.
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
    // The deliberate exception. '1A' and '1a' can be different references,
    // and nothing in this application may fold them together.
    await withTestDb((database) => {
      database
        .prepare("INSERT INTO Coins (CoinId, Denomination, CatalogNumber) VALUES ('cn', '$1', '1A')")
        .run();
    });

    expect(await queryRows("SELECT CoinId FROM Coins WHERE CatalogNumber = '1a'")).toEqual([]);
    expect(await queryRows("SELECT CoinId FROM Coins WHERE CatalogNumber = '1A'")).toHaveLength(1);
  });
});

describe('IDENTITY became AUTOINCREMENT, which is not the same as a bare INTEGER key', () => {
  it('declares AUTOINCREMENT on every surrogate key', () => {
    // A bare `INTEGER PRIMARY KEY` picks max(rowid) + 1 and so REUSES the id
    // of a deleted row; IDENTITY never did. An id handed out twice points
    // exported CSVs, coin rows and an open browser tab at the wrong thing.
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
    // This is the point of db/bind-values.ts. The test is here, in the
    // schema file, because the natural assumption on reading
    // `Grade TEXT -- NVARCHAR(50)` is that something enforces the 50.
    // Nothing in the database does.
    await withTestDb((database) => {
      database
        .prepare("INSERT INTO Coins (CoinId, Denomination, Grade) VALUES ('wide', '$1', @g)")
        .run({ g: 'G'.repeat(4000) });
    });

    const [row] = await queryRows("SELECT length(Grade) AS n FROM Coins WHERE CoinId = 'wide'");
    expect(row['n']).toBe(4000);
  });

  it('does not restrict CollectionStatus to the five tokens', async () => {
    // Deliberately validated in db/collection-status.ts rather than by a
    // CHECK, for the reasons setup-database.sql records: a CHECK would have
    // to be dropped and recreated from a migration that can only guess at
    // its generated name. The column accepting anything is therefore
    // expected — and is why nothing may write it except through
    // normalizeCollectionStatus().
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
