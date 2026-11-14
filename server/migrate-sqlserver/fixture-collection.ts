/**
 * migrate-sqlserver/fixture-collection.ts — a plausible SQL Server
 * CoinInventory database, built out of the project's own files.
 *
 * Not a spec; a builder the specs share. Two decisions in it are worth
 * knowing about:
 *
 *   THE COLUMN METADATA IS DERIVED FROM db/schema.sql, not retyped. If it
 *   were retyped, a column added to the schema would leave the fixture
 *   behind and preflight would pass in the suite while failing on the
 *   owner's machine — which is the one failure mode a fixture must not
 *   have. test-support/schema-columns.ts is the existing parser for the
 *   trailing `-- NVARCHAR(100)` convention and is reused here.
 *
 *   THE REFERENCE TABLES HOLD THE REAL SEED, all 70 issuers and 1,207
 *   denominations out of migrations/seed-data/issuers-denominations.json.
 *   A fixture with three issuers would make "seeded rows are not copied"
 *   true by accident. With the real seed, a bug that duplicated reference
 *   rows shows up as 1,207 extra denominations.
 *
 * The coin ids are deliberately UPPER CASE, which is what `tedious` returns
 * for a UNIQUEIDENTIFIER. The migration normalises them; the specs check it.
 */

import {
  CATALOG_SEED,
  CATEGORY_SEED,
  METAL_CONTENT_SEED,
  MINT_MARK_SEED,
  readSeedFile,
} from '../db/seed';
import { parseTable, type SchemaColumn } from '../test-support/schema-columns';
import { fixtureTable, FixtureSourceReader, type FixtureTable } from './fixture-source-reader';
import type { SourceColumn, SourceRow, SourceValue } from './source-reader';
import { ALL_TABLES } from './tables';

/** Columns that are UNIQUEIDENTIFIER in setup-database.sql. */
const GUID_COLUMNS = new Set([
  'Coins.CoinId',
  'CoinImages.CoinId',
]);

/** Turns one db/schema.sql column into what INFORMATION_SCHEMA would say. */
export function toSourceColumn(table: string, parsed: SchemaColumn): SourceColumn {
  const name = parsed.column;

  if (GUID_COLUMNS.has(`${table}.${name}`)) {
    return { name, dataType: 'uniqueidentifier', maxLength: null, precision: null, scale: null };
  }

  const declared = parsed.declared;

  if (declared.startsWith('NVARCHAR(') || declared.startsWith('CHAR(')) {
    return {
      name,
      dataType: declared.startsWith('CHAR(') ? 'char' : 'nvarchar',
      maxLength: parsed.maxLength ?? -1,
      precision: null,
      scale: null,
    };
  }
  if (declared === 'INT') {
    return { name, dataType: 'int', maxLength: null, precision: 10, scale: 0 };
  }
  if (declared === 'BIT') {
    return { name, dataType: 'bit', maxLength: null, precision: null, scale: null };
  }
  if (declared.startsWith('DECIMAL(')) {
    return {
      name,
      dataType: 'decimal',
      maxLength: null,
      precision: parsed.precision ?? null,
      scale: parsed.scale ?? null,
    };
  }
  if (declared === 'DATETIME2') {
    return { name, dataType: 'datetime2', maxLength: null, precision: null, scale: null };
  }

  // No trailing comment: fall back to the storage class. Nothing in the
  // current schema reaches here; it exists so a new column without a
  // comment produces a usable fixture rather than a crash.
  return {
    name,
    dataType: parsed.storage === 'REAL' ? 'float' : parsed.storage === 'INTEGER' ? 'int' : 'nvarchar',
    maxLength: parsed.storage === 'TEXT' ? -1 : null,
    precision: null,
    scale: null,
  };
}

/** Every column of one table, as the source would describe it. */
export function sourceColumnsFor(table: string): SourceColumn[] {
  return [...parseTable(table).values()].map((parsed) => toSourceColumn(table, parsed));
}

/**
 * *** THE SOURCE'S REFERENCE IDS DELIBERATELY DO NOT MATCH THE TARGET'S. ***
 *
 * Both databases seed from the same JSON in the same order, so left alone
 * the fixture would give `DenominationId` 412 the same meaning on both
 * sides — and every test of the id remapping would pass whether the tool
 * remapped anything or not. Offsetting the source's ids makes a copied
 * integer visibly wrong: it either lands on a different denomination or on
 * no row at all.
 */
export const ISSUER_ID_OFFSET = 900;
export const DENOMINATION_ID_OFFSET = 5000;
export const CATALOG_ID_OFFSET = 700;

/** A sample coin, with every numeric column populated to five decimals. */
export const COIN_ONE = 'A1B2C3D4-0000-4000-8000-000000000001';
export const COIN_TWO = 'A1B2C3D4-0000-4000-8000-000000000002';

/** What the fixture builder lets a spec change. */
export interface FixtureOverrides {
  /** Extra or replacement rows, merged over the defaults by table name. */
  readonly rows?: Partial<Record<string, ReadonlyArray<Record<string, SourceValue>>>>;
  /** Replace a table's column list entirely — used to simulate a source
   *  that has not had a migration run against it. */
  readonly columns?: Partial<Record<string, readonly SourceColumn[]>>;
  /** Tables to remove outright. */
  readonly withoutTables?: readonly string[];
  /** Extra tables that are not part of the schema. */
  readonly extraTables?: Record<string, FixtureTable>;
}

/** Builds the twelve source tables. */
export function buildSourceTables(
  overrides: FixtureOverrides = {}
): Record<string, FixtureTable> {
  const seed = readSeedFile();

  const issuerRows = seed.issuers.map((issuer, index) => ({
    IssuerId: ISSUER_ID_OFFSET + index + 1,
    Name: issuer.name,
    IsoCode: issuer.isoCode,
    Kind: issuer.kind,
    ValidFrom: issuer.validFrom,
    ValidTo: issuer.validTo,
    SortOrder: issuer.sortOrder,
    IsActive: true,
  }));

  const issuerIdByKey = new Map<string, number>();
  const countryByKey = new Map<string, string>();
  seed.issuers.forEach((issuer, index) => {
    issuerIdByKey.set(issuer.key, ISSUER_ID_OFFSET + index + 1);
    countryByKey.set(issuer.key, issuer.isoCode ?? issuer.name);
  });

  const denominationRows = seed.denominations.map((denomination, index) => ({
    DenominationId: DENOMINATION_ID_OFFSET + index + 1,
    Label: denomination.label,
    Country: countryByKey.get(denomination.issuer) ?? denomination.issuer,
    IssuerId: issuerIdByKey.get(denomination.issuer) ?? null,
    FaceValue: denomination.faceValue,
    SortOrder: denomination.sortOrder,
    IsActive: true,
  }));

  const defaults: Record<string, ReadonlyArray<Record<string, SourceValue>>> = {
    Issuers: issuerRows,
    Denominations: denominationRows,
    Catalogs: CATALOG_SEED.map((name, index) => ({
      CatalogId: CATALOG_ID_OFFSET + index + 1,
      Name: name,
      SortOrder: index + 1,
      IsActive: true,
    })),
    Categories: CATEGORY_SEED.map((name) => ({ CategoryName: name })),
    MetalContents: METAL_CONTENT_SEED.map((name, index) => ({
      MetalContentId: index + 1,
      MetalContentName: name,
      SortOrder: index + 1,
      IsActive: true,
    })),
    MintMarks: MINT_MARK_SEED.map((mark, index) => ({
      MintMarkId: index + 1,
      Label: mark.label,
      Description: mark.description,
      IsActive: true,
    })),
    CoinSets: [{ SetName: 'Morgan Set' }],
    Coins: [
      {
        CoinId: COIN_ONE,
        Denomination: '$1',
        DenominationId: findDenomination(denominationRows, 'united-states', issuerIdByKey, '$1'),
        Year: '1878-S',
        CoinType: 'Morgan Dollar',
        Category: '20th Cent. Type',
        Country: 'US',
        Grade: 'MS63',
        CertCompany: 'PCGS',
        CertNumber: '12345678',
        MintMark: 'S',
        PurchaseDate: '2019-04-02',
        PurchasePrice: 412.35,
        CurrentValue: 575.0,
        HasCacSticker: true,
        Weight: 26.73,
        MetalContent: 'Silver',
        PmWeightGrams: 24.05582,
        PmPercent: 90.0,
        CoinSet: 'Morgan Set',
        CollectionStatus: 'owned',
        StorageLocation: 'Box 3',
        CatalogId: CATALOG_ID_OFFSET + 15,
        CatalogNumber: 'KM-110',
      },
      {
        CoinId: COIN_TWO,
        Denomination: 'Denarius',
        DenominationId: null,
        Year: '-27',
        CollectionStatus: 'owned',
        Weight: 3.87654,
        PmWeightGrams: 3.56942,
        PmPercent: 92.1,
        PurchasePrice: 1250.0,
        CurrentValue: null,
        SoldPrice: null,
        HasCacSticker: false,
        CatalogId: null,
      },
    ],
    CoinImages: [
      { ImageId: 1, CoinId: COIN_ONE, ImageData: 'data:image/jpeg;base64,AAAA', SortOrder: 0, SourcePath: 'C:\\photos\\1.jpg' },
      { ImageId: 2, CoinId: COIN_ONE, ImageData: 'data:image/jpeg;base64,BBBB', SortOrder: 1, SourcePath: null },
    ],
    SpotPrices: [
      {
        SpotPriceId: 1,
        Gold: 2345.67,
        Silver: 29.41,
        Platinum: 985.2,
        Copper: 4.1234,
        Source: 'manual',
        FetchedAt: new Date('2026-11-01T09:30:00.000Z'),
      },
    ],
    AppSettings: [
      { SettingKey: 'theme', SettingValue: 'dark' },
      {
        SettingKey: 'migration-008-weight-grams',
        SettingValue: '2025-06-01T12:00:00Z | converted | rows converted: 2 | factor: 31.1034768',
      },
    ],
  };

  const tables: Record<string, FixtureTable> = {};

  for (const table of ALL_TABLES) {
    if (overrides.withoutTables?.includes(table)) continue;
    const columns = overrides.columns?.[table] ?? sourceColumnsFor(table);
    const rows = overrides.rows?.[table] ?? defaults[table];
    tables[table] = fixtureTable(columns, rows);
  }

  return { ...tables, ...(overrides.extraTables ?? {}) };
}

/** A reader over those tables. */
export function buildFixtureReader(overrides: FixtureOverrides = {}): FixtureSourceReader {
  return new FixtureSourceReader(buildSourceTables(overrides));
}

/** The default rows for one table, so a spec can tweak instead of retype. */
export function defaultRows(
  table: string,
  overrides: FixtureOverrides = {}
): SourceRow[] {
  return [...(buildSourceTables(overrides)[table]?.rows ?? [])];
}

function findDenomination(
  rows: ReadonlyArray<Record<string, SourceValue>>,
  issuerKey: string,
  issuerIdByKey: ReadonlyMap<string, number>,
  label: string
): number | null {
  const issuerId = issuerIdByKey.get(issuerKey) ?? null;
  const found = rows.find((row) => row['IssuerId'] === issuerId && row['Label'] === label);
  return found ? Number(found['DenominationId']) : null;
}
