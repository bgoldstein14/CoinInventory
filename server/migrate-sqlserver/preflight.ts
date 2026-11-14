/**
 * migrate-sqlserver/preflight.ts — PROVE THE SOURCE IS WHAT WE THINK IT IS,
 * BEFORE A SINGLE ROW IS WRITTEN.
 *
 * The owner says migrations 004-008 and 010-014 have all been run against
 * his live database, and there is no reason to doubt him. This file assumes
 * none of it. A half-migrated collection is far worse than a refused one,
 * and "he said so" is not a thing a verification can cite.
 *
 * Four questions, in the order they are asked:
 *
 *   1. DOES EVERY COLUMN WE INTEND TO READ EXIST? The list is not written
 *      down here — it is read out of the TARGET with `PRAGMA table_info`, so
 *      "what we intend to read" is by construction "what db/schema.sql has a
 *      place for". A missing column names the migration that supplies it and
 *      stops the run.
 *
 *   2. IS THERE A COLUMN WE ARE NOT READING? Surplus is not harmless. A
 *      source still carrying `Coins.Dealer` or a `CoinTags` table is a
 *      source where migration 005/006 did not run, and copying it would
 *      leave data behind with nothing said. Fatal by default.
 *
 *   3. ARE THE WEIGHT COLUMNS THE RIGHT PRECISION? `Weight` and
 *      `PmWeightGrams` are DECIMAL(12,5) only because
 *      `004-widen-weight-precision.sql` made them so. INFORMATION_SCHEMA
 *      answers this one exactly, which makes 004 the one numeric migration
 *      that does not have to be taken on trust.
 *
 *   4. ARE THE WEIGHTS IN GRAMS? — see `checkWeightUnit()` below, and read
 *      its comment before believing the answer.
 */

import {
  column,
  type SourceColumn,
  type SourceReader,
  type SourceRow,
} from './source-reader';
import { ALL_TABLES, type TableName } from './tables';

/** One thing preflight found. `fatal` stops the run. */
export interface PreflightProblem {
  readonly severity: 'fatal' | 'warning';
  readonly message: string;
  /**
   * Set on the problems `--allow-extra-source-columns` is allowed to
   * downgrade, and on nothing else.
   *
   * A field rather than a substring of the message, because the alternative
   * — deciding whether a refusal can be overridden by grepping its own
   * wording — would turn a change of wording into a change of behaviour.
   */
  readonly tag?: 'extra-source-column';
}

/** The source's shape, as INFORMATION_SCHEMA describes it. */
export type SourceShape = Record<string, SourceColumn[]>;

/**
 * Which migration adds which column. Anything not listed was in
 * `setup-database.sql` from the beginning, so its absence means the source
 * is not this application's database at all.
 */
export const MIGRATION_FOR_COLUMN: Record<string, string> = {
  'CoinImages.SourcePath': '002-add-image-source-path.sql',
  'CoinImages.ImageId': '003-multiple-images-per-coin.sql',
  'CoinImages.SortOrder': '003-multiple-images-per-coin.sql',
  'Coins.CollectionStatus': '010-add-collection-status-and-storage-location.sql',
  'Coins.StorageLocation': '010-add-collection-status-and-storage-location.sql',
  'Coins.DenominationId': '011-add-issuers-and-denomination-links.sql',
  'Denominations.IssuerId': '011-add-issuers-and-denomination-links.sql',
  'Denominations.FaceValue': '011-add-issuers-and-denomination-links.sql',
  'Coins.CatalogId': '012-add-catalog-references.sql',
  'Coins.CatalogNumber': '012-add-catalog-references.sql',
};

/** Which migration creates which whole table. */
export const MIGRATION_FOR_TABLE: Record<string, string> = {
  CoinImages: '003-multiple-images-per-coin.sql',
  Issuers: '011-add-issuers-and-denomination-links.sql',
  Catalogs: '012-add-catalog-references.sql',
};

/**
 * Columns and tables a migration REMOVED. Finding one means that migration
 * did not run, and that the migration would have moved or discarded data we
 * are about to walk past.
 */
export const MIGRATION_FOR_REMOVED: Record<string, string> = {
  CoinTags: '005-drop-coin-tags.sql',
  'Coins.Dealer': '006-drop-coin-dealer.sql',
};

/**
 * Tables that may legitimately exist in the source and are not migrated.
 *
 * Both are backups this project's own migrations took before changing data
 * in place. They hold PRIOR values, not current ones, so leaving them behind
 * loses nothing — and neither has any place in the SQLite schema.
 *
 * `Coins_Weight_TroyOz_Backup` is migration 008's safety net. Its presence is
 * good news: it is what lets `checkWeightUnit()` say anything about the data
 * rather than only about a marker.
 *
 * `Coins_MetalData_Backup` is migration 007's, taken before it inferred metal
 * and composition (007 line 1655, `INTO Coins_MetalData_Backup`). It was
 * missing from this list, so a real migration run refused with a message
 * saying "Nothing in this project created it" — which was false, and sent the
 * owner looking for a table that was never a mystery. A surplus table is
 * refused precisely because it usually means a migration did NOT run; a
 * backup one of those migrations took is the opposite signal.
 */
export const EXPECTED_EXTRA_TABLES: readonly string[] = [
  'Coins_Weight_TroyOz_Backup',
  'Coins_MetalData_Backup',
];

/** Migration 008's marker key, written in the same transaction as its UPDATE. */
export const WEIGHT_MARKER_KEY = 'migration-008-weight-grams';

/** Migration 008's backup of the pre-conversion column. */
export const WEIGHT_BACKUP_TABLE = 'Coins_Weight_TroyOz_Backup';

/** Grams per troy ounce, exactly as migration 008 used it. */
export const GRAMS_PER_TROY_OUNCE = 31.1034768;

/** Reads every table's columns once, so nothing asks twice. */
export async function readSourceShape(
  reader: SourceReader,
  tables: readonly string[] = ALL_TABLES
): Promise<SourceShape> {
  const shape: SourceShape = {};
  for (const table of tables) {
    shape[table] = await reader.columns(table);
  }
  return shape;
}

/** The columns the migration intends to read, as the TARGET defines them. */
export type IntendedColumns = Record<string, readonly string[]>;

/**
 * Question 1 and question 2.
 *
 * Comparison is case-insensitive because SQL Server's default collation on
 * this database is, and a column the owner's SSMS session created as
 * `storagelocation` is the same column.
 */
export function compareColumns(
  intended: IntendedColumns,
  shape: SourceShape
): PreflightProblem[] {
  const problems: PreflightProblem[] = [];

  for (const table of Object.keys(intended)) {
    const sourceColumns = shape[table] ?? [];

    if (sourceColumns.length === 0) {
      const migration = MIGRATION_FOR_TABLE[table];
      problems.push({
        severity: 'fatal',
        message:
          `Source table ${table} does not exist.` +
          (migration
            ? ` It is created by server/migrations/${migration}. Run that against ` +
              `the SQL Server database and try again.`
            : ` That table has been in setup-database.sql from the beginning, so ` +
              `this does not look like the Coin Inventory database.`),
      });
      continue;
    }

    const sourceNames = new Set(sourceColumns.map((item) => item.name.toLowerCase()));
    const intendedNames = new Set(intended[table].map((name) => name.toLowerCase()));

    for (const wanted of intended[table]) {
      if (sourceNames.has(wanted.toLowerCase())) continue;
      const migration = MIGRATION_FOR_COLUMN[`${table}.${wanted}`];
      problems.push({
        severity: 'fatal',
        message:
          `Source column ${table}.${wanted} is missing.` +
          (migration
            ? ` It is added by server/migrations/${migration}. Run that against the ` +
              `SQL Server database and try again -- nothing has been written.`
            : ` That column has been in setup-database.sql from the beginning.`),
      });
    }

    for (const found of sourceColumns) {
      if (intendedNames.has(found.name.toLowerCase())) continue;
      const migration = MIGRATION_FOR_REMOVED[`${table}.${found.name}`];
      problems.push({
        severity: 'fatal',
        tag: 'extra-source-column',
        message:
          `Source column ${table}.${found.name} exists but SQLite has nowhere to ` +
          `put it, so migrating would silently leave it behind.` +
          (migration
            ? ` It is removed by server/migrations/${migration}, which has not run.`
            : ` Nothing in this project created it.`) +
          ` Re-run with --allow-extra-source-columns to copy everything else and ` +
          `abandon this column deliberately.`,
      });
    }
  }

  return problems;
}

/** Tables in the source that the migration does not know about. */
export function findExtraTables(
  sourceTables: readonly string[],
  known: readonly string[] = ALL_TABLES
): PreflightProblem[] {
  const expected = new Set(
    [...known, ...EXPECTED_EXTRA_TABLES].map((name) => name.toLowerCase())
  );

  return sourceTables
    .filter((name) => !expected.has(name.toLowerCase()))
    .map((name) => {
      const migration = MIGRATION_FOR_REMOVED[name];
      return {
        severity: 'fatal' as const,
        tag: 'extra-source-column' as const,
        message:
          `Source table ${name} is not part of the SQLite schema, so its contents ` +
          `would be left behind.` +
          (migration
            ? ` It is dropped by server/migrations/${migration}, which has not run.`
            : ` Nothing in this project created it -- if something else made it ` +
              `(SSMS creates sysdiagrams, for instance) and it holds none of your ` +
              `data, abandoning it is the right answer.`) +
          ` Re-run with --allow-extra-source-columns to abandon it deliberately.`,
      };
    });
}

/** The declared scale each DECIMAL column must have, and who made it so. */
export const REQUIRED_DECIMALS: ReadonlyArray<{
  table: TableName;
  column: string;
  precision: number;
  scale: number;
  migration: string | null;
}> = [
  { table: 'Coins', column: 'Weight', precision: 12, scale: 5, migration: '004-widen-weight-precision.sql' },
  { table: 'Coins', column: 'PmWeightGrams', precision: 12, scale: 5, migration: '004-widen-weight-precision.sql' },
  { table: 'Coins', column: 'PmPercent', precision: 5, scale: 2, migration: null },
  { table: 'Coins', column: 'PurchasePrice', precision: 12, scale: 2, migration: null },
  { table: 'Coins', column: 'CurrentValue', precision: 12, scale: 2, migration: null },
  { table: 'Coins', column: 'SoldPrice', precision: 12, scale: 2, migration: null },
  { table: 'Denominations', column: 'FaceValue', precision: 18, scale: 6, migration: '011-add-issuers-and-denomination-links.sql' },
];

/**
 * Question 3. The ONE numeric migration that can be checked rather than
 * trusted: a `Weight` still at the pre-004 precision is visible in
 * INFORMATION_SCHEMA, and would quietly round every weight on the way out.
 */
export function checkDecimalPrecision(shape: SourceShape): PreflightProblem[] {
  const problems: PreflightProblem[] = [];

  for (const required of REQUIRED_DECIMALS) {
    const found = (shape[required.table] ?? []).find(
      (item) => item.name.toLowerCase() === required.column.toLowerCase()
    );
    // A missing column is already reported by compareColumns().
    if (!found) continue;

    if (found.precision === required.precision && found.scale === required.scale) continue;

    problems.push({
      severity: 'fatal',
      message:
        `Source column ${required.table}.${required.column} is ` +
        `${found.dataType.toUpperCase()}(${found.precision},${found.scale}), not ` +
        `DECIMAL(${required.precision},${required.scale}).` +
        (required.migration
          ? ` server/migrations/${required.migration} is what widens it; it has not run.`
          : ` That is its shape in setup-database.sql, so something has altered it.`) +
        ` Migrating now would copy values that the source has already rounded.`,
    });
  }

  return problems;
}

/** What could be established about the unit `Coins.Weight` is stored in. */
export interface WeightUnitEvidence {
  /** Migration 008's AppSettings marker. */
  readonly markerPresent: boolean;
  readonly markerValue: string | null;
  /** Its backup of the pre-conversion column. */
  readonly backupTablePresent: boolean;
  /** Rows compared against the backup (non-null, non-zero prior weights). */
  readonly backupRowsChecked: number;
  /** Of those, how many are the prior value x 31.1034768, to 5 decimals. */
  readonly backupRowsConsistent: number;
  readonly backupRowsInconsistent: number;
}

/**
 * Question 4, and *** READ THIS BEFORE QUOTING THE ANSWER. ***
 *
 * Design §4.1 says a wrong weight unit cannot be detected, because 0.7734
 * and 24.05582 are both plausible coin weights. That is true of the DATA and
 * it remains true. It is not the whole story, and the spec was written
 * before anyone looked at what migration 008 leaves behind:
 *
 *   THE MARKER. 008 writes `AppSettings['migration-008-weight-grams']` in
 *   the SAME TRANSACTION as its UPDATE (008's step 5 says so explicitly, and
 *   that is why it is re-runnable). So the marker being present is real
 *   evidence that the multiply committed.
 *
 *   THE BACKUP. 008 also does `SELECT CoinId, Weight INTO
 *   Coins_Weight_TroyOz_Backup FROM Coins` before converting. If the owner
 *   has not dropped it — 008 tells him he may — then every row can be
 *   checked arithmetically: `Weight` should be the backed-up value times
 *   31.1034768, rounded to 5 decimals. That is a DATA-level check of the
 *   unit, which §4.1 assumed impossible.
 *
 * WHAT THIS STILL CANNOT PROVE, AND THE TOOL SAYS SO IN ITS REPORT:
 *
 *   - A marker can be deleted by hand. 008's own header tells the reader how
 *     and warns that doing so without restoring the values is catastrophic.
 *   - A weight edited in the UI since the migration will differ from
 *     backup x 31.1034768 and is NOT an error. So an inconsistent row is a
 *     prompt to look, not a failure.
 *   - If the backup has been dropped, the marker is all there is, and the
 *     marker is a claim about an event rather than a measurement of the
 *     column.
 *
 * Nothing here is reported as "008 verified". It is reported as what it is.
 */
export async function checkWeightUnit(
  reader: SourceReader,
  sourceTables: readonly string[],
  weightsByCoinId: ReadonlyMap<string, number | null>
): Promise<WeightUnitEvidence> {
  // An object rather than two `let`s: these are assigned inside a callback,
  // and a mutated property is never narrowed away by control-flow analysis.
  const marker: { present: boolean; value: string | null } = { present: false, value: null };

  await reader.forEachRow(
    { table: 'AppSettings', select: [column('SettingKey'), column('SettingValue')] },
    (row: SourceRow) => {
      if (String(row['SettingKey']).toLowerCase() !== WEIGHT_MARKER_KEY) return;
      marker.present = true;
      marker.value = row['SettingValue'] === null ? null : String(row['SettingValue']);
    }
  );

  const backupTablePresent = sourceTables.some(
    (name) => name.toLowerCase() === WEIGHT_BACKUP_TABLE.toLowerCase()
  );

  let backupRowsChecked = 0;
  let backupRowsConsistent = 0;

  if (backupTablePresent) {
    await reader.forEachRow(
      { table: WEIGHT_BACKUP_TABLE, select: [column('CoinId'), column('Weight')] },
      (row: SourceRow) => {
        const priorWeight = row['Weight'];
        if (typeof priorWeight !== 'number' || priorWeight === 0) return;

        const coinId = String(row['CoinId']).toLowerCase();
        const current = weightsByCoinId.get(coinId);
        // A coin deleted since the migration has a backup row and no coin.
        if (current === undefined || current === null) return;

        backupRowsChecked += 1;
        if (roundTo(priorWeight * GRAMS_PER_TROY_OUNCE, 5) === roundTo(current, 5)) {
          backupRowsConsistent += 1;
        }
      }
    );
  }

  return {
    markerPresent: marker.present,
    markerValue: marker.value,
    backupTablePresent,
    backupRowsChecked,
    backupRowsConsistent,
    backupRowsInconsistent: backupRowsChecked - backupRowsConsistent,
  };
}

/**
 * The same rounding SQL Server applies on assignment to a DECIMAL(12,5).
 * Used only for the corroborating comparison above; nothing in the copy path
 * rounds anything.
 */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Turns the weight evidence into the problem list, honestly. */
export function weightUnitProblems(
  evidence: WeightUnitEvidence,
  ownerAssertsGrams: boolean
): PreflightProblem[] {
  const problems: PreflightProblem[] = [];

  if (!evidence.markerPresent) {
    problems.push({
      severity: ownerAssertsGrams ? 'warning' : 'fatal',
      message:
        `AppSettings has no '${WEIGHT_MARKER_KEY}' row, so there is no evidence ` +
        `that server/migrations/008-weight-to-grams.sql ever ran. If it did not, ` +
        `every Coins.Weight is in TROY OUNCES while the whole application labels ` +
        `it grams, and no row count or spot check will ever show it -- 0.7734 and ` +
        `24.05582 are both believable coin weights.` +
        (ownerAssertsGrams
          ? ` Proceeding anyway because --weights-are-grams was given. That is ` +
            `your assertion, not a check this tool performed.`
          : ` Run migration 008, or -- if you are certain the weights are already ` +
            `grams and the marker was removed -- re-run with --weights-are-grams.`),
    });
  }

  if (evidence.markerPresent && !evidence.backupTablePresent) {
    problems.push({
      severity: 'warning',
      message:
        `Migration 008's marker is present, so its UPDATE committed (the marker ` +
        `is written in the same transaction). ${WEIGHT_BACKUP_TABLE} has been ` +
        `dropped, so the weights themselves could not be checked arithmetically -- ` +
        `the marker is evidence about an event, not a measurement of the column.`,
    });
  }

  if (evidence.backupTablePresent && evidence.backupRowsInconsistent > 0) {
    problems.push({
      severity: 'warning',
      message:
        `${evidence.backupRowsInconsistent} of ${evidence.backupRowsChecked} ` +
        `weight(s) are not their ${WEIGHT_BACKUP_TABLE} value x ` +
        `${GRAMS_PER_TROY_OUNCE}. That is expected for any coin whose weight you ` +
        `have edited since the migration, and is not by itself an error -- but if ` +
        `the number is large, stop and look before continuing.`,
    });
  }

  return problems;
}
