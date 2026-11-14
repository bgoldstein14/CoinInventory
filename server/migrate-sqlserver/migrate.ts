/**
 * migrate-sqlserver/migrate.ts — the order the steps happen in, and the one
 * transaction they all happen inside.
 *
 * *** THE SHAPE THAT MAKES THIS SAFE: VERIFY BEFORE COMMIT. ***
 *
 *     BEGIN IMMEDIATE
 *       clear the target        (only with --force)
 *       reconcile reference data
 *       copy the owner's rows
 *       VERIFY, value by value
 *     COMMIT   <- only if the verification passed
 *     ROLLBACK <- on anything at all
 *
 * The verification reads the target through the same connection, so it sees
 * the uncommitted rows. That means a run which finds even one differing
 * weight writes NOTHING: the owner is left with the file he had, and a
 * message. There is no state in which his collection is half moved.
 *
 * The cost is that the whole migration — including several hundred megabytes
 * of base64 photographs — is one SQLite transaction, so the `-wal` file grows
 * to roughly the size of the data before the commit checkpoints it. That is
 * a disk-space cost on a one-time script, paid once, in exchange for
 * atomicity. It is the right trade and it is written down here so the next
 * reader does not "optimise" it into per-table commits.
 *
 * Everything before BEGIN is read-only on both sides: the occupancy check,
 * the source shape, the column comparison, the decimal precision check and
 * the weight-unit evidence. A refusal at that stage has touched nothing.
 */

import type { SqliteDatabase } from '../db/driver';
import { readSeedFile } from '../db/seed';
import { copyOwnerTables, type CopyOutcome, type IdMaps } from './copy-rows';
import {
  checkDecimalPrecision,
  checkWeightUnit,
  compareColumns,
  findExtraTables,
  readSourceShape,
  weightUnitProblems,
  type IntendedColumns,
  type PreflightProblem,
  type SourceShape,
  type WeightUnitEvidence,
} from './preflight';
import { MigrationRefusedError, migrateReferenceData, type ReferenceResult } from './reference-data';
import { column, type SourceReader } from './source-reader';
import { ALL_TABLES } from './tables';
import {
  clearOwnerData,
  inspectOccupancy,
  targetColumns,
  targetCounts,
  TargetNotEmptyError,
  type OpenedTarget,
} from './target';
import { verifyMigration, type VerificationReport } from './verify';

/** What the operator asked for. */
export interface MigrationOptions {
  /** Delete whatever is in the target first. Never merges. */
  readonly force: boolean;
  /** Check everything, write nothing, do not even open a transaction. */
  readonly dryRun: boolean;
  /** Proceed although migration 008's marker is absent. The owner's word. */
  readonly weightsAreGrams: boolean;
  /** Copy everything else although the source has columns SQLite cannot hold. */
  readonly allowExtraSourceColumns: boolean;
}

/** Everything that happened, for the summary the operator reads. */
export interface MigrationOutcome {
  readonly targetFile: string;
  readonly sourceDescription: string;
  readonly intended: IntendedColumns;
  readonly shape: SourceShape;
  readonly problems: PreflightProblem[];
  readonly weightEvidence: WeightUnitEvidence;
  readonly cleared: Record<string, number> | null;
  readonly reference: ReferenceResult | null;
  readonly copied: CopyOutcome[];
  readonly verification: VerificationReport | null;
  readonly finalCounts: Record<string, number> | null;
  readonly committed: boolean;
}

/** Where progress goes. The CLI passes `console.log`; specs pass a sink. */
export type Log = (line: string) => void;

/**
 * The columns the migration intends to read: whatever the TARGET has a place
 * for. Deriving it from the destination rather than from a hand-written list
 * means the list cannot drift away from db/schema.sql.
 */
export function intendedColumns(database: SqliteDatabase): IntendedColumns {
  const intended: IntendedColumns = {};
  for (const table of ALL_TABLES) intended[table] = targetColumns(database, table);
  return intended;
}

/** Reads the weights the source currently holds, keyed by coin. */
async function sourceWeights(reader: SourceReader): Promise<Map<string, number | null>> {
  const weights = new Map<string, number | null>();
  await reader.forEachRow(
    { table: 'Coins', select: [column('CoinId'), column('Weight')] },
    (row) => {
      const value = row['Weight'];
      weights.set(
        String(row['CoinId']).toLowerCase(),
        typeof value === 'number' ? value : null
      );
    }
  );
  return weights;
}

/**
 * Runs the whole thing. Throws `MigrationRefusedError` or
 * `TargetNotEmptyError` for anything the operator has to decide about; any
 * other throw is a bug and is allowed to escape with its stack.
 */
export async function runMigration(
  reader: SourceReader,
  opened: OpenedTarget,
  options: MigrationOptions,
  log: Log
): Promise<MigrationOutcome> {
  const database = opened.database;

  log(`Source : ${reader.description}`);
  log(`Target : ${opened.file}${opened.created ? '   (created by this run)' : ''}`);
  log('');
  log(
    'The source is opened with read-only intent and every statement this tool ' +
      'sends is checked to be a SELECT before it leaves. That is a guarantee ' +
      'about this program, not about the login -- for a guarantee from the server, ' +
      'run ALTER DATABASE CoinInventory SET READ_ONLY yourself first.'
  );
  log('');

  // ----- 1. is the target already in use? --------------------------------
  const occupancy = inspectOccupancy(database);
  if (occupancy.occupied && !options.force) {
    throw new TargetNotEmptyError(opened.file, occupancy);
  }
  if (occupancy.occupied) {
    log('--force was given. These rows will be DELETED before the migration:');
    for (const entry of occupancy.occupiedTables) {
      log(`    ${entry.table.padEnd(14)} ${entry.rows} row(s)`);
    }
    log('');
  }

  // ----- 2. verify the source's shape, writing nothing -------------------
  log('Checking the source...');
  const intended = intendedColumns(database);
  const shape = await readSourceShape(reader);
  const sourceTables = await reader.tables();

  const problems: PreflightProblem[] = [
    ...compareColumns(intended, shape),
    ...findExtraTables(sourceTables),
    ...checkDecimalPrecision(shape),
  ];

  const weightEvidence = await checkWeightUnit(
    reader,
    sourceTables,
    await sourceWeights(reader)
  );
  problems.push(...weightUnitProblems(weightEvidence, options.weightsAreGrams));

  // Only the problems preflight TAGGED as overridable are downgraded. A
  // missing column is never one of them: --allow-extra-source-columns says
  // "abandon something the destination has no room for", not "carry on
  // regardless".
  const effective = options.allowExtraSourceColumns
    ? problems.map((problem) =>
        problem.tag === 'extra-source-column'
          ? {
              severity: 'warning' as const,
              tag: problem.tag,
              message: `${problem.message} (allowed by --allow-extra-source-columns)`,
            }
          : problem
      )
    : problems;

  for (const problem of effective) {
    log(`  ${problem.severity === 'fatal' ? 'REFUSED' : 'warning'}: ${problem.message}`);
  }

  const fatal = effective.filter((problem) => problem.severity === 'fatal');
  if (fatal.length > 0) {
    throw new MigrationRefusedError(
      `The source is not in the shape this migration needs (${fatal.length} ` +
        `problem${fatal.length === 1 ? '' : 's'} above).\n\n` +
        `  NOTHING HAS BEEN WRITTEN, and nothing has been changed in SQL Server.\n` +
        `  Fix the problems named above and run the same command again.`
    );
  }

  log('  source shape accepted.');
  log('');

  /*
   * Say what is actually there, BEFORE the dry run stops.
   *
   * Without this the rehearsal validated the schema and said nothing about
   * the data, so the operator's only way to learn whether the tool had found
   * 105 coins or 3 was to run the real thing. "How much is about to move" is
   * the main question a dry run exists to answer.
   *
   * These are COUNT(*) reads on a connection already restricted to SELECT.
   */
  const sourceCounts: Array<{ table: string; rows: number }> = [];
  for (const table of ALL_TABLES) {
    sourceCounts.push({ table, rows: await reader.count(table) });
  }

  log('The source holds:');
  const width = Math.max(...sourceCounts.map((entry) => entry.table.length));
  for (const { table, rows } of sourceCounts) {
    log(`    ${table.padEnd(width)}  ${rows.toLocaleString()} row(s)`);
  }
  log('');

  const base: MigrationOutcome = {
    targetFile: opened.file,
    sourceDescription: reader.description,
    intended,
    shape,
    problems: effective,
    weightEvidence,
    cleared: null,
    reference: null,
    copied: [],
    verification: null,
    finalCounts: null,
    committed: false,
  };

  if (options.dryRun) {
    log('--dry-run: stopping here. Nothing has been written.');
    return base;
  }

  // ----- 3. one transaction: clear, copy, verify, commit -----------------
  database.exec('BEGIN IMMEDIATE');
  try {
    const cleared = options.force && occupancy.occupied ? clearOwnerData(database) : null;
    if (cleared) {
      log('Cleared the existing rows.');
      log('');
    }

    log('Reference data (seeded rows are regenerated, not copied)...');
    const reference = await migrateReferenceData(reader, database, readSeedFile());
    for (const outcome of reference.outcomes) {
      log(
        `  ${outcome.table.padEnd(14)} ${String(outcome.sourceRows).padStart(5)} in source: ` +
          `${outcome.seededUnchanged} seeded and unchanged, ` +
          `${outcome.seededEdited} seeded with your edits, ` +
          `${outcome.ownAdded} of your own added, ` +
          `${outcome.ownUpdated} of your own already present`
      );
    }
    log('');

    const maps: IdMaps = {
      denominationIdMap: reference.denominationIdMap,
      catalogIdMap: reference.catalogIdMap,
    };

    log('Your coins, photographs and transactions...');
    const copied = await copyOwnerTables(reader, database, shape, intended, maps, log);
    for (const outcome of copied) {
      const images =
        outcome.imageCharacters > 0
          ? ` (${Math.round(outcome.imageCharacters / 1_000_000)} MB of base64)`
          : '';
      log(`  ${outcome.table.padEnd(14)} ${outcome.rows} row(s)${images}`);
    }
    log('');

    log('Verifying, value by value, from a fresh read of the source...');
    const verification = await verifyMigration(
      reader,
      database,
      reference.sourceDenominationKeyById,
      reference.sourceCatalogNameById
    );

    if (!verification.ok) {
      database.exec('ROLLBACK');
      return { ...base, cleared, reference, copied, verification, committed: false };
    }

    const finalCounts = targetCounts(database);
    database.exec('COMMIT');

    return {
      ...base,
      cleared,
      reference,
      copied,
      verification,
      finalCounts,
      committed: true,
    };
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Already rolled back, or the handle is gone. The original error is
      // the one worth reporting.
    }
    throw err;
  }
}
