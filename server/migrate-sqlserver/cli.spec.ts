/**
 * The command line, which is the part the owner actually touches.
 *
 * The important tests here are not the happy paths: they are the ones that
 * prove a mistyped flag STOPS the tool. A migration that silently ignored
 * `--dryrun` and ran for real would be the worst bug this program could
 * have.
 */

import { describe, it, expect } from 'vitest';

import { formatSummary, main, parseArgs, USAGE } from './cli';
import { buildFixtureReader } from './fixture-collection';
import type { MigrationOutcome } from './migrate';

const EMPTY_ENV: NodeJS.ProcessEnv = {
  COIN_INVENTORY_DB_PATH: ':memory:',
};

describe('parseArgs', () => {
  it('falls back to the DB_* variables the owner already has in server/.env', () => {
    const options = parseArgs([], {
      ...EMPTY_ENV,
      DB_SERVER: 'localhost',
      DB_PORT: '1433',
      DB_NAME: 'CoinInventory',
      DB_USER: 'CoinApp',
      DB_PASSWORD: 'secret',
    });

    expect(options).toMatchObject({
      server: 'localhost',
      port: 1433,
      database: 'CoinInventory',
      user: 'CoinApp',
      password: 'secret',
    });
  });

  it('lets a flag override the environment', () => {
    const options = parseArgs(['--server', 'OTHERPC\\SQLEXPRESS', '--port', '1434'], {
      ...EMPTY_ENV,
      DB_SERVER: 'localhost',
    });
    expect(options.server).toBe('OTHERPC\\SQLEXPRESS');
    expect(options.port).toBe(1434);
  });

  it('defaults the target to the file the application itself uses', () => {
    expect(parseArgs([], EMPTY_ENV).target).toBe(':memory:');
    expect(parseArgs(['--target', 'C:\\tmp\\rehearsal.db'], EMPTY_ENV).target).toBe(
      'C:\\tmp\\rehearsal.db'
    );
  });

  it('defaults every safety flag to the safe answer', () => {
    expect(parseArgs([], EMPTY_ENV)).toMatchObject({
      force: false,
      dryRun: false,
      weightsAreGrams: false,
      allowExtraSourceColumns: false,
      encrypt: false,
    });
  });

  it('reads each safety flag', () => {
    expect(
      parseArgs(
        ['--force', '--dry-run', '--weights-are-grams', '--allow-extra-source-columns'],
        EMPTY_ENV
      )
    ).toMatchObject({
      force: true,
      dryRun: true,
      weightsAreGrams: true,
      allowExtraSourceColumns: true,
    });
  });

  it('REFUSES an argument it does not recognise', () => {
    // --dryrun is one letter from --dry-run and would otherwise be ignored.
    expect(() => parseArgs(['--dryrun'], EMPTY_ENV)).toThrow(/Unrecognised argument/);
    expect(() => parseArgs(['--dryrun'], EMPTY_ENV)).toThrow(/Nothing has been run/);
    expect(() => parseArgs(['-f'], EMPTY_ENV)).toThrow(/Unrecognised argument/);
    expect(() => parseArgs(['migrate'], EMPTY_ENV)).toThrow(/Unrecognised argument/);
  });

  it('REFUSES a valued flag with no value, including one swallowed by the next flag', () => {
    expect(() => parseArgs(['--password'], EMPTY_ENV)).toThrow(/needs a value/);
    expect(() => parseArgs(['--password', '--force'], EMPTY_ENV)).toThrow(/needs a value/);
  });

  it('REFUSES a port that is not a port', () => {
    expect(() => parseArgs(['--port', 'abc'], EMPTY_ENV)).toThrow(/whole number/);
  });

  it('documents every flag it accepts', () => {
    for (const flag of [
      '--server',
      '--port',
      '--database',
      '--user',
      '--password',
      '--target',
      '--force',
      '--dry-run',
      '--weights-are-grams',
      '--allow-extra-source-columns',
      '--encrypt',
      '--help',
    ]) {
      expect(USAGE, flag).toContain(flag);
    }
  });
});

describe('main', () => {
  it('prints the usage for --help and does nothing else', async () => {
    const lines: string[] = [];
    const code = await main(['--help'], (line) => lines.push(line), () => {
      throw new Error('should not have built a reader');
    });

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('one-time migration');
  });

  it('says what to do when there is no login, rather than failing to connect', async () => {
    const lines: string[] = [];
    const code = await main(['--target', ':memory:'], (line) => lines.push(line), () => {
      throw new Error('should not have built a reader');
    });

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('create-sql-login.sql');
    expect(lines.join('\n')).toContain('Nothing has been run');
  });

  it('stops on an unknown flag with a non-zero exit code', async () => {
    const lines: string[] = [];
    const code = await main(['--yolo'], (line) => lines.push(line));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Unrecognised argument');
  });

  it('runs end to end against a fixture source and exits 0', async () => {
    const lines: string[] = [];
    const reader = buildFixtureReader();

    const code = await main(
      ['--target', ':memory:', '--user', 'CoinApp', '--password', 'x'],
      (line) => lines.push(line),
      () => reader
    );

    const output = lines.join('\n');
    expect(code).toBe(0);
    expect(output).toContain('MIGRATION COMMITTED');
    expect(output).toContain('Value-by-value check');
    expect(reader.isClosed).toBe(true);
  });

  it('--dry-run exits 0 and says plainly that nothing was written', async () => {
    // The refusal to write into a target that is already in use is driven
    // end to end in migrate.spec.ts, where a file can be pre-populated;
    // ':memory:' is private per handle so it cannot be set up from here.
    const lines: string[] = [];
    const reader = buildFixtureReader();

    const code = await main(
      ['--target', ':memory:', '--user', 'u', '--password', 'p', '--dry-run'],
      (line) => lines.push(line),
      () => reader
    );

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Dry run complete. Nothing was written.');
    expect(lines.join('\n')).not.toContain('MIGRATION COMMITTED');
  });
});

describe('formatSummary', () => {
  const base: MigrationOutcome = {
    targetFile: 'C:\\data\\coin-inventory.db',
    sourceDescription: 'SQL Server localhost',
    intended: {},
    shape: {},
    problems: [],
    weightEvidence: {
      markerPresent: true,
      markerValue: 'x | factor: 31.1034768',
      backupTablePresent: false,
      backupRowsChecked: 0,
      backupRowsConsistent: 0,
      backupRowsInconsistent: 0,
    },
    cleared: null,
    reference: null,
    copied: [],
    verification: null,
    finalCounts: null,
    committed: true,
  };

  it('is honest that the weight UNIT was not verified', () => {
    const summary = formatSummary(base);
    expect(summary).toContain('NOT verified: that Coins.Weight is in GRAMS');
    expect(summary).toContain('0.7734');
    expect(summary).toContain('24.05582');
  });

  it('says what the marker does and does not prove', () => {
    const summary = formatSummary(base);
    expect(summary).toContain('same transaction as its conversion');
    expect(summary).toContain('evidence about an event rather than a measurement');
  });

  it('says whose claim it is when the marker was absent', () => {
    const summary = formatSummary({
      ...base,
      weightEvidence: { ...base.weightEvidence, markerPresent: false },
    });
    expect(summary).toContain('You asserted the weights are grams');
    expect(summary).toContain('this tool did not check it');
  });

  it('tells the operator to keep SQL Server until he has looked', () => {
    expect(formatSummary(base)).toContain('Keep the SQL Server database until you are satisfied');
  });

  it('says plainly when nothing was committed', () => {
    const summary = formatSummary({ ...base, committed: false });
    expect(summary).toContain('MIGRATION NOT COMMITTED');
    expect(summary).toContain('rolled back');
    expect(summary).toContain('never written to');
  });
});
