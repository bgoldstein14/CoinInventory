/**
 * migrate-sqlserver/copy-rows.ts — the six tables that are copied row for
 * row, and the two columns that are not copied but re-resolved.
 *
 * MEMORY IS THE DESIGN CONSTRAINT HERE AND IT IS WHY THIS LOOKS THE WAY IT
 * DOES. `CoinImages` holds about 2,140 photographs as base64 text in
 * NVARCHAR(MAX) — several hundred megabytes, possibly a gigabyte. So:
 *
 *   - rows arrive ONE AT A TIME through `SourceReader.forEachRow`, and this
 *     file never puts them in an array;
 *   - each row is bound and inserted inside the callback, synchronously,
 *     which is also what applies backpressure to the SQL Server stream
 *     (node:sqlite has no async API, so the reader cannot run ahead);
 *   - peak memory is therefore ONE photograph, not all of them.
 *
 * *** base64 IS COPIED AS base64. *** Converting `ImageData` to a BLOB is
 * §4.9 and belongs to Stage 3, which the plan sequences after this one on
 * purpose: §4.10b points out that doing the image work first turns a 50 MB
 * migration into a 5 GB one. Nothing here decodes, re-encodes or inspects an
 * image.
 *
 * *** THE IDS THAT TRAVEL AND THE IDS THAT DO NOT. ***
 *
 *   CoinId, ImageId, SpotPriceId  — PRESERVED. They identify
 *   the owner's own rows, nothing re-seeds them, and keeping them means a
 *   CSV he exported last year still names the same coin. SQLite accepts an
 *   explicit value for an INTEGER PRIMARY KEY AUTOINCREMENT column and
 *   advances `sqlite_sequence` past it, so the next new photograph still
 *   gets an unused id.
 *
 *   DenominationId, CatalogId — RE-RESOLVED through the maps built by
 *   reference-data.ts. db/seed.ts's header is explicit: the reference tables
 *   are regenerated, so the integers mean different rows on the two sides.
 *   Carrying one across would attach his Morgan dollars to whatever happens
 *   to occupy that id here, and nothing afterwards would look wrong.
 */

import type { SqliteBindValue, SqliteDatabase } from '../db/driver';
import { MigrationRefusedError } from './reference-data';
import {
  idSelectItem,
  type SelectItem,
  type SourceColumn,
  type SourceReader,
  type SourceRow,
} from './source-reader';
import type { SourceShape } from './preflight';
import type { IntendedColumns } from './preflight';
import { OWNER_TABLES, type TableName } from './tables';
import { toBindValue } from './values';

/** How many rows between progress lines on the big table. */
export const PROGRESS_EVERY = 100;

/** The id maps reference-data.ts produced. */
export interface IdMaps {
  readonly denominationIdMap: ReadonlyMap<number, number>;
  readonly catalogIdMap: ReadonlyMap<number, number>;
}

/** What one table's copy did. */
export interface CopyOutcome {
  readonly table: TableName;
  readonly rows: number;
  /** Characters of `ImageData` seen. Only meaningful for CoinImages. */
  readonly imageCharacters: number;
  /** Non-null reference links re-resolved by identity rather than copied. */
  readonly linksResolved: number;
}

/** A deterministic read order per table, so two runs produce the same file. */
const ORDER_BY: Partial<Record<TableName, readonly string[]>> = {
  Coins: ['CoinId'],
  CoinImages: ['CoinId', 'SortOrder'],
  SpotPrices: ['SpotPriceId'],
  CoinSets: ['SetName'],
  AppSettings: ['SettingKey'],
};

/** Columns whose integer value is a link into a re-seeded reference table. */
const REMAPPED_COLUMNS: Partial<Record<TableName, Record<string, 'denomination' | 'catalog'>>> =
  {
    Coins: { DenominationId: 'denomination', CatalogId: 'catalog' },
  };

/**
 * Builds the SELECT list, asking the source's own type for each id column.
 *
 * See `idSelectItem()` in source-reader.ts for why a UNIQUEIDENTIFIER is
 * read as lower-cased text rather than left to the driver: the driver's
 * casing is arbitrary, SQLite's id columns are BINARY-collated, and a coin
 * stored as 'A1B2…' is not found by a request for 'a1b2…'.
 */
export function selectItemsFor(
  columns: readonly string[],
  sourceColumns: readonly SourceColumn[]
): SelectItem[] {
  const byName = new Map(sourceColumns.map((item) => [item.name.toLowerCase(), item]));

  return columns.map((name) => {
    const info = byName.get(name.toLowerCase());
    if (!info) {
      throw new MigrationRefusedError(
        `Source column for ${name} disappeared between preflight and the copy.`
      );
    }
    return idSelectItem({ ...info, name });
  });
}

/** Copies one table, streaming. Returns what it did. */
export async function copyTable(
  reader: SourceReader,
  database: SqliteDatabase,
  table: TableName,
  columns: readonly string[],
  sourceColumns: readonly SourceColumn[],
  maps: IdMaps,
  onProgress: (message: string) => void
): Promise<CopyOutcome> {
  const insert = database.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) ` +
      `VALUES (${columns.map(() => '?').join(', ')})`
  );

  const remapped = REMAPPED_COLUMNS[table] ?? {};
  const counters = { rows: 0, imageCharacters: 0, linksResolved: 0 };

  await reader.forEachRow(
    {
      table,
      select: selectItemsFor(columns, sourceColumns),
      orderBy: ORDER_BY[table],
    },
    (row: SourceRow) => {
      const values: SqliteBindValue[] = columns.map((name) => {
        const kind = remapped[name];
        if (kind) {
          const link = remapLink(table, name, kind, row[name], maps);
          if (link !== null) counters.linksResolved += 1;
          return link;
        }

        const value = toBindValue(row[name]);
        if (name === 'ImageData' && typeof value === 'string') {
          counters.imageCharacters += value.length;
        }
        return value;
      });

      insert.run(...values);
      counters.rows += 1;

      if (counters.rows % PROGRESS_EVERY === 0) {
        onProgress(`    ${table}: ${counters.rows} row(s) copied`);
      }
    }
  );

  return {
    table,
    rows: counters.rows,
    imageCharacters: counters.imageCharacters,
    linksResolved: counters.linksResolved,
  };
}

/** Turns a source reference id into the target's id for the same row. */
function remapLink(
  table: TableName,
  columnName: string,
  kind: 'denomination' | 'catalog',
  raw: unknown,
  maps: IdMaps
): SqliteBindValue {
  if (raw === null || raw === undefined) return null;

  const sourceId = Number(raw);
  const map = kind === 'denomination' ? maps.denominationIdMap : maps.catalogIdMap;
  const targetId = map.get(sourceId);

  if (targetId === undefined) {
    throw new MigrationRefusedError(
      `${table}.${columnName} points at ${kind} id ${sourceId}, which has no ` +
        `counterpart in the migrated reference data.\n\n` +
        `  Reference ids are NOT carried across -- db/seed.ts rebuilds those tables, ` +
        `so the integers mean different rows on the two sides and the link has to ` +
        `be re-resolved by name. A source id with no match means the row it pointed ` +
        `at is missing from the source's own reference table.\n\n` +
        `  Nothing has been committed. Check ${kind === 'denomination' ? 'Denominations' : 'Catalogs'} ` +
        `in SQL Server for the missing row.`
    );
  }

  return targetId;
}

/** Copies every owner table, in parent-before-child order. */
export async function copyOwnerTables(
  reader: SourceReader,
  database: SqliteDatabase,
  shape: SourceShape,
  intended: IntendedColumns,
  maps: IdMaps,
  onProgress: (message: string) => void
): Promise<CopyOutcome[]> {
  const outcomes: CopyOutcome[] = [];

  for (const table of OWNER_TABLES) {
    const columns = intended[table];
    if (!columns || columns.length === 0) {
      throw new MigrationRefusedError(`The target has no columns for ${table}.`);
    }
    onProgress(`  ${table}...`);
    outcomes.push(
      await copyTable(
        reader,
        database,
        table,
        columns,
        shape[table] ?? [],
        maps,
        onProgress
      )
    );
  }

  return outcomes;
}
