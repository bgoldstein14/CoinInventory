/**
 * The migration end to end, against a fixture SQL Server and a real
 * in-memory SQLite database.
 *
 * The SQLite side is NOT mocked. Schema, seed, foreign keys, collation and
 * the value round trip are all the real ones, so a passing test here means
 * the rows really landed and really verify — which is the whole reason
 * Stage 1 chose a database that runs in memory.
 */

import { describe, it, expect } from 'vitest';

import type { SqliteDatabase } from '../db/driver';
import { runMigration, type MigrationOptions } from './migrate';
import {
  buildFixtureReader,
  buildSourceTables,
  CATALOG_ID_OFFSET,
  COIN_ONE,
  COIN_TWO,
  DENOMINATION_ID_OFFSET,
  defaultRows,
  ISSUER_ID_OFFSET,
  sourceColumnsFor,
} from './fixture-collection';
import { FixtureSourceReader, textColumn } from './fixture-source-reader';
import { openTarget, TargetNotEmptyError } from './target';
import { MigrationRefusedError } from './reference-data';
import type { SourceQuery, SourceRow } from './source-reader';

const SILENT = (): void => undefined;

const DEFAULTS: MigrationOptions = {
  force: false,
  dryRun: false,
  weightsAreGrams: false,
  allowExtraSourceColumns: false,
};

function rows(database: SqliteDatabase, sql: string): Record<string, unknown>[] {
  return database.prepare(sql).all();
}

function one(database: SqliteDatabase, sql: string): Record<string, unknown> {
  const found = rows(database, sql);
  expect(found.length, sql).toBe(1);
  return found[0];
}

function count(database: SqliteDatabase, table: string): number {
  return Number(one(database, `SELECT COUNT(*) AS n FROM ${table}`)['n']);
}

async function migrate(
  reader = buildFixtureReader(),
  options: Partial<MigrationOptions> = {},
  log: string[] = []
) {
  const opened = openTarget(':memory:');
  await reader.open();
  const outcome = await runMigration(
    reader,
    opened,
    { ...DEFAULTS, ...options },
    (line) => log.push(line)
  );
  return { outcome, database: opened.database, reader, log };
}

describe('the migration, end to end', () => {
  it('commits, and says the verification passed', async () => {
    const { outcome } = await migrate();

    expect(outcome.committed).toBe(true);
    expect(outcome.verification?.ok).toBe(true);
    expect(outcome.verification?.values.differences).toEqual([]);
    expect(outcome.verification?.links.differences).toEqual([]);
  });

  it('moves the owner tables row for row', async () => {
    const { database } = await migrate();

    expect(count(database, 'Coins')).toBe(2);
    expect(count(database, 'CoinImages')).toBe(2);
    expect(count(database, 'SpotPrices')).toBe(1);
    expect(count(database, 'CoinSets')).toBe(1);
    expect(count(database, 'AppSettings')).toBe(2);
  });

  it('does NOT duplicate a single seeded reference row', async () => {
    // The headline risk. The source holds the whole seed; the target was
    // seeded from the same JSON on open. If anything here copied rather
    // than reconciled, these numbers would double.
    const { database, outcome } = await migrate();

    expect(count(database, 'Issuers')).toBe(70);
    expect(count(database, 'Denominations')).toBe(1207);
    expect(count(database, 'Catalogs')).toBe(15);
    expect(count(database, 'Categories')).toBe(2);
    expect(count(database, 'MetalContents')).toBe(15);
    expect(count(database, 'MintMarks')).toBe(9);

    const denominations = outcome.reference?.outcomes.find(
      (entry) => entry.table === 'Denominations'
    );
    expect(denominations?.seededUnchanged).toBe(1207);
    expect(denominations?.ownAdded).toBe(0);
    expect(denominations?.seededEdited).toBe(0);
  });

  it('keeps every value of the six numeric columns exactly, with ===', async () => {
    const { database } = await migrate();

    const coin = one(database, `SELECT * FROM Coins WHERE CoinId = '${COIN_ONE.toLowerCase()}'`);
    expect(coin['Weight']).toBe(26.73);
    expect(coin['PmWeightGrams']).toBe(24.05582);
    expect(coin['PmPercent']).toBe(90.0);
    expect(coin['PurchasePrice']).toBe(412.35);
    expect(coin['CurrentValue']).toBe(575.0);
    expect(coin['SoldPrice']).toBeNull();

    const second = one(database, `SELECT * FROM Coins WHERE CoinId = '${COIN_TWO.toLowerCase()}'`);
    expect(second['Weight']).toBe(3.87654);
    expect(second['PmWeightGrams']).toBe(3.56942);
    expect(second['PmPercent']).toBe(92.1);
  });

  it('normalises a UNIQUEIDENTIFIER to lower case, consistently across tables', async () => {
    const { database } = await migrate();

    const coinIds = rows(database, 'SELECT CoinId FROM Coins').map((row) => row['CoinId']);
    expect(coinIds).toEqual([COIN_ONE.toLowerCase(), COIN_TWO.toLowerCase()]);

    // The foreign keys have to agree with it, or the photographs are
    // orphans that FK enforcement would have refused.
    expect(
      rows(database, 'SELECT DISTINCT CoinId FROM CoinImages').map((row) => row['CoinId'])
    ).toEqual([COIN_ONE.toLowerCase()]);
  });

  it('copies ImageData verbatim as base64 — Stage 3 does the BLOB', async () => {
    const { database } = await migrate();

    const images = rows(database, 'SELECT * FROM CoinImages ORDER BY SortOrder');
    expect(images.map((row) => row['ImageData'])).toEqual([
      'data:image/jpeg;base64,AAAA',
      'data:image/jpeg;base64,BBBB',
    ]);
    expect(typeof images[0]['ImageData']).toBe('string');
    expect(images[0]['SourcePath']).toBe('C:\\photos\\1.jpg');
    expect(images[1]['SourcePath']).toBeNull();
  });

  it('preserves the owner\u2019s own ids and re-resolves the reference ones', async () => {
    const { database } = await migrate();

    // His ids travel: an exported CSV still names the same photograph.
    expect(rows(database, 'SELECT ImageId FROM CoinImages').map((r) => r['ImageId'])).toEqual([
      1, 2,
    ]);
    expect(one(database, 'SELECT * FROM SpotPrices')['SpotPriceId']).toBe(1);

    // The reference ids do not. The source said 5000-something; the target
    // has to point at ITS '$1' under United States.
    const coin = one(
      database,
      `SELECT DenominationId, CatalogId FROM Coins WHERE CoinId = '${COIN_ONE.toLowerCase()}'`
    );
    expect(Number(coin['DenominationId'])).toBeLessThan(DENOMINATION_ID_OFFSET);
    expect(Number(coin['CatalogId'])).toBeLessThan(CATALOG_ID_OFFSET);

    const resolved = one(
      database,
      'SELECT d.Label AS label, i.Name AS issuer, c.Name AS catalog ' +
        'FROM Coins co ' +
        'JOIN Denominations d ON d.DenominationId = co.DenominationId ' +
        'JOIN Issuers i ON i.IssuerId = d.IssuerId ' +
        'JOIN Catalogs c ON c.CatalogId = co.CatalogId ' +
        `WHERE co.CoinId = '${COIN_ONE.toLowerCase()}'`
    );
    expect(resolved).toEqual({ label: '$1', issuer: 'United States', catalog: 'Krause (KM)' });
  });

  it('turns a BIT into 0/1 and a DATETIME2 into ISO-8601 UTC text', async () => {
    const { database } = await migrate();

    expect(
      one(database, `SELECT HasCacSticker AS h FROM Coins WHERE CoinId = '${COIN_ONE.toLowerCase()}'`)[
        'h'
      ]
    ).toBe(1);
    expect(one(database, 'SELECT FetchedAt AS f FROM SpotPrices')['f']).toBe(
      '2026-11-01T09:30:00.000Z'
    );
  });
});

describe('the owner\u2019s own reference data', () => {
  it('moves an issuer and a denomination he added himself, and links the coin', async () => {
    const issuers = [
      ...defaultRows('Issuers'),
      {
        IssuerId: ISSUER_ID_OFFSET + 9001,
        Name: 'Miletos',
        IsoCode: null,
        Kind: 'ancient',
        ValidFrom: -600,
        ValidTo: -400,
        SortOrder: 5000,
        IsActive: true,
      },
    ];
    const denominations = [
      ...defaultRows('Denominations'),
      {
        DenominationId: DENOMINATION_ID_OFFSET + 9001,
        Label: 'Stater',
        Country: 'Miletos',
        IssuerId: ISSUER_ID_OFFSET + 9001,
        FaceValue: null,
        SortOrder: 10,
        IsActive: true,
      },
    ];
    const coins = defaultRows('Coins').map((coin, index) =>
      index === 1 ? { ...coin, DenominationId: DENOMINATION_ID_OFFSET + 9001 } : coin
    );

    const { database, outcome } = await migrate(
      buildFixtureReader({ rows: { Issuers: issuers, Denominations: denominations, Coins: coins } })
    );

    expect(outcome.committed).toBe(true);
    expect(count(database, 'Issuers')).toBe(71);
    expect(count(database, 'Denominations')).toBe(1208);

    const linked = one(
      database,
      'SELECT d.Label AS label, i.Name AS issuer FROM Coins c ' +
        'JOIN Denominations d ON d.DenominationId = c.DenominationId ' +
        'JOIN Issuers i ON i.IssuerId = d.IssuerId ' +
        `WHERE c.CoinId = '${COIN_TWO.toLowerCase()}'`
    );
    expect(linked).toEqual({ label: 'Stater', issuer: 'Miletos' });
  });

  it('carries an edit to a seeded row instead of inserting a second copy', async () => {
    // The case that is easy to miss: db/seed.ts never resurrects a
    // soft-deleted row, but it also never learns that one WAS deleted.
    const catalogs = defaultRows('Catalogs').map((row) =>
      row['Name'] === 'Hendin' ? { ...row, IsActive: false, SortOrder: 99 } : row
    );

    const { database, outcome } = await migrate(buildFixtureReader({ rows: { Catalogs: catalogs } }));

    expect(count(database, 'Catalogs')).toBe(15);
    const hendin = one(database, "SELECT * FROM Catalogs WHERE Name = 'Hendin'");
    expect(hendin['IsActive']).toBe(0);
    expect(hendin['SortOrder']).toBe(99);

    const outcomeForCatalogs = outcome.reference?.outcomes.find((e) => e.table === 'Catalogs');
    expect(outcomeForCatalogs?.seededEdited).toBe(1);
    expect(outcomeForCatalogs?.ownAdded).toBe(0);
  });

  it('carries a soft-deleted seeded DENOMINATION without duplicating it', async () => {
    const denominations = defaultRows('Denominations').map((row, index) =>
      index === 0 ? { ...row, IsActive: false } : row
    );
    const label = String(denominations[0]['Label']);

    const { database, outcome } = await migrate(
      buildFixtureReader({ rows: { Denominations: denominations } })
    );

    expect(count(database, 'Denominations')).toBe(1207);
    expect(
      rows(database, `SELECT IsActive FROM Denominations WHERE Label = '${label}'`).some(
        (row) => row['IsActive'] === 0
      )
    ).toBe(true);
    expect(
      outcome.reference?.outcomes.find((e) => e.table === 'Denominations')?.seededEdited
    ).toBe(1);
  });

  it('refuses a source whose denominations are ambiguous', async () => {
    // Two '$1' under United States. Per migrations/seed-sql.ts this does not
    // add a denomination, it removes one, so the tool stops rather than
    // picking a winner.
    const base = defaultRows('Denominations');
    const first = base.find((row) => row['Label'] === '$1');
    const denominations = [
      ...base,
      { ...first, DenominationId: DENOMINATION_ID_OFFSET + 9999 },
    ];

    await expect(
      migrate(buildFixtureReader({ rows: { Denominations: denominations } }))
    ).rejects.toThrow(/twice under|ambiguous/i);
  });

  it('refuses a coin whose denomination link cannot be re-resolved', async () => {
    const coins = defaultRows('Coins').map((coin, index) =>
      index === 0 ? { ...coin, DenominationId: 999_999 } : coin
    );

    await expect(migrate(buildFixtureReader({ rows: { Coins: coins } }))).rejects.toThrow(
      MigrationRefusedError
    );
  });
});

describe('refusing to write into a collection that already exists', () => {
  it('refuses, names the tables, and writes nothing', async () => {
    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO Coins (CoinId, CollectionStatus) VALUES ('test-coin', 'owned')")
      .run();

    const reader = buildFixtureReader();
    await reader.open();

    await expect(
      runMigration(reader, opened, DEFAULTS, SILENT)
    ).rejects.toThrow(TargetNotEmptyError);

    expect(count(opened.database, 'Coins')).toBe(1);
    expect(one(opened.database, 'SELECT CoinId FROM Coins')['CoinId']).toBe('test-coin');
  });

  it('explains what to do instead of merging', async () => {
    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO Coins (CoinId, CollectionStatus) VALUES ('test-coin', 'owned')")
      .run();
    const reader = buildFixtureReader();
    await reader.open();

    const error = await runMigration(reader, opened, DEFAULTS, SILENT).catch((err) => err);
    expect(error.message).toContain('--force');
    expect(error.message).toContain('will not merge');
    expect(error.message).toContain('Coins');
  });

  it('--force deletes the test rows and migrates', async () => {
    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO Coins (CoinId, CollectionStatus) VALUES ('test-coin', 'owned')")
      .run();
    const reader = buildFixtureReader();
    await reader.open();

    const outcome = await runMigration(
      reader,
      opened,
      { ...DEFAULTS, force: true },
      SILENT
    );

    expect(outcome.committed).toBe(true);
    expect(outcome.cleared?.['Coins']).toBe(1);
    expect(count(opened.database, 'Coins')).toBe(2);
    expect(
      rows(opened.database, "SELECT CoinId FROM Coins WHERE CoinId = 'test-coin'")
    ).toEqual([]);
  });

  it('is re-runnable with --force without duplicating reference data', async () => {
    const opened = openTarget(':memory:');

    for (let run = 0; run < 2; run++) {
      const reader = buildFixtureReader();
      await reader.open();
      const outcome = await runMigration(
        reader,
        opened,
        { ...DEFAULTS, force: true },
        SILENT
      );
      expect(outcome.committed, `run ${run}`).toBe(true);
    }

    expect(count(opened.database, 'Coins')).toBe(2);
    expect(count(opened.database, 'Denominations')).toBe(1207);
    expect(count(opened.database, 'Issuers')).toBe(70);
  });
});

describe('a source carrying something SQLite has no room for', () => {
  const withDealer = () =>
    buildFixtureReader({
      columns: { Coins: [...sourceColumnsFor('Coins'), textColumn('Dealer', 200)] },
      rows: {
        Coins: defaultRows('Coins').map((coin) => ({ ...coin, Dealer: 'Heritage' })),
      },
    });

  it('refuses by default rather than walking past the column', async () => {
    await expect(migrate(withDealer())).rejects.toThrow(/not in the shape this migration needs/);
  });

  it('proceeds when the owner abandons it deliberately, and records that he did', async () => {
    const { outcome } = await migrate(withDealer(), { allowExtraSourceColumns: true });

    expect(outcome.committed).toBe(true);
    expect(
      outcome.problems.some(
        (problem) =>
          problem.severity === 'warning' &&
          problem.message.includes('allowed by --allow-extra-source-columns')
      )
    ).toBe(true);
  });

  it('does NOT let that flag excuse a MISSING column', async () => {
    // The two are different questions, and the override answers only one.
    const coins = sourceColumnsFor('Coins').filter((item) => item.name !== 'CollectionStatus');
    const log: string[] = [];

    await expect(
      migrate(
        buildFixtureReader({ columns: { Coins: coins } }),
        { allowExtraSourceColumns: true },
        log
      )
    ).rejects.toThrow(/not in the shape this migration needs \(1 problem/);

    expect(log.join('\n')).toContain('REFUSED');
    expect(log.join('\n')).toContain('010-add-collection-status-and-storage-location.sql');
  });
});

describe('--dry-run', () => {
  it('checks the source and writes nothing', async () => {
    const opened = openTarget(':memory:');
    const reader = buildFixtureReader();
    await reader.open();

    const outcome = await runMigration(
      reader,
      opened,
      { ...DEFAULTS, dryRun: true },
      SILENT
    );

    expect(outcome.committed).toBe(false);
    expect(outcome.verification).toBeNull();
    expect(count(opened.database, 'Coins')).toBe(0);
    expect(count(opened.database, 'CoinImages')).toBe(0);
  });

  /*
   * A rehearsal that validates the schema and says nothing about the data
   * leaves the operator to discover how much is about to move by running the
   * real thing. On the owner's first dry run the output went straight from
   * "source shape accepted" to "stopping here", so he could not tell whether
   * it had found his 105 coins or three of them.
   */
  it('reports how many rows the source holds, before it stops', async () => {
    const opened = openTarget(':memory:');
    const reader = buildFixtureReader();
    await reader.open();
    const logged: string[] = [];

    await runMigration(reader, opened, { ...DEFAULTS, dryRun: true }, (line) => logged.push(line));

    const text = logged.join('\n');
    expect(text).toContain('The source holds:');

    // The count must be the real one, not a constant: assert it against what
    // the reader actually has.
    const coins = await reader.count('Coins');
    expect(coins).toBeGreaterThan(0);
    expect(text).toMatch(new RegExp('Coins\\s+' + coins + ' row\\(s\\)'));
  });

  it('reports the counts even when nothing will be deleted', async () => {
    const opened = openTarget(':memory:');
    const reader = buildFixtureReader();
    await reader.open();
    const logged: string[] = [];

    await runMigration(reader, opened, { ...DEFAULTS, dryRun: true }, (line) => logged.push(line));

    for (const table of ['CoinImages', 'SpotPrices']) {
      expect(logged.join('\n')).toContain(table);
    }
  });
});

describe('verify before commit', () => {
  /**
   * A reader that tells the truth to the copy and a lie to the
   * verification, so the test can prove the ROLLBACK really happens rather
   * than that it is written down somewhere.
   */
  class DriftingReader extends FixtureSourceReader {
    private coinReads = 0;

    override async forEachRow(
      query: SourceQuery,
      onRow: (row: SourceRow) => void
    ): Promise<number> {
      if (query.table !== 'Coins') return super.forEachRow(query, onRow);

      this.coinReads += 1;
      const drift = this.coinReads > 2;
      return super.forEachRow(query, (row) => {
        onRow(
          drift && typeof row['Weight'] === 'number'
            ? { ...row, Weight: row['Weight'] + 0.00001 }
            : row
        );
      });
    }
  }

  it('rolls back and commits nothing when a single weight differs', async () => {
    const opened = openTarget(':memory:');
    const reader = new DriftingReader(buildSourceTables());
    await reader.open();

    const outcome = await runMigration(reader, opened, DEFAULTS, SILENT);

    expect(outcome.committed).toBe(false);
    expect(outcome.verification?.ok).toBe(false);
    expect(outcome.verification?.values.differences.length).toBeGreaterThan(0);
    expect(outcome.verification?.values.differences[0].column).toBe('Weight');

    // The point of the whole arrangement: nothing was written.
    expect(count(opened.database, 'Coins')).toBe(0);
    expect(count(opened.database, 'CoinImages')).toBe(0);
  });
});
