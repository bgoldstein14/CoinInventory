/**
 * migrate-sqlserver/verify.ts — VERIFICATION THAT COULD ACTUALLY FAIL.
 *
 * Design §4.1 is explicit that a row count and a spot check are not enough,
 * and says why: "a wrong weight is indistinguishable from a right one". So
 * this file does three things, and none of them is a glance.
 *
 *   1. ROW COUNTS, PER TABLE, SOURCE AGAINST TARGET — for the owner tables.
 *      Reference tables are NOT counted against each other and that is not
 *      laziness: db/seed.ts rebuilds them from a JSON file that has grown
 *      since migration 013 generated the SQL Server seed, so the counts are
 *      SUPPOSED to differ. They get a containment check instead: every
 *      reference row in the source must be findable in the target by
 *      identity. That is the property that actually matters.
 *
 *   2. VALUE BY VALUE ON EVERY NUMBER. `Weight`, `PmWeightGrams`,
 *      `PmPercent`, `PurchasePrice`, `CurrentValue`, `SoldPrice` — the six
 *      §4.1 names — plus the four `SpotPrices` columns, which are the same
 *      kind of value and cost one more pass.
 *
 *      *** THE COMPARISON IS `===` AND MUST STAY `===`. *** db/schema.sql's
 *      numeric-storage note explains the whole reason REAL was chosen over
 *      scaled integers or text: `tedious` hands a DECIMAL to JavaScript as a
 *      binary64, and SQLite's REAL stores a binary64 bit for bit, so the
 *      round trip is exact. If a future reader finds themselves reaching for
 *      an epsilon, something upstream has started rounding and the answer is
 *      to find out what, not to widen the tolerance.
 *
 *      *** AND IT IS AN INDEPENDENT SECOND READ OF THE SOURCE. *** The copy
 *      could have remembered what it read and compared against its own
 *      notes; that would prove the writer agreed with itself. Reading the
 *      source again shares no code with the copy path, so a bug in the copy
 *      path cannot make the verification agree with it.
 *
 *   3. THE RE-RESOLVED LINKS. `Coins.DenominationId` and `Coins.CatalogId`
 *      are different integers on the two sides by design, so comparing them
 *      would be meaningless. What is compared is what they MEAN: the
 *      (issuer name, label) the source coin pointed at, against the
 *      (issuer name, label) the target coin points at.
 *
 * *** ZERO DIFFERENCES IS PROVED, NOT ASSUMED. *** Every function here
 * reports how many values it compared, and `assertCoverage()` fails when
 * that number is lower than the number of rows said there should be. A
 * verification that silently compared nothing is the failure mode that looks
 * exactly like success, and it is the one this guards against.
 */

import type { SqliteDatabase } from '../db/driver';
import { column, type SourceReader, type SourceRow } from './source-reader';
import { MigrationRefusedError } from './reference-data';
import {
  COINS_NUMERIC_COLUMNS,
  OTHER_NUMERIC_COLUMNS,
  OWNER_TABLES,
  REFERENCE_TABLES,
  type TableName,
} from './tables';
import { identityKey } from './values';
import { denominationKey } from './reference-data';

/** One table's counts. */
export interface CountCheck {
  readonly table: TableName;
  readonly source: number;
  readonly target: number;
  readonly matches: boolean;
}

/** One value that did not survive the move. */
export interface ValueDifference {
  readonly table: string;
  readonly key: string;
  readonly column: string;
  readonly source: unknown;
  readonly target: unknown;
}

/** The result of the value-by-value pass. */
export interface ValueCheck {
  readonly rowsChecked: number;
  readonly valuesChecked: number;
  readonly differences: ValueDifference[];
}

/** The result of the link check. */
export interface LinkCheck {
  readonly coinsChecked: number;
  readonly denominationLinksChecked: number;
  readonly catalogLinksChecked: number;
  readonly differences: ValueDifference[];
}

/** Reference rows in the source that are not in the target. */
export interface ContainmentCheck {
  readonly table: TableName;
  readonly sourceRows: number;
  readonly targetRows: number;
  readonly missingFromTarget: string[];
}

/** Everything the verification established. */
export interface VerificationReport {
  readonly counts: CountCheck[];
  readonly containment: ContainmentCheck[];
  readonly values: ValueCheck;
  readonly links: LinkCheck;
  readonly ok: boolean;
}

/** True when both sides hold the same value. Nulls match nulls, and that
 *  is the only special case: numbers are compared with `===`. */
export function sameValue(source: unknown, target: unknown): boolean {
  if (source === null && target === null) return true;
  if (source === null || target === null) return false;
  return source === target;
}

/** COUNT(*) on the target, without importing the whole target module. */
function targetCount(database: SqliteDatabase, table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0]?.['n'] ?? 0);
}

/** Step 1a — the owner tables, which must match exactly. */
export async function checkRowCounts(
  reader: SourceReader,
  database: SqliteDatabase
): Promise<CountCheck[]> {
  const checks: CountCheck[] = [];

  for (const table of OWNER_TABLES) {
    const source = await reader.count(table);
    const target = targetCount(database, table);
    checks.push({ table, source, target, matches: source === target });
  }

  return checks;
}

/** The identity column of each single-key reference table. */
const REFERENCE_IDENTITY: Record<string, string> = {
  Issuers: 'Name',
  Catalogs: 'Name',
  Categories: 'CategoryName',
  MetalContents: 'MetalContentName',
  MintMarks: 'Label',
};

/**
 * Step 1b — reference containment.
 *
 * Counts are expected to differ (the target's seed is newer). What must NOT
 * differ is that every row the owner had is still reachable.
 */
export async function checkReferenceContainment(
  reader: SourceReader,
  database: SqliteDatabase
): Promise<ContainmentCheck[]> {
  const checks: ContainmentCheck[] = [];

  for (const table of REFERENCE_TABLES) {
    if (table === 'Denominations') {
      checks.push(await checkDenominationContainment(reader, database));
      continue;
    }

    const identity = REFERENCE_IDENTITY[table];
    const present = new Set(
      database
        .prepare(`SELECT ${identity} AS k FROM ${table}`)
        .all()
        .map((row) => identityKey(String(row['k'])))
    );

    const missing: string[] = [];
    let sourceRows = 0;

    await reader.forEachRow({ table, select: [column(identity)] }, (row: SourceRow) => {
      sourceRows += 1;
      const value = String(row[identity]);
      if (!present.has(identityKey(value))) missing.push(value);
    });

    checks.push({
      table,
      sourceRows,
      targetRows: present.size,
      missingFromTarget: missing,
    });
  }

  return checks;
}

async function checkDenominationContainment(
  reader: SourceReader,
  database: SqliteDatabase
): Promise<ContainmentCheck> {
  const present = new Set(
    database
      .prepare(
        'SELECT d.Label AS label, i.Name AS issuerName FROM Denominations d ' +
          'LEFT JOIN Issuers i ON i.IssuerId = d.IssuerId'
      )
      .all()
      .map((row) =>
        denominationKey(
          row['issuerName'] === null ? null : String(row['issuerName']),
          String(row['label'])
        )
      )
  );

  const issuerNameById = new Map<number, string>();
  await reader.forEachRow(
    { table: 'Issuers', select: [column('IssuerId'), column('Name')] },
    (row) => {
      issuerNameById.set(Number(row['IssuerId']), String(row['Name']));
    }
  );

  const missing: string[] = [];
  let sourceRows = 0;

  await reader.forEachRow(
    { table: 'Denominations', select: [column('Label'), column('IssuerId')] },
    (row) => {
      sourceRows += 1;
      const issuerId = row['IssuerId'];
      const issuerName = issuerId === null ? null : (issuerNameById.get(Number(issuerId)) ?? null);
      const label = String(row['Label']);
      if (!present.has(denominationKey(issuerName, label))) {
        missing.push(`${label} (${issuerName ?? 'no issuer'})`);
      }
    }
  );

  return {
    table: 'Denominations',
    sourceRows,
    targetRows: present.size,
    missingFromTarget: missing,
  };
}

/** Step 2 — the value-by-value pass, from a fresh read of the source. */
export async function checkNumericValues(
  reader: SourceReader,
  database: SqliteDatabase
): Promise<ValueCheck> {
  const differences: ValueDifference[] = [];
  let rowsChecked = 0;
  let valuesChecked = 0;

  // ----- Coins, the six columns §4.1 names -------------------------------
  const targetCoins = new Map<string, Record<string, unknown>>();
  for (const row of database
    .prepare(`SELECT CoinId, ${COINS_NUMERIC_COLUMNS.join(', ')} FROM Coins`)
    .all()) {
    targetCoins.set(String(row['CoinId']), row);
  }

  await reader.forEachRow(
    {
      table: 'Coins',
      select: [column('CoinId'), ...COINS_NUMERIC_COLUMNS.map((name) => column(name))],
    },
    (row: SourceRow) => {
      // The source id may be a UNIQUEIDENTIFIER rendered in any case; the
      // copy normalised it to lower case (see source-reader.ts), so the
      // lookup does the same rather than assuming a casing.
      const key = String(row['CoinId']).toLowerCase();
      const target = targetCoins.get(key) ?? targetCoins.get(String(row['CoinId']));

      if (!target) {
        differences.push({
          table: 'Coins',
          key,
          column: '(row)',
          source: 'present',
          target: 'missing',
        });
        return;
      }

      rowsChecked += 1;
      for (const name of COINS_NUMERIC_COLUMNS) {
        valuesChecked += 1;
        if (sameValue(row[name], target[name])) continue;
        differences.push({
          table: 'Coins',
          key,
          column: name,
          source: row[name],
          target: target[name],
        });
      }
    }
  );

  // ----- The four SpotPrices columns -------------------------------------
  for (const spec of OTHER_NUMERIC_COLUMNS) {
    const keyColumn = spec.key[0];
    const targetRows = new Map<string, Record<string, unknown>>();
    for (const row of database
      .prepare(`SELECT ${keyColumn}, ${spec.columns.join(', ')} FROM ${spec.table}`)
      .all()) {
      targetRows.set(String(row[keyColumn]).toLowerCase(), row);
    }

    await reader.forEachRow(
      {
        table: spec.table,
        select: [column(keyColumn), ...spec.columns.map((name) => column(name))],
      },
      (row: SourceRow) => {
        const key = String(row[keyColumn]).toLowerCase();
        const target = targetRows.get(key);

        if (!target) {
          differences.push({
            table: spec.table,
            key,
            column: '(row)',
            source: 'present',
            target: 'missing',
          });
          return;
        }

        rowsChecked += 1;
        for (const name of spec.columns) {
          valuesChecked += 1;
          if (sameValue(row[name], target[name])) continue;
          differences.push({
            table: spec.table,
            key,
            column: name,
            source: row[name],
            target: target[name],
          });
        }
      }
    );
  }

  return { rowsChecked, valuesChecked, differences };
}

/** Step 3 — the links mean the same thing on both sides. */
export async function checkCoinLinks(
  reader: SourceReader,
  database: SqliteDatabase,
  sourceDenominationKeyById: ReadonlyMap<number, string>,
  sourceCatalogNameById: ReadonlyMap<number, string>
): Promise<LinkCheck> {
  const differences: ValueDifference[] = [];

  const targetByCoin = new Map<string, { denomination: string | null; catalog: string | null }>();
  for (const row of database
    .prepare(
      'SELECT c.CoinId AS coinId, d.Label AS label, i.Name AS issuerName, ' +
        'cat.Name AS catalogName ' +
        'FROM Coins c ' +
        'LEFT JOIN Denominations d ON d.DenominationId = c.DenominationId ' +
        'LEFT JOIN Issuers i ON i.IssuerId = d.IssuerId ' +
        'LEFT JOIN Catalogs cat ON cat.CatalogId = c.CatalogId'
    )
    .all()) {
    targetByCoin.set(String(row['coinId']), {
      denomination:
        row['label'] === null
          ? null
          : denominationKey(
              row['issuerName'] === null ? null : String(row['issuerName']),
              String(row['label'])
            ),
      catalog: row['catalogName'] === null ? null : identityKey(String(row['catalogName'])),
    });
  }

  let coinsChecked = 0;
  let denominationLinksChecked = 0;
  let catalogLinksChecked = 0;

  await reader.forEachRow(
    {
      table: 'Coins',
      select: [column('CoinId'), column('DenominationId'), column('CatalogId')],
    },
    (row: SourceRow) => {
      const key = String(row['CoinId']).toLowerCase();
      const target = targetByCoin.get(key) ?? targetByCoin.get(String(row['CoinId']));
      if (!target) {
        differences.push({
          table: 'Coins',
          key,
          column: '(row)',
          source: 'present',
          target: 'missing',
        });
        return;
      }

      coinsChecked += 1;

      const sourceDenomination =
        row['DenominationId'] === null
          ? null
          : (sourceDenominationKeyById.get(Number(row['DenominationId'])) ?? '(unknown)');
      denominationLinksChecked += 1;
      if (sourceDenomination !== target.denomination) {
        differences.push({
          table: 'Coins',
          key,
          column: 'DenominationId',
          source: sourceDenomination,
          target: target.denomination,
        });
      }

      const sourceCatalogName = row['CatalogId'] === null
        ? null
        : (sourceCatalogNameById.get(Number(row['CatalogId'])) ?? '(unknown)');
      const sourceCatalog = sourceCatalogName === null ? null : identityKey(sourceCatalogName);
      catalogLinksChecked += 1;
      if (sourceCatalog !== target.catalog) {
        differences.push({
          table: 'Coins',
          key,
          column: 'CatalogId',
          source: sourceCatalog,
          target: target.catalog,
        });
      }
    }
  );

  return { coinsChecked, denominationLinksChecked, catalogLinksChecked, differences };
}

/**
 * *** THE CHECK ON THE CHECKS. ***
 *
 * A verification that compared nothing reports zero differences, which reads
 * exactly like a clean run. So the coverage is asserted against the row
 * counts the source itself reported: if there are 105 coins there must be
 * 105 x 6 = 630 numeric comparisons and 105 coins' worth of links, and
 * anything less is a broken verification rather than a clean migration.
 */
export function assertCoverage(
  counts: readonly CountCheck[],
  values: ValueCheck,
  links: LinkCheck
): void {
  const sourceRowsOf = (table: TableName): number =>
    counts.find((check) => check.table === table)?.source ?? 0;

  const expectedRows =
    sourceRowsOf('Coins') + sourceRowsOf('SpotPrices');

  const expectedValues =
    sourceRowsOf('Coins') * COINS_NUMERIC_COLUMNS.length +
    OTHER_NUMERIC_COLUMNS.reduce(
      (total, spec) => total + sourceRowsOf(spec.table) * spec.columns.length,
      0
    );

  if (values.rowsChecked !== expectedRows || values.valuesChecked !== expectedValues) {
    throw new MigrationRefusedError(
      `THE VERIFICATION DID NOT COVER THE DATA.\n\n` +
        `  Expected ${expectedValues} value comparison(s) across ${expectedRows} row(s); ` +
        `it made ${values.valuesChecked} across ${values.rowsChecked}.\n\n` +
        `  Zero differences from a check that did not run is not a clean migration, ` +
        `it is no migration check at all. The database has NOT been committed.`
    );
  }

  if (links.coinsChecked !== sourceRowsOf('Coins')) {
    throw new MigrationRefusedError(
      `THE LINK CHECK DID NOT COVER THE DATA.\n\n` +
        `  Expected ${sourceRowsOf('Coins')} coin(s); it checked ${links.coinsChecked}. ` +
        `The database has NOT been committed.`
    );
  }
}

/** Runs everything and says whether the migration may be committed. */
export async function verifyMigration(
  reader: SourceReader,
  database: SqliteDatabase,
  sourceDenominationKeyById: ReadonlyMap<number, string>,
  sourceCatalogNameById: ReadonlyMap<number, string>
): Promise<VerificationReport> {
  const counts = await checkRowCounts(reader, database);
  const containment = await checkReferenceContainment(reader, database);
  const values = await checkNumericValues(reader, database);
  const links = await checkCoinLinks(
    reader,
    database,
    sourceDenominationKeyById,
    sourceCatalogNameById
  );

  assertCoverage(counts, values, links);

  const ok =
    counts.every((check) => check.matches) &&
    containment.every((check) => check.missingFromTarget.length === 0) &&
    values.differences.length === 0 &&
    links.differences.length === 0;

  return { counts, containment, values, links, ok };
}
