/**
 * Seed versus the owner's own work, at unit level.
 *
 * migrate.spec.ts proves the whole thing end to end; this file pins the
 * pieces that are easy to get subtly wrong and hard to see afterwards —
 * the identity rule, the three buckets, and the two duplicate refusals.
 */

import { describe, it, expect } from 'vitest';

import { readSeedFile } from '../db/seed';
import {
  buildSimpleSeeds,
  denominationKey,
  migrateReferenceData,
  MigrationRefusedError,
} from './reference-data';
import { identityKey, identityText, toBindValue } from './values';
import {
  buildFixtureReader,
  defaultRows,
  DENOMINATION_ID_OFFSET,
  ISSUER_ID_OFFSET,
} from './fixture-collection';
import { openTarget, targetCount } from './target';

async function reconcile(reader = buildFixtureReader()) {
  const opened = openTarget(':memory:');
  await reader.open();
  const result = await migrateReferenceData(reader, opened.database);
  return { result, database: opened.database };
}

describe('the identity rule', () => {
  it('folds case, because every one of these columns is COLLATE NOCASE', () => {
    expect(identityKey('Sear')).toBe(identityKey('sear'));
    expect(identityKey('Mexico')).toBe('mexico');
  });

  it('ignores TRAILING spaces, because SQL Server does and SQLite does not', () => {
    // Without this, 'Mexico ' would be one issuer to SQL Server and a
    // second, separate issuer here — and a second Mexico makes every
    // denomination under it ambiguous.
    expect(identityKey('Mexico ')).toBe(identityKey('Mexico'));
    expect(identityText('Mexico   ')).toBe('Mexico');
  });

  it('does NOT ignore leading spaces, because SQL Server does not either', () => {
    expect(identityKey(' Mexico')).not.toBe(identityKey('Mexico'));
  });

  it('keeps the issuer and the label apart in a denomination key', () => {
    // A naive concatenation would make ('a','bc') and ('ab','c') the same
    // denomination.
    expect(denominationKey('a', 'bc')).not.toBe(denominationKey('ab', 'c'));
    expect(denominationKey(null, '$1')).not.toBe(denominationKey('United States', '$1'));
  });
});

describe('the seed tuples are the ones db/seed.ts writes', () => {
  const seeds = buildSimpleSeeds(readSeedFile());

  it('covers all six single-key reference tables’ seeds', () => {
    expect(seeds['Issuers'].size).toBe(70);
    expect(seeds['Catalogs'].size).toBe(15);
    expect(seeds['Categories'].size).toBe(2);
    expect(seeds['MetalContents'].size).toBe(15);
    expect(seeds['MintMarks'].size).toBe(9);
  });

  it('gives a catalogue the same SortOrder the seeder would', () => {
    expect(seeds['Catalogs'].get('sear')).toEqual(['Sear', 1, 1]);
    expect(seeds['Catalogs'].get('krause (km)')).toEqual(['Krause (KM)', 15, 1]);
  });

  it('includes the blank mint mark, which must not be tidied into a NULL', () => {
    expect(seeds['MintMarks'].get('')).toEqual([
      '',
      'No mintmark / Philadelphia pre-1980',
      1,
    ]);
  });
});

describe('the three buckets', () => {
  it('skips a seeded row that is still exactly the seed', async () => {
    const { result, database } = await reconcile();

    const issuers = result.outcomes.find((outcome) => outcome.table === 'Issuers');
    expect(issuers).toMatchObject({
      sourceRows: 70,
      seededUnchanged: 70,
      seededEdited: 0,
      ownAdded: 0,
      ownUpdated: 0,
    });
    expect(targetCount(database, 'Issuers')).toBe(70);
  });

  it('updates a seeded row the owner edited, in place', async () => {
    const metals = defaultRows('MetalContents').map((row) =>
      row['MetalContentName'] === 'Palladium' ? { ...row, IsActive: false, SortOrder: 42 } : row
    );
    const { result, database } = await reconcile(
      buildFixtureReader({ rows: { MetalContents: metals } })
    );

    expect(result.outcomes.find((o) => o.table === 'MetalContents')).toMatchObject({
      seededEdited: 1,
      ownAdded: 0,
    });
    expect(targetCount(database, 'MetalContents')).toBe(15);
    expect(
      database.prepare("SELECT * FROM MetalContents WHERE MetalContentName = 'Palladium'").all()[0]
    ).toMatchObject({ IsActive: 0, SortOrder: 42 });
  });

  it('inserts a row that is not in the seed at all', async () => {
    const categories = [...defaultRows('Categories'), { CategoryName: 'Ancients' }];
    const { result, database } = await reconcile(
      buildFixtureReader({ rows: { Categories: categories } })
    );

    expect(result.outcomes.find((o) => o.table === 'Categories')).toMatchObject({
      seededUnchanged: 2,
      ownAdded: 1,
    });
    expect(targetCount(database, 'Categories')).toBe(3);
  });

  it('updates rather than inserts when the row is already in the target', async () => {
    // Re-runnability: the owner added 'Ancients' in a previous run.
    const categories = [...defaultRows('Categories'), { CategoryName: 'Ancients' }];
    const reader = buildFixtureReader({ rows: { Categories: categories } });
    const opened = openTarget(':memory:');
    await reader.open();

    await migrateReferenceData(reader, opened.database);
    const second = await migrateReferenceData(reader, opened.database);

    expect(second.outcomes.find((o) => o.table === 'Categories')).toMatchObject({
      ownAdded: 0,
      ownUpdated: 1,
    });
    expect(targetCount(opened.database, 'Categories')).toBe(3);
  });

  it('does not resurrect a seeded row the owner deleted outright', async () => {
    // He removed 'Hendin' from SQL Server completely. db/seed.ts puts it
    // back on every open, so it is in the target and this tool must not
    // then add a second one — but it also cannot know it was deleted, and
    // that is reported by the containment counts rather than guessed at.
    const catalogs = defaultRows('Catalogs').filter((row) => row['Name'] !== 'Hendin');
    const { result, database } = await reconcile(
      buildFixtureReader({ rows: { Catalogs: catalogs } })
    );

    expect(result.outcomes.find((o) => o.table === 'Catalogs')).toMatchObject({
      sourceRows: 14,
      seededUnchanged: 14,
      ownAdded: 0,
    });
    expect(targetCount(database, 'Catalogs')).toBe(15);
  });
});

describe('duplicates are refused, not resolved', () => {
  it('refuses two issuers that differ only by case', async () => {
    const issuers = [
      ...defaultRows('Issuers'),
      {
        IssuerId: ISSUER_ID_OFFSET + 9000,
        Name: 'mexico',
        IsoCode: 'MX',
        Kind: 'modern',
        ValidFrom: null,
        ValidTo: null,
        SortOrder: 1,
        IsActive: true,
      },
    ];

    await expect(reconcile(buildFixtureReader({ rows: { Issuers: issuers } }))).rejects.toThrow(
      MigrationRefusedError
    );
  });

  it('refuses two issuers that differ only by a trailing space', async () => {
    const issuers = [
      ...defaultRows('Issuers'),
      {
        IssuerId: ISSUER_ID_OFFSET + 9000,
        Name: 'Mexico ',
        IsoCode: 'MX',
        Kind: 'modern',
        ValidFrom: null,
        ValidTo: null,
        SortOrder: 1,
        IsActive: true,
      },
    ];

    await expect(reconcile(buildFixtureReader({ rows: { Issuers: issuers } }))).rejects.toThrow(
      /trailing spaces are ignored/
    );
  });

  it('refuses a denomination pointing at an issuer that does not exist', async () => {
    const denominations = [
      ...defaultRows('Denominations'),
      {
        DenominationId: DENOMINATION_ID_OFFSET + 9000,
        Label: 'Orphan',
        Country: 'XX',
        IssuerId: 123_456,
        FaceValue: null,
        SortOrder: 1,
        IsActive: true,
      },
    ];

    await expect(
      reconcile(buildFixtureReader({ rows: { Denominations: denominations } }))
    ).rejects.toThrow(/does not exist in Issuers/);
  });
});

describe('the id maps', () => {
  it('maps every source reference id to the target’s id for the same row', async () => {
    const { result, database } = await reconcile();

    expect(result.denominationIdMap.size).toBe(1207);
    expect(result.catalogIdMap.size).toBe(15);

    // Krause is CatalogId 700+15 in the source and 15 in the target.
    const krauseSource = defaultRows('Catalogs').find((row) => row['Name'] === 'Krause (KM)');
    const krauseTarget = database
      .prepare("SELECT CatalogId FROM Catalogs WHERE Name = 'Krause (KM)'")
      .all()[0];
    expect(result.catalogIdMap.get(Number(krauseSource!['CatalogId']))).toBe(
      Number(krauseTarget['CatalogId'])
    );
    expect(Number(krauseSource!['CatalogId'])).not.toBe(Number(krauseTarget['CatalogId']));
  });

  it('records what each source denomination id MEANS, for the verification', async () => {
    const { result } = await reconcile();

    const dollar = defaultRows('Denominations').find(
      (row) => row['Label'] === '$1' && row['Country'] === 'US'
    );
    expect(result.sourceDenominationKeyById.get(Number(dollar!['DenominationId']))).toBe(
      denominationKey('United States', '$1')
    );
  });

  it('records catalogue names too', async () => {
    const { result } = await reconcile();
    const sear = defaultRows('Catalogs').find((row) => row['Name'] === 'Sear');
    expect(result.sourceCatalogNameById.get(Number(sear!['CatalogId']))).toBe('Sear');
  });
});

describe('toBindValue', () => {
  it('converts what node:sqlite will not bind, and nothing else', () => {
    expect(toBindValue(true)).toBe(1);
    expect(toBindValue(false)).toBe(0);
    expect(toBindValue(new Date('2026-11-01T09:30:00.000Z'))).toBe('2026-11-01T09:30:00.000Z');
    expect(toBindValue(null)).toBeNull();
    expect(toBindValue('text')).toBe('text');
  });

  it('leaves a number ALONE — no rounding, no scaling', () => {
    // The whole value-by-value verification depends on this.
    expect(toBindValue(24.05582)).toBe(24.05582);
    expect(toBindValue(0.1 + 0.2)).toBe(0.30000000000000004);
    expect(toBindValue(-0.5)).toBe(-0.5);
  });
});
