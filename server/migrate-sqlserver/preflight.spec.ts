/**
 * Preflight: the checks that run before anything is written, including the
 * only honest thing that can be said about migration 008.
 */

import { describe, it, expect } from 'vitest';

import {
  checkDecimalPrecision,
  checkWeightUnit,
  compareColumns,
  findExtraTables,
  GRAMS_PER_TROY_OUNCE,
  readSourceShape,
  roundTo,
  weightUnitProblems,
  WEIGHT_BACKUP_TABLE,
  WEIGHT_MARKER_KEY,
  type SourceShape,
} from './preflight';
import {
  buildFixtureReader,
  COIN_ONE,
  COIN_TWO,
  defaultRows,
  sourceColumnsFor,
} from './fixture-collection';
import { fixtureTable } from './fixture-source-reader';
import { decimalColumn, textColumn } from './fixture-source-reader';
import { intendedColumns } from './migrate';
import { openTarget } from './target';
import { ALL_TABLES } from './tables';

function targetIntent(): Record<string, readonly string[]> {
  const opened = openTarget(':memory:');
  try {
    return intendedColumns(opened.database);
  } finally {
    opened.database.close();
  }
}

async function shapeOf(reader = buildFixtureReader()): Promise<SourceShape> {
  await reader.open();
  return readSourceShape(reader);
}

describe('every column we intend to read must exist', () => {
  it('is happy with a fully migrated source', async () => {
    expect(compareColumns(targetIntent(), await shapeOf())).toEqual([]);
  });

  it('names the migration that supplies a missing column', async () => {
    const withoutStatus = sourceColumnsFor('Coins').filter(
      (item) => item.name !== 'CollectionStatus'
    );
    const problems = compareColumns(
      targetIntent(),
      await shapeOf(buildFixtureReader({ columns: { Coins: withoutStatus } }))
    );

    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe('fatal');
    expect(problems[0].message).toContain('Coins.CollectionStatus is missing');
    expect(problems[0].message).toContain('010-add-collection-status-and-storage-location.sql');
    expect(problems[0].message).toContain('nothing has been written');
  });

  it('names 011 for the denomination link and 012 for the catalogue one', async () => {
    const coins = sourceColumnsFor('Coins').filter(
      (item) => item.name !== 'DenominationId' && item.name !== 'CatalogNumber'
    );
    const problems = compareColumns(
      targetIntent(),
      await shapeOf(buildFixtureReader({ columns: { Coins: coins } }))
    );

    expect(problems.map((problem) => problem.message).join('\n')).toContain(
      '011-add-issuers-and-denomination-links.sql'
    );
    expect(problems.map((problem) => problem.message).join('\n')).toContain(
      '012-add-catalog-references.sql'
    );
  });

  it('names 011 when the whole Issuers table is absent', async () => {
    const problems = compareColumns(
      targetIntent(),
      await shapeOf(buildFixtureReader({ withoutTables: ['Issuers'] }))
    );

    expect(problems[0].message).toContain('Source table Issuers does not exist');
    expect(problems[0].message).toContain('011-add-issuers-and-denomination-links.sql');
  });

  it('refuses a column SQLite has nowhere to put, naming 006', async () => {
    // A surplus column is NOT harmless: it is data the migration would walk
    // past without saying so.
    const coins = [...sourceColumnsFor('Coins'), textColumn('Dealer', 200)];
    const problems = compareColumns(
      targetIntent(),
      await shapeOf(buildFixtureReader({ columns: { Coins: coins } }))
    );

    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe('fatal');
    expect(problems[0].message).toContain('006-drop-coin-dealer.sql');
    expect(problems[0].message).toContain('--allow-extra-source-columns');
  });
});

describe('tables the migration does not know about', () => {
  it('accepts migration 008’s backup table', async () => {
    expect(findExtraTables([...ALL_TABLES, WEIGHT_BACKUP_TABLE])).toEqual([]);
  });

  /*
   * Migration 007 takes its own backup (007 line 1655, `INTO
   * Coins_MetalData_Backup`) before inferring metal and composition. It was
   * absent from EXPECTED_EXTRA_TABLES, so the owner's first real run refused
   * with "Nothing in this project created it" — false, and it sent him
   * looking for a table that was never a mystery.
   *
   * Nothing pinned that list, which is why adding 008's entry and forgetting
   * 007's went unnoticed. Both are asserted here, by name, together.
   */
  it('accepts migration 007’s backup table', () => {
    expect(findExtraTables([...ALL_TABLES, 'Coins_MetalData_Backup'])).toEqual([]);
  });

  it('accepts both migration backups at once, which is the real-world case', () => {
    expect(findExtraTables([...ALL_TABLES, WEIGHT_BACKUP_TABLE, 'Coins_MetalData_Backup'])).toEqual([]);
  });

  /*
   * The tolerance above must stay narrow. A surplus table is normally
   * evidence that a migration did NOT run, and refusing is what stops the
   * copy walking past data with nothing said.
   */
  it('still refuses a table it genuinely does not recognise', () => {
    const problems = findExtraTables([...ALL_TABLES, 'Coins_Something_Else']);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('Coins_Something_Else');
  });

  it('refuses CoinTags and names 005', () => {
    const problems = findExtraTables([...ALL_TABLES, 'CoinTags']);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('005-drop-coin-tags.sql');
  });
});

describe('decimal precision — the one numeric migration that can be checked', () => {
  it('passes on a source that has had 004 run', async () => {
    expect(checkDecimalPrecision(await shapeOf())).toEqual([]);
  });

  it('refuses a Weight still at the pre-004 precision, and names 004', async () => {
    const coins = sourceColumnsFor('Coins').map((item) =>
      item.name === 'Weight' ? decimalColumn('Weight', 10, 3) : item
    );
    const problems = checkDecimalPrecision(
      await shapeOf(buildFixtureReader({ columns: { Coins: coins } }))
    );

    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe('fatal');
    expect(problems[0].message).toContain('DECIMAL(10,3)');
    expect(problems[0].message).toContain('004-widen-weight-precision.sql');
  });
});

describe('migration 008, and what can honestly be said about it', () => {
  const weights = new Map<string, number | null>([
    [COIN_ONE.toLowerCase(), 26.73],
    [COIN_TWO.toLowerCase(), 3.87654],
  ]);

  it('finds the marker the migration writes in the same transaction as its UPDATE', async () => {
    const reader = buildFixtureReader();
    await reader.open();
    const evidence = await checkWeightUnit(reader, await reader.tables(), weights);

    expect(evidence.markerPresent).toBe(true);
    expect(evidence.markerValue).toContain('31.1034768');
    expect(weightUnitProblems(evidence, false).filter((p) => p.severity === 'fatal')).toEqual([]);
  });

  it('REFUSES to migrate when the marker is absent', async () => {
    const reader = buildFixtureReader({
      rows: { AppSettings: [{ SettingKey: 'theme', SettingValue: 'dark' }] },
    });
    await reader.open();
    const evidence = await checkWeightUnit(reader, await reader.tables(), weights);

    expect(evidence.markerPresent).toBe(false);
    const problems = weightUnitProblems(evidence, false);
    expect(problems[0].severity).toBe('fatal');
    expect(problems[0].message).toContain('TROY OUNCES');
    expect(problems[0].message).toContain('--weights-are-grams');
  });

  it('downgrades to a warning when the owner asserts it, and says whose claim it is', async () => {
    const reader = buildFixtureReader({ rows: { AppSettings: [] } });
    await reader.open();
    const evidence = await checkWeightUnit(reader, await reader.tables(), weights);

    const problems = weightUnitProblems(evidence, true);
    expect(problems[0].severity).toBe('warning');
    expect(problems[0].message).toContain('your assertion, not a check this tool performed');
  });

  it('checks the weights arithmetically when the backup table survives', async () => {
    // Built the way migration 008 built it: a troy-ounce value, multiplied
    // by the factor and rounded to the column's five decimals. Deriving the
    // prior value by DIVIDING a gram weight would not round-trip — 26.73 g
    // divided by the factor and multiplied back lands on 26.73031 — which
    // is itself a small demonstration of why this check is corroboration
    // and not a gate.
    const priorOne = 0.85938;
    const priorTwo = 0.12463;
    const converted = new Map<string, number | null>([
      [COIN_ONE.toLowerCase(), roundTo(priorOne * GRAMS_PER_TROY_OUNCE, 5)],
      [COIN_TWO.toLowerCase(), roundTo(priorTwo * GRAMS_PER_TROY_OUNCE, 5)],
    ]);

    const reader = buildFixtureReader({
      extraTables: {
        [WEIGHT_BACKUP_TABLE]: fixtureTable(
          [textColumn('CoinId', 36), decimalColumn('Weight', 12, 5)],
          [
            { CoinId: COIN_ONE, Weight: priorOne },
            { CoinId: COIN_TWO, Weight: priorTwo },
          ]
        ),
      },
    });
    await reader.open();

    const evidence = await checkWeightUnit(reader, await reader.tables(), converted);
    expect(evidence.backupTablePresent).toBe(true);
    expect(evidence.backupRowsChecked).toBe(2);
    expect(evidence.backupRowsConsistent).toBe(2);
    expect(evidence.backupRowsInconsistent).toBe(0);
  });

  it('reports an inconsistent weight as something to look at, not as a failure', async () => {
    const reader = buildFixtureReader({
      extraTables: {
        [WEIGHT_BACKUP_TABLE]: fixtureTable(
          [textColumn('CoinId', 36), decimalColumn('Weight', 12, 5)],
          [{ CoinId: COIN_ONE, Weight: 1.0 }]
        ),
      },
    });
    await reader.open();

    const evidence = await checkWeightUnit(reader, await reader.tables(), weights);
    expect(evidence.backupRowsInconsistent).toBe(1);

    const problems = weightUnitProblems(evidence, false);
    expect(problems.every((problem) => problem.severity === 'warning')).toBe(true);
    expect(problems.map((p) => p.message).join(' ')).toContain('not by itself an error');
  });

  it('says plainly that a dropped backup leaves only the marker', async () => {
    const reader = buildFixtureReader();
    await reader.open();
    const evidence = await checkWeightUnit(reader, await reader.tables(), weights);

    const problems = weightUnitProblems(evidence, false);
    expect(problems.map((p) => p.message).join(' ')).toContain(
      'evidence about an event, not a measurement'
    );
  });

  it('is keyed on the marker row and nothing else in AppSettings', async () => {
    const reader = buildFixtureReader({
      rows: {
        AppSettings: [
          { SettingKey: 'migration-008-weight-grams-something-else', SettingValue: 'x' },
        ],
      },
    });
    await reader.open();
    expect((await checkWeightUnit(reader, await reader.tables(), weights)).markerPresent).toBe(
      false
    );
  });

  it('the marker key is spelled exactly as migration 008 writes it', () => {
    expect(WEIGHT_MARKER_KEY).toBe('migration-008-weight-grams');
    expect(defaultRows('AppSettings').some((row) => row['SettingKey'] === WEIGHT_MARKER_KEY)).toBe(
      true
    );
  });
});
