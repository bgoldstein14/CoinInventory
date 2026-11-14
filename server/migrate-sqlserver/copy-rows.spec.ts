/**
 * The row copy: streaming, the id remapping, and what happens to a link
 * that cannot be re-resolved.
 */

import { describe, it, expect } from 'vitest';

import { copyTable, PROGRESS_EVERY, selectItemsFor, type IdMaps } from './copy-rows';
import { MigrationRefusedError } from './reference-data';
import { fixtureTable, FixtureSourceReader, textColumn, intColumn } from './fixture-source-reader';
import { buildFixtureReader, sourceColumnsFor } from './fixture-collection';
import { openTarget, targetColumns, targetCount } from './target';
import type { SourceRow } from './source-reader';

const SILENT = (): void => undefined;

const NO_MAPS: IdMaps = { denominationIdMap: new Map(), catalogIdMap: new Map() };

describe('selectItemsFor', () => {
  it('asks the source what each id column is, and reads a GUID as lower text', () => {
    const items = selectItemsFor(['CoinId', 'Weight'], sourceColumnsFor('Coins'));

    expect(items[0].expression).toBe('LOWER(CONVERT(NVARCHAR(36), [CoinId]))');
    expect(items[1].expression).toBe('[Weight]');
  });

  it('leaves an id column that is already text exactly as it is', () => {
    const items = selectItemsFor(
      ['CoinId'],
      [{ name: 'CoinId', dataType: 'nvarchar', maxLength: 36, precision: null, scale: null }]
    );
    expect(items[0].expression).toBe('[CoinId]');
  });

  it('refuses a column the source does not have', () => {
    expect(() => selectItemsFor(['Nope'], sourceColumnsFor('Coins'))).toThrow(
      MigrationRefusedError
    );
  });
});

describe('streaming', () => {
  it('never holds more than one row, and reports progress as it goes', async () => {
    // 250 rows through a table shaped like CoinImages. The test is not that
    // it is fast — it is that the copy is driven one row at a time, which
    // is what keeps ~2,140 base64 photographs from being an array.
    const rows = Array.from({ length: 250 }, (_unused, index) => ({
      ImageId: index + 1,
      CoinId: 'c1',
      ImageData: `data:image/jpeg;base64,${'A'.repeat(32)}`,
      SortOrder: index,
      SourcePath: null,
    }));

    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO Coins (CoinId, CollectionStatus) VALUES ('c1', 'owned')")
      .run();

    const reader = new FixtureSourceReader({
      CoinImages: fixtureTable(sourceColumnsFor('CoinImages'), rows),
    });
    await reader.open();

    const progress: string[] = [];
    const outcome = await copyTable(
      reader,
      opened.database,
      'CoinImages',
      targetColumns(opened.database, 'CoinImages'),
      sourceColumnsFor('CoinImages'),
      NO_MAPS,
      (line) => progress.push(line)
    );

    expect(outcome.rows).toBe(250);
    expect(targetCount(opened.database, 'CoinImages')).toBe(250);
    expect(progress).toHaveLength(Math.floor(250 / PROGRESS_EVERY));
    expect(progress[0]).toContain('100 row(s) copied');
    expect(outcome.imageCharacters).toBe(250 * rows[0].ImageData.length);
  });

  it('preserves the explicit ImageId and advances the autoincrement past it', async () => {
    const opened = openTarget(':memory:');
    opened.database
      .prepare("INSERT INTO Coins (CoinId, CollectionStatus) VALUES ('c1', 'owned')")
      .run();

    const reader = new FixtureSourceReader({
      CoinImages: fixtureTable(sourceColumnsFor('CoinImages'), [
        { ImageId: 4242, CoinId: 'c1', ImageData: 'x', SortOrder: 0, SourcePath: null },
      ]),
    });
    await reader.open();

    await copyTable(
      reader,
      opened.database,
      'CoinImages',
      targetColumns(opened.database, 'CoinImages'),
      sourceColumnsFor('CoinImages'),
      NO_MAPS,
      SILENT
    );

    expect(
      opened.database.prepare('SELECT ImageId FROM CoinImages').all()[0]['ImageId']
    ).toBe(4242);

    const next = opened.database
      .prepare("INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES ('c1', 'y', 1)")
      .run();
    expect(Number(next.lastInsertRowid)).toBe(4243);
  });
});

describe('the reference links', () => {
  it('writes the TARGET id, not the source one', async () => {
    const opened = openTarget(':memory:');
    const columns = targetColumns(opened.database, 'Coins');

    const reader = new FixtureSourceReader({
      Coins: fixtureTable(sourceColumnsFor('Coins'), [
        { CoinId: 'C1', CollectionStatus: 'owned', HasCacSticker: false, DenominationId: 5001, CatalogId: 701 },
      ]),
    });
    await reader.open();

    const outcome = await copyTable(
      reader,
      opened.database,
      'Coins',
      columns,
      sourceColumnsFor('Coins'),
      {
        denominationIdMap: new Map([[5001, 7]]),
        catalogIdMap: new Map([[701, 3]]),
      },
      SILENT
    );

    const coin = opened.database.prepare('SELECT * FROM Coins').all()[0];
    expect(coin['DenominationId']).toBe(7);
    expect(coin['CatalogId']).toBe(3);
    expect(outcome.linksResolved).toBe(2);
  });

  it('leaves a NULL link NULL — never resolved is a normal state', async () => {
    const opened = openTarget(':memory:');
    const reader = new FixtureSourceReader({
      Coins: fixtureTable(sourceColumnsFor('Coins'), [
        { CoinId: 'C1', CollectionStatus: 'owned', HasCacSticker: false, DenominationId: null, CatalogId: null },
      ]),
    });
    await reader.open();

    const outcome = await copyTable(
      reader,
      opened.database,
      'Coins',
      targetColumns(opened.database, 'Coins'),
      sourceColumnsFor('Coins'),
      NO_MAPS,
      SILENT
    );

    expect(opened.database.prepare('SELECT * FROM Coins').all()[0]['DenominationId']).toBeNull();
    expect(outcome.linksResolved).toBe(0);
  });

  it('REFUSES a link it cannot re-resolve, rather than storing the source integer', async () => {
    // Storing the source integer is the silent catastrophe: it would point
    // at whatever happens to occupy that id in the target.
    const opened = openTarget(':memory:');
    const reader = new FixtureSourceReader({
      Coins: fixtureTable(sourceColumnsFor('Coins'), [
        { CoinId: 'C1', CollectionStatus: 'owned', HasCacSticker: false, DenominationId: 5001 },
      ]),
    });
    await reader.open();

    await expect(
      copyTable(
        reader,
        opened.database,
        'Coins',
        targetColumns(opened.database, 'Coins'),
        sourceColumnsFor('Coins'),
        NO_MAPS,
        SILENT
      )
    ).rejects.toThrow(/no counterpart in the migrated reference data/);

    expect(targetCount(opened.database, 'Coins')).toBe(0);
  });

  it('REFUSES rather than storing it even when the integer would be valid there', async () => {
    const opened = openTarget(':memory:');
    const reader = new FixtureSourceReader({
      Coins: fixtureTable(sourceColumnsFor('Coins'), [
        // 7 is a perfectly real DenominationId in the target. It is still
        // the wrong one, because it means something else in the source.
        { CoinId: 'C1', CollectionStatus: 'owned', HasCacSticker: false, DenominationId: 7 },
      ]),
    });
    await reader.open();

    await expect(
      copyTable(
        reader,
        opened.database,
        'Coins',
        targetColumns(opened.database, 'Coins'),
        sourceColumnsFor('Coins'),
        NO_MAPS,
        SILENT
      )
    ).rejects.toThrow(MigrationRefusedError);
  });
});

describe('type conversion at the boundary', () => {
  it('turns a BIT into 0/1 and a Date into ISO-8601 text', async () => {
    const opened = openTarget(':memory:');
    const reader = buildFixtureReader();
    await reader.open();

    await copyTable(
      reader,
      opened.database,
      'SpotPrices',
      targetColumns(opened.database, 'SpotPrices'),
      sourceColumnsFor('SpotPrices'),
      NO_MAPS,
      SILENT
    );

    const row = opened.database.prepare('SELECT * FROM SpotPrices').all()[0];
    expect(row['FetchedAt']).toBe('2026-11-01T09:30:00.000Z');
    expect(row['Gold']).toBe(2345.67);
  });

  it('passes a decimal through untouched — no rounding in the copy path', async () => {
    const opened = openTarget(':memory:');
    const reader = new FixtureSourceReader({
      Coins: fixtureTable(sourceColumnsFor('Coins'), [
        { CoinId: 'C1', CollectionStatus: 'owned', HasCacSticker: false, Weight: 0.1 + 0.2 },
      ]),
    });
    await reader.open();

    await copyTable(
      reader,
      opened.database,
      'Coins',
      targetColumns(opened.database, 'Coins'),
      sourceColumnsFor('Coins'),
      NO_MAPS,
      SILENT
    );

    // 0.30000000000000004 and not 0.3. The copy is a copy: db/bind-values.ts
    // rounds an incoming HTTP request, this reproduces what SQL Server
    // already stored, and the verification is what proves it round-tripped.
    expect(opened.database.prepare('SELECT Weight FROM Coins').all()[0]['Weight']).toBe(
      0.1 + 0.2
    );
  });
});

describe('the fixture reader itself', () => {
  it('validates the identifiers it is asked for, like the real one would', async () => {
    const reader = new FixtureSourceReader({
      T: fixtureTable([textColumn('A'), intColumn('B')], [{ A: 'x', B: 1 }]),
    });
    await reader.open();

    const seen: SourceRow[] = [];
    await reader.forEachRow(
      { table: 'T', select: [{ expression: '[A]', alias: 'A' }] },
      (row) => seen.push(row)
    );

    expect(seen).toEqual([{ A: 'x' }]);
    expect(reader.statements[0]).toBe('SELECT [A] AS [A] FROM [T]');
  });

  it('refuses to be used before open() or after close()', async () => {
    const reader = new FixtureSourceReader({ T: fixtureTable([textColumn('A')], []) });
    await expect(reader.count('T')).rejects.toThrow(/before open/);
    await reader.open();
    await reader.close();
    await expect(reader.count('T')).rejects.toThrow(/after close/);
  });
});
