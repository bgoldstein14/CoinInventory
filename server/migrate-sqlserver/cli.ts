/**
 * migrate-sqlserver/cli.ts — the thing the owner actually types, once.
 *
 *     cd server
 *     npm run migrate:from-sqlserver -- --dry-run      <- look first
 *     npm run migrate:from-sqlserver                   <- then do it
 *
 * It is a SCRIPT, not a feature. Nothing in the application imports it, it
 * is excluded from `tsconfig.build.json` so it never reaches `dist/`, and it
 * is deleted along with `mssql`, `msnodesqlv8`, `setup-database.sql` and
 * `create-sql-login.sql` once the owner confirms his collection has moved.
 *
 * WRITTEN FOR SOMEBODY WHO IS NERVOUS. He runs this once, against data he
 * cannot regenerate, and the three things he needs are: to be told what is
 * about to happen before it happens, to see that it is still going, and —
 * if it stops — to be told what to do next rather than what went wrong
 * internally. Every refusal in this tool therefore ends with an instruction.
 */

import path from 'path';

import { config as loadEnv } from 'dotenv';

import { buildDbConfig, IN_MEMORY_DATABASE } from '../db/config';
import { MssqlSourceReader } from './mssql-source-reader';
import {
  runMigration,
  type MigrationOptions,
  type MigrationOutcome,
} from './migrate';
import { MigrationRefusedError } from './reference-data';
import type { SourceReader } from './source-reader';
import { openTarget, TargetNotEmptyError } from './target';
import { WEIGHT_MARKER_KEY } from './preflight';

/** Everything the command line can say. */
export interface CliOptions extends MigrationOptions {
  readonly server: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly encrypt: boolean;
  readonly target: string;
  readonly help: boolean;
}

export const USAGE = `
Coin Inventory -- one-time migration from SQL Server to SQLite

  cd server
  npm run migrate:from-sqlserver -- [options]

Connection (each falls back to the matching variable in server/.env):
  --server <host>        DB_SERVER    (default localhost)
  --port <number>        DB_PORT      (default 1433)
  --database <name>      DB_NAME      (default CoinInventory)
  --user <name>          DB_USER
  --password <secret>    DB_PASSWORD
  --encrypt              use TLS to the instance (off by default; a local
                         SQL Server Express normally has no certificate)

Destination:
  --target <path>        the SQLite file to write. Defaults to the file the
                         application itself uses.

Safety:
  --dry-run              check everything and write nothing. Run this first.
  --force                the target already holds rows: DELETE them and
                         migrate. This never merges.
  --weights-are-grams    proceed although AppSettings has no
                         '${WEIGHT_MARKER_KEY}' row. Read what the tool
                         says about migration 008 before using this.
  --allow-extra-source-columns
                         the source has columns or tables SQLite has no place
                         for: copy everything else and abandon them.

  --help                 this text.

The source is never written to. The migration runs inside ONE transaction
and the value-by-value verification happens BEFORE the commit, so a run that
finds any difference leaves your SQLite file exactly as it was.
`.trimStart();

/** Flags that take a value. */
const VALUED = new Set([
  '--server',
  '--port',
  '--database',
  '--user',
  '--password',
  '--target',
]);

/** Flags that do not. */
const BOOLEAN = new Set([
  '--force',
  '--dry-run',
  '--weights-are-grams',
  '--allow-extra-source-columns',
  '--encrypt',
  '--help',
]);

/**
 * Turns argv into options.
 *
 * An unrecognised argument is a hard error rather than something ignored.
 * A migration that quietly ignored `--dryrun` and ran for real would be the
 * single worst bug this tool could have.
 */
export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): CliOptions {
  const given = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (BOOLEAN.has(argument)) {
      flags.add(argument);
      continue;
    }
    if (VALUED.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new MigrationRefusedError(
          `${argument} needs a value.\n\n${USAGE}`
        );
      }
      given.set(argument, value);
      index += 1;
      continue;
    }

    throw new MigrationRefusedError(
      `Unrecognised argument ${JSON.stringify(argument)}. Nothing has been run.\n\n${USAGE}`
    );
  }

  const port = Number(given.get('--port') ?? env['DB_PORT'] ?? 1433);
  if (!Number.isInteger(port) || port <= 0) {
    throw new MigrationRefusedError(`--port must be a whole number, not ${port}.`);
  }

  return {
    server: given.get('--server') ?? env['DB_SERVER'] ?? 'localhost',
    port,
    database: given.get('--database') ?? env['DB_NAME'] ?? 'CoinInventory',
    user: given.get('--user') ?? env['DB_USER'] ?? '',
    password: given.get('--password') ?? env['DB_PASSWORD'] ?? '',
    encrypt: flags.has('--encrypt'),
    target: given.get('--target') ?? buildDbConfig().file,
    force: flags.has('--force'),
    dryRun: flags.has('--dry-run'),
    weightsAreGrams: flags.has('--weights-are-grams'),
    allowExtraSourceColumns: flags.has('--allow-extra-source-columns'),
    help: flags.has('--help'),
  };
}

/** The summary the owner reads when it worked. */
export function formatSummary(outcome: MigrationOutcome): string {
  const lines: string[] = [];

  lines.push('='.repeat(72));
  lines.push(outcome.committed ? 'MIGRATION COMMITTED' : 'MIGRATION NOT COMMITTED');
  lines.push('='.repeat(72));
  lines.push('');

  const verification = outcome.verification;
  if (verification) {
    lines.push('Row counts, source against target:');
    for (const check of verification.counts) {
      lines.push(
        `    ${check.table.padEnd(14)} source ${String(check.source).padStart(6)}   ` +
          `target ${String(check.target).padStart(6)}   ${check.matches ? 'match' : '*** DIFFERENT ***'}`
      );
    }
    lines.push('');

    lines.push('Reference data (counts differ by design -- the seed is regenerated');
    lines.push('and has grown since migration 013; what matters is that nothing of');
    lines.push('yours is missing):');
    for (const check of verification.containment) {
      lines.push(
        `    ${check.table.padEnd(14)} source ${String(check.sourceRows).padStart(6)}   ` +
          `target ${String(check.targetRows).padStart(6)}   ` +
          (check.missingFromTarget.length === 0
            ? 'all present'
            : `*** ${check.missingFromTarget.length} MISSING: ${check.missingFromTarget.slice(0, 5).join(', ')} ***`)
      );
    }
    lines.push('');

    lines.push(
      `Value-by-value check: ${verification.values.valuesChecked} value(s) across ` +
        `${verification.values.rowsChecked} row(s) compared with ===, ` +
        `${verification.values.differences.length} difference(s).`
    );
    lines.push(
      `Link check: ${verification.links.coinsChecked} coin(s); ` +
        `${verification.links.denominationLinksChecked} denomination link(s) and ` +
        `${verification.links.catalogLinksChecked} catalogue link(s) compared by ` +
        `what they mean, ${verification.links.differences.length} difference(s).`
    );
    lines.push('');

    const allDifferences = [...verification.values.differences, ...verification.links.differences];
    if (allDifferences.length > 0) {
      lines.push('DIFFERENCES (first 20):');
      for (const difference of allDifferences.slice(0, 20)) {
        lines.push(
          `    ${difference.table}.${difference.column} for ${difference.key}: ` +
            `source ${JSON.stringify(difference.source)} vs target ${JSON.stringify(difference.target)}`
        );
      }
      lines.push('');
    }
  }

  lines.push('WHAT THIS VERIFIED, AND WHAT IT DID NOT:');
  lines.push('');
  lines.push('  Verified: every owner table has the same number of rows on both');
  lines.push('  sides; every one of your reference rows is present; every weight,');
  lines.push('  precious-metal figure, percentage, price and spot price is');
  lines.push('  byte-for-byte the same number (an exact ===, not a');
  lines.push('  tolerance); and every coin still points at the denomination and');
  lines.push('  catalogue it pointed at, matched by name rather than by id.');
  lines.push('');
  lines.push('  NOT verified: that Coins.Weight is in GRAMS.');
  lines.push('');

  const evidence = outcome.weightEvidence;
  if (evidence.markerPresent) {
    lines.push(
      `  What is known: AppSettings carries '${WEIGHT_MARKER_KEY}', which`
    );
    lines.push('  migration 008 writes in the same transaction as its conversion, so');
    lines.push('  the conversion committed. That marker can be deleted by hand, so it');
    lines.push('  is evidence about an event rather than a measurement of the column.');
  } else {
    lines.push(`  What is known: AppSettings has no '${WEIGHT_MARKER_KEY}' row.`);
    lines.push('  You asserted the weights are grams with --weights-are-grams. That is');
    lines.push('  your assertion and this tool did not check it.');
  }

  if (evidence.backupTablePresent) {
    lines.push('');
    lines.push(
      `  Corroboration: ${evidence.backupRowsConsistent} of ${evidence.backupRowsChecked} ` +
        `weight(s) are exactly their`
    );
    lines.push(
      '  Coins_Weight_TroyOz_Backup value x 31.1034768. A row that is not is'
    );
    lines.push('  expected if you have edited that coin since, and is not an error.');
  } else {
    lines.push('');
    lines.push('  Coins_Weight_TroyOz_Backup is not in the source, so the weights could');
    lines.push('  not be checked arithmetically.');
  }

  lines.push('');
  lines.push('  No comparison of the data can settle this on its own: 0.7734 and');
  lines.push('  24.05582 are both believable coin weights, which is exactly what');
  lines.push('  design section 4.1 warns about. If you are unsure, open one coin you');
  lines.push('  know the weight of and look at it before deleting anything.');
  lines.push('');

  if (outcome.committed) {
    lines.push('WHAT TO DO NEXT:');
    lines.push('');
    lines.push(`  1. Start the application and look at your collection in ${outcome.targetFile}.`);
    lines.push('  2. Check a coin you know well: its weight, its price, its photographs,');
    lines.push('     its denomination and its certification number.');
    lines.push('  3. Keep the SQL Server database until you are satisfied. Nothing in');
    lines.push('     this run changed it.');
    lines.push('  4. Only then remove mssql, msnodesqlv8, setup-database.sql,');
    lines.push('     create-sql-login.sql and this folder.');
  } else {
    lines.push('WHAT TO DO NEXT:');
    lines.push('');
    lines.push('  The transaction was rolled back. Your SQLite file is exactly as it');
    lines.push('  was and your SQL Server database was never written to.');
    lines.push('  Look at the differences above, fix the cause, and run it again.');
  }

  return lines.join('\n');
}

/** The body of the command, with the reader injectable so specs can drive it. */
export async function main(
  argv: readonly string[],
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  makeReader: (options: CliOptions) => SourceReader = defaultReader
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (options.help) {
    log(USAGE);
    return 0;
  }

  if (!options.user || !options.password) {
    log(
      'No SQL Server user or password.\n\n' +
        '  Pass --user and --password, or put DB_USER and DB_PASSWORD in\n' +
        '  server/.env. The login is the one server/create-sql-login.sql\n' +
        '  created (CoinApp by default). Windows authentication is not\n' +
        '  supported here: it needs msnodesqlv8, which this machine cannot\n' +
        '  build.\n\n' +
        '  Nothing has been run.'
    );
    return 1;
  }

  const reader = makeReader(options);
  // ':memory:' is a literal, not a path. path.resolve() would turn it into
  // a file name and SQLite would refuse to open it — which is how a
  // rehearsal run against a throwaway database stops being possible.
  const opened = openTarget(
    options.target === IN_MEMORY_DATABASE ? IN_MEMORY_DATABASE : path.resolve(options.target)
  );

  try {
    await reader.open();
  } catch (err) {
    log(
      `Could not connect to ${options.server}:${options.port}/${options.database} ` +
        `as ${options.user}.\n\n  ${err instanceof Error ? err.message : String(err)}\n\n` +
        '  Check that the SQL Server service is running, that TCP/IP is enabled\n' +
        '  for the instance, and that the user and password are right. Nothing\n' +
        '  has been written.'
    );
    opened.database.close();
    return 1;
  }

  try {
    const outcome = await runMigration(reader, opened, options, log);
    log('');
    if (!options.dryRun) log(formatSummary(outcome));
    else log('Dry run complete. Nothing was written. Re-run without --dry-run to migrate.');
    return outcome.committed || options.dryRun ? 0 : 1;
  } catch (err) {
    log('');
    if (err instanceof TargetNotEmptyError || err instanceof MigrationRefusedError) {
      log(err.message);
      return 1;
    }
    log('The migration stopped on an unexpected error and committed nothing:');
    log(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  } finally {
    await reader.close();
    opened.database.close();
  }
}

function defaultReader(options: CliOptions): SourceReader {
  return new MssqlSourceReader({
    server: options.server,
    port: options.port,
    database: options.database,
    user: options.user,
    password: options.password,
    encrypt: options.encrypt,
    connectionTimeoutMs: 15_000,
  });
}

/* istanbul ignore next — the entry point, exercised by running the script. */
if (require.main === module) {
  // server/.env is where the owner's DB_SERVER / DB_USER / DB_PASSWORD still
  // are. .env.example says the application no longer reads them, and that
  // stays true: this script is not the application, and it is the last thing
  // that will ever want them.
  loadEnv({ path: path.join(__dirname, '..', '.env') });

  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
