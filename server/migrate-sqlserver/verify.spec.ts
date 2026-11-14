/**
 * The verification, including the guard on the verification itself.
 *
 * A check that compares nothing reports zero differences, which reads
 * exactly like a clean run — so the most important test in this file is the
 * one that proves a check which stops comparing goes RED rather than green.
 */

import { describe, it, expect } from 'vitest';

import {
  assertCoverage,
  checkNumericValues,
  checkReferenceContainment,
  checkRowCounts,
  sameValue,
  verifyMigration,
  type CountCheck,
  type LinkCheck,
  type ValueCheck,
} from './verify';
import { buildFixtureReader, COIN_ONE, defaultRows } from './fixture-collection';
import { openTarget } from './target';
import { runMigration } from './migrate';
import { MigrationRefusedError } from './reference-data';

const SILENT = (): void => undefined;
const OPTIONS = {
  force: false,
  dryRun: false,
  weightsAreGrams: false,
  allowExtraSourceColumns: false,
};

async function migrated(reader = buildFixtureReader()) {
  const opened = openTarget(':memory:');
  await reader.open();
  const outcome = await runMigration(reader, opened, OPTIONS, SILENT);
  return { opened, outcome, reader };
}

describe('sameValue', () => {
  it('is an exact comparison, not a tolerance', () => {
    // db/schema.sql chose REAL precisely so this can be ===. An epsilon
    // here would hide the drift the whole check exists to find.
    expect(sameValue(24.05582, 24.05582)).toBe(true);
    expect(sameValue(24.05582, 24.055821)).toBe(false);
    expect(sameValue(24.05582, 24.0558200001)).toBe(false);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, 0)).toBe(false);
    expect(sameValue(0, null)).toBe(false);
  });
});

describe('row counts', () => {
  it('matches on every owner table after a migration', async () => {
    const { opened, reader } = await migrated();
    const counts = await checkRowCounts(reader, opened.database);

    expect(counts.every((check) => check.matches)).toBe(true);
    expect(counts.find((check) => check.table === 'CoinImages')).toMatchObject({
      source: 2,
      target: 2,
    });
  });

  it('reports a mismatch rather than throwing', async () => {
    const { opened, reader } = await migrated();
    opened.database.prepare('DELETE FROM CoinImages').run();

    const counts = await checkRowCounts(reader, opened.database);
    const images = counts.find((check) => check.table === 'CoinImages');
    expect(images).toMatchObject({ source: 2, target: 0, matches: false });
  });
});

describe('reference containment', () => {
  it('finds every one of the owner’s reference rows in the target', async () => {
    const { opened, reader } = await migrated();
    const checks = await checkReferenceContainment(reader, opened.database);

    expect(checks.every((check) => check.missingFromTarget.length === 0)).toBe(true);
    // The counts are allowed to differ; here they happen to agree because
    // the fixture's source holds exactly the current seed.
    expect(checks.find((check) => check.table === 'Denominations')).toMatchObject({
      sourceRows: 1207,
      targetRows: 1207,
    });
  });

  it('names a reference row that failed to arrive', async () => {
    const { opened, reader } = await migrated();
    opened.database.prepare("DELETE FROM Catalogs WHERE Name = 'Hendin'").run();

    const checks = await checkReferenceContainment(reader, opened.database);
    expect(checks.find((check) => check.table === 'Catalogs')?.missingFromTarget).toEqual([
      'Hendin',
    ]);
  });

  it('names a denomination that failed to arrive, with its issuer', async () => {
    const { opened, reader } = await migrated();

    // Any denomination no coin points at — the foreign key would (rightly)
    // refuse to let one in use disappear, which is itself worth seeing.
    const victim = opened.database
      .prepare(
        'SELECT d.DenominationId AS id, d.Label AS label, i.Name AS issuer ' +
          'FROM Denominations d JOIN Issuers i ON i.IssuerId = d.IssuerId ' +
          'WHERE d.DenominationId NOT IN ' +
          '(SELECT DenominationId FROM Coins WHERE DenominationId IS NOT NULL) LIMIT 1'
      )
      .all()[0];
    opened.database
      .prepare('DELETE FROM Denominations WHERE DenominationId = ?')
      .run(Number(victim['id']));

    const checks = await checkReferenceContainment(reader, opened.database);
    expect(checks.find((check) => check.table === 'Denominations')?.missingFromTarget).toEqual([
      `${String(victim['label'])} (${String(victim['issuer'])})`,
    ]);
  });
});

describe('value by value', () => {
  it('compares six columns per coin plus the spot prices', async () => {
    const { opened, reader } = await migrated();
    const result = await checkNumericValues(reader, opened.database);

    // 2 coins x 6 + 1 spot price row x 4
    expect(result.rowsChecked).toBe(3);
    expect(result.valuesChecked).toBe(16);
    expect(result.differences).toEqual([]);
  });

  it('catches a weight that drifted by one unit in the last place', async () => {
    const { opened, reader } = await migrated();
    opened.database
      .prepare('UPDATE Coins SET Weight = ? WHERE CoinId = ?')
      .run(26.730000000000004, COIN_ONE.toLowerCase());

    const result = await checkNumericValues(reader, opened.database);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({
      table: 'Coins',
      column: 'Weight',
      source: 26.73,
      target: 26.730000000000004,
    });
  });

  it('catches a null that became a zero', async () => {
    const { opened, reader } = await migrated();
    opened.database
      .prepare('UPDATE Coins SET SoldPrice = 0 WHERE CoinId = ?')
      .run(COIN_ONE.toLowerCase());

    const result = await checkNumericValues(reader, opened.database);
    expect(result.differences[0]).toMatchObject({ column: 'SoldPrice', source: null, target: 0 });
  });

  // This case used to change Transactions.Amount AND SpotPrices.Copper and
  // assert both were caught, which is what proved OTHER_NUMERIC_COLUMNS is
  // walked as a LIST rather than its first entry being checked. Transactions
  // is gone, so the list has one entry; the property that survives is that
  // the non-Coins entry is checked at all, which is what this now pins.
  it('catches a spot price', async () => {
    const { opened, reader } = await migrated();
    opened.database.prepare('UPDATE SpotPrices SET Copper = 4.1235').run();

    const result = await checkNumericValues(reader, opened.database);
    expect(result.differences.map((difference) => difference.column).sort()).toEqual([
      'Copper',
    ]);
  });
});

describe('the link check compares what the ids MEAN', () => {
  it('passes when the coin points at the same denomination and catalogue', async () => {
    const { outcome } = await migrated();
    expect(outcome.verification?.links.differences).toEqual([]);
    expect(outcome.verification?.links.coinsChecked).toBe(2);
  });

  it('catches a coin re-pointed at a different denomination', async () => {
    const { opened, outcome, reader } = await migrated();
    expect(outcome.committed).toBe(true);

    const other = opened.database
      .prepare("SELECT DenominationId FROM Denominations WHERE Label = '5¢' LIMIT 1")
      .all()[0];
    opened.database
      .prepare('UPDATE Coins SET DenominationId = ? WHERE CoinId = ?')
      .run(Number(other['DenominationId']), COIN_ONE.toLowerCase());

    const report = await verifyMigration(
      reader,
      opened.database,
      outcome.reference!.sourceDenominationKeyById,
      outcome.reference!.sourceCatalogNameById
    );

    expect(report.ok).toBe(false);
    expect(report.links.differences[0]).toMatchObject({ column: 'DenominationId' });
  });

  it('catches a catalogue link that was dropped', async () => {
    const { opened, outcome, reader } = await migrated();
    opened.database.prepare('UPDATE Coins SET CatalogId = NULL').run();

    const report = await verifyMigration(
      reader,
      opened.database,
      outcome.reference!.sourceDenominationKeyById,
      outcome.reference!.sourceCatalogNameById
    );

    expect(report.links.differences.map((d) => d.column)).toContain('CatalogId');
  });
});

describe('the guard on the verification itself', () => {
  const counts: CountCheck[] = [
    { table: 'Coins', source: 105, target: 105, matches: true },
    { table: 'SpotPrices', source: 3, target: 3, matches: true },
    { table: 'CoinImages', source: 2140, target: 2140, matches: true },
    { table: 'CoinSets', source: 4, target: 4, matches: true },
    { table: 'AppSettings', source: 5, target: 5, matches: true },
  ];

  const fullCoverage: ValueCheck = {
    // Coins + SpotPrices. The `+ 8 * 1` term was Transactions.Amount, which
    // went with the table; OTHER_NUMERIC_COLUMNS has one entry now.
    rowsChecked: 105 + 3,
    valuesChecked: 105 * 6 + 3 * 4,
    differences: [],
  };

  const fullLinks: LinkCheck = {
    coinsChecked: 105,
    denominationLinksChecked: 105,
    catalogLinksChecked: 105,
    differences: [],
  };

  it('accepts a verification that covered everything', () => {
    expect(() => assertCoverage(counts, fullCoverage, fullLinks)).not.toThrow();
  });

  it('REFUSES a verification that compared nothing', () => {
    // The failure that looks exactly like success.
    expect(() =>
      assertCoverage(counts, { rowsChecked: 0, valuesChecked: 0, differences: [] }, fullLinks)
    ).toThrow(MigrationRefusedError);

    expect(() =>
      assertCoverage(counts, { rowsChecked: 0, valuesChecked: 0, differences: [] }, fullLinks)
    ).toThrow(/did not cover the data/i);
  });

  it('REFUSES a verification that covered only some of the rows', () => {
    expect(() =>
      assertCoverage(counts, { ...fullCoverage, valuesChecked: 630 }, fullLinks)
    ).toThrow(/Expected 642 value comparison/);
  });

  it('REFUSES a link check that skipped coins', () => {
    expect(() => assertCoverage(counts, fullCoverage, { ...fullLinks, coinsChecked: 0 })).toThrow(
      /LINK CHECK DID NOT COVER/
    );
  });

  it('says the database was not committed, so the operator knows where they stand', () => {
    try {
      assertCoverage(counts, { rowsChecked: 0, valuesChecked: 0, differences: [] }, fullLinks);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('NOT been committed');
    }
  });
});

describe('a source with no rows at all', () => {
  it('still verifies, and the coverage guard does not fire on zero of zero', async () => {
    const empty = buildFixtureReader({
      rows: { Coins: [], CoinImages: [], SpotPrices: [], CoinSets: [] },
    });
    const { outcome } = await migrated(empty);

    expect(outcome.committed).toBe(true);
    expect(outcome.verification?.values.valuesChecked).toBe(0);
    expect(outcome.verification?.ok).toBe(true);
    // ...and the reference data still moved.
    expect(defaultRows('Issuers').length).toBe(70);
  });
});
