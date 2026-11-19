/**
 * The backup job registry, called directly rather than over HTTP: rules like
 * "a second backup is refused while one runs" would be timing races over
 * HTTP with a small test database.
 */

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cancelBackupJob,
  getBackupJob,
  isBackupRunning,
  resetBackupJobsForTesting,
  startBackupJob,
} from './jobs';
import { DB_PATH_ENV_VAR } from '../db/config';
import { BackupRequestError } from './run-backup';
import {
  insertCoins,
  releaseFileDatabase,
  useFileDatabase,
  type FileDatabase,
} from '../test-support/real-file-db';

let database: FileDatabase | null = null;

beforeEach(() => {
  resetBackupJobsForTesting();
});

afterEach(async () => {
  resetBackupJobsForTesting();
  if (database) await releaseFileDatabase(database);
  database = null;
});

/** Polls a job to a terminal state, the way the dialog does. */
async function settle(id: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = getBackupJob(id);
    if (!status) return 'forgotten';
    if (status.state !== 'running') return status.state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the job never finished');
}

describe('startBackupJob — one at a time', () => {
  it('refuses a second backup while one is in flight', async () => {
    database = await useFileDatabase('jobs-one-at-a-time');
    await insertCoins(20);

    // No await between the two, so the first is still running.
    const first = startBackupJob({ directory: database.backupDirectory });
    expect(() => startBackupJob({ directory: database!.backupDirectory })).toThrow(
      BackupRequestError
    );
    expect(() => startBackupJob({ directory: database!.backupDirectory })).toThrow(
      /already running/i
    );

    expect(await settle(first.id)).toBe('done');

    // ...and the slot is free again afterwards.
    expect(isBackupRunning()).toBe(false);
    const second = startBackupJob({ directory: database.backupDirectory });
    expect(await settle(second.id)).toBe('done');
  });

  it('does not claim the slot when it refuses the request', async () => {
    // A rejected request must not leave runningJobId set.
    database = await useFileDatabase('jobs-no-leak');

    expect(() =>
      startBackupJob({ directory: path.join(database!.directory, 'nowhere') })
    ).toThrow(BackupRequestError);

    expect(isBackupRunning()).toBe(false);
    const good = startBackupJob({ directory: database.backupDirectory });
    expect(await settle(good.id)).toBe('done');
  });
});

describe('startBackupJob — what the dialog sees', () => {
  it('knows the real destination from the first moment, including a " (2)"', async () => {
    database = await useFileDatabase('jobs-destination');
    await insertCoins(2);

    const when = new Date(2026, 10, 14, 11, 0, 0);
    const first = startBackupJob({ directory: database.backupDirectory, now: when });
    expect(path.basename(first.destination)).toBe('coin-inventory-backup-2026-11-14-1100.db');
    expect(await settle(first.id)).toBe('done');

    // Same minute: the name gets a suffix, visible in the status before the copy finishes.
    const second = startBackupJob({ directory: database.backupDirectory, now: when });
    expect(path.basename(second.destination)).toBe(
      'coin-inventory-backup-2026-11-14-1100 (2).db'
    );
    expect(await settle(second.id)).toBe('done');
  });

  it('ends at done, 100%, with the result attached', async () => {
    database = await useFileDatabase('jobs-done');
    await insertCoins(5);

    const started = startBackupJob({ directory: database.backupDirectory });
    expect(started.state).toBe('running');
    expect(started.percent).toBe(0);
    expect(started.result).toBeNull();

    expect(await settle(started.id)).toBe('done');

    const finished = getBackupJob(started.id)!;
    expect(finished.percent).toBe(100);
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.result?.coinCount).toBe(5);
    expect(fs.existsSync(finished.result!.path)).toBe(true);
  });

  it('reports a failure as failed, with a message, rather than running for ever', async () => {
    // Every path must reach a terminal state. The failure is staged by
    // pointing the data layer at a missing collection file after the
    // destination is accepted, so the copy itself fails.
    database = await useFileDatabase('jobs-failed');
    await insertCoins(2);

    process.env[DB_PATH_ENV_VAR] = path.join(database.directory, 'vanished.db');

    const started = startBackupJob({ directory: database.backupDirectory });
    expect(await settle(started.id)).toBe('failed');

    const failed = getBackupJob(started.id)!;
    expect(failed.error).toMatch(/could not be found/i);
    expect(failed.finishedAt).not.toBeNull();
    // The slot is free again after a failure.
    expect(isBackupRunning()).toBe(false);
  });
});

describe('cancelBackupJob', () => {
  it('accepts the request and the job reaches cancelled or done', async () => {
    database = await useFileDatabase('jobs-cancel');
    await insertCoins(100);

    const started = startBackupJob({ directory: database.backupDirectory, rate: 1 });
    expect(cancelBackupJob(started.id)).toBe(true);

    const state = await settle(started.id);
    expect(['cancelled', 'done']).toContain(state);

    if (state === 'cancelled') {
      // Nothing left behind, not even a sidecar.
      expect(fs.readdirSync(database.backupDirectory)).toEqual([]);
    }
  });

  it('is a no-op, not an error, for a job that has already finished', async () => {
    // Cancel pressed just as the copy completed.
    database = await useFileDatabase('jobs-cancel-late');
    await insertCoins(1);

    const started = startBackupJob({ directory: database.backupDirectory });
    expect(await settle(started.id)).toBe('done');

    expect(cancelBackupJob(started.id)).toBe(true);
    expect(getBackupJob(started.id)!.state).toBe('done');
  });

  it('returns false for an id it has never heard of', () => {
    expect(cancelBackupJob('not-a-job')).toBe(false);
  });
});
