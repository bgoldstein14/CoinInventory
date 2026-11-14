/**
 * backup-runner.spec.ts — watching a job that takes minutes.
 *
 * No Angular, no DOM, no real waiting: the runner takes its `delay` as a
 * dependency precisely so these can run instantly and deterministically.
 * What is worth asserting is the three things a poller gets wrong, in the
 * order of how badly each one bites in a desktop app the user leaves open
 * all day:
 *
 *   1. it stops when the dialog closes
 *   2. it survives a dropped poll without declaring a false failure
 *   3. it never reports success it did not see
 */

import { describe, expect, it, vi } from 'vitest';

import { BackupJobStatus } from './backup-messages';
import {
  BackupRunner,
  MAX_CONSECUTIVE_POLL_FAILURES,
  messageFrom
} from './backup-runner';

function status(overrides: Partial<BackupJobStatus> = {}): BackupJobStatus {
  return {
    id: 'job-1',
    state: 'running',
    destination: 'C:\\Users\\You\\Desktop\\backup.db',
    percent: 0,
    totalPages: 10,
    copiedPages: 0,
    startedAt: '2026-11-14T10:00:00.000Z',
    finishedAt: null,
    result: null,
    error: null,
    ...overrides
  };
}

const done = status({
  state: 'done',
  percent: 100,
  finishedAt: '2026-11-14T10:00:05.000Z',
  result: {
    path: 'C:\\Users\\You\\Desktop\\backup.db',
    fileSizeBytes: 1_000_000,
    pagesCopied: 10,
    coinCount: 412,
    takenAt: '2026-11-14T10:00:05.000Z',
    schemaVersion: 1
  }
});

/** A runner with scripted poll answers and no real waiting. */
function makeRunner(polls: Array<BackupJobStatus | Error>, startWith?: Error) {
  let index = 0;
  const changes: number[] = [];

  const deps = {
    start: vi.fn(async () => {
      if (startWith) throw startWith;
      return status();
    }),
    poll: vi.fn(async () => {
      const next = polls[Math.min(index++, polls.length - 1)];
      if (next instanceof Error) throw next;
      return next!;
    }),
    cancel: vi.fn(async () => ({ accepted: true })),
    onChange: () => changes.push(1),
    delay: async () => {
      /* instant */
    }
  };

  return { runner: new BackupRunner(deps), deps, changes };
}

describe('BackupRunner — the happy path', () => {
  it('polls until the server says done, then exposes the file path', async () => {
    const { runner, deps } = makeRunner([
      status({ percent: 30, copiedPages: 3 }),
      status({ percent: 70, copiedPages: 7 }),
      done
    ]);

    await runner.run('C:\\Users\\You\\Desktop', 'backup.db');

    expect(deps.start).toHaveBeenCalledWith('C:\\Users\\You\\Desktop', 'backup.db');
    expect(deps.poll).toHaveBeenCalledTimes(3);
    expect(runner.status?.state).toBe('done');
    expect(runner.result?.path).toBe('C:\\Users\\You\\Desktop\\backup.db');
    expect(runner.percent).toBe(100);
    expect(runner.running).toBe(false);
    expect(runner.message).toContain('412 coins');
  });

  it('stops polling the moment the job is no longer running', async () => {
    const { runner, deps } = makeRunner([done, done, done]);
    await runner.run('C:\\dir', 'backup.db');
    expect(deps.poll).toHaveBeenCalledTimes(1);
  });

  it('tells the view about every change, so the bar actually moves', async () => {
    const { runner, changes } = makeRunner([
      status({ percent: 50 }),
      done
    ]);
    await runner.run('C:\\dir', 'backup.db');
    // start cleared + opening status + two polls + the final settle.
    expect(changes.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses to start a second backup over the top of a running one', async () => {
    const { runner, deps } = makeRunner([status(), status(), done]);
    const first = runner.run('C:\\dir', 'a.db');
    await runner.run('C:\\dir', 'b.db');
    await first;
    expect(deps.start).toHaveBeenCalledTimes(1);
  });
});

describe('BackupRunner — when the server refuses', () => {
  it('shows the server\'s own sentence rather than "request failed"', async () => {
    const { runner, deps } = makeRunner([], {
      ...new Error('Bad Request'),
      error: { error: 'There is no folder called D:\\Backpus on this computer.' }
    } as unknown as Error);

    await runner.run('D:\\Backpus', 'backup.db');

    expect(deps.poll).not.toHaveBeenCalled();
    expect(runner.error).toBe('There is no folder called D:\\Backpus on this computer.');
    expect(runner.running).toBe(false);
    // *** AND IT DOES NOT CLAIM A BACKUP EXISTS. ***
    expect(runner.result).toBeNull();
  });
});

describe('BackupRunner — a dropped poll is not a failed backup', () => {
  it('survives a hiccup in the middle of a long copy', async () => {
    // The backup is running on the SERVER. One dropped request says
    // nothing about whether the file is being written, and giving up on
    // watching would report a false failure for a file about to appear.
    const { runner } = makeRunner([
      status({ percent: 20 }),
      new Error('network'),
      status({ percent: 60 }),
      done
    ]);

    await runner.run('C:\\dir', 'backup.db');

    expect(runner.error).toBeNull();
    expect(runner.status?.state).toBe('done');
  });

  it('gives up after enough silence, and says it has lost SIGHT of it', async () => {
    const failures = Array.from(
      { length: MAX_CONSECUTIVE_POLL_FAILURES + 2 },
      () => new Error('ECONNREFUSED')
    );
    const { runner, deps } = makeRunner(failures);

    await runner.run('C:\\dir', 'backup.db');

    expect(deps.poll).toHaveBeenCalledTimes(MAX_CONSECUTIVE_POLL_FAILURES);
    // *** THE WORDING IS THE POINT. *** Telling the user the backup FAILED
    // when the file is about to appear makes them do it again — and a
    // second backup of a 600 MB database is not a free mistake.
    expect(runner.error).toMatch(/lost contact/i);
    expect(runner.error).toMatch(/may still be running/i);
    expect(runner.running).toBe(false);
  });
});

describe('BackupRunner — dispose', () => {
  it('stops polling when the dialog closes', async () => {
    // Without this a closed dialog leaves a timer firing an HTTP request
    // every 400 ms for the rest of the session.
    let polls = 0;
    const runner = new BackupRunner({
      start: async () => status(),
      poll: async () => {
        polls++;
        return status({ percent: polls * 5 });
      },
      cancel: async () => ({}),
      onChange: () => {},
      delay: async () => {}
    });

    const running = runner.run('C:\\dir', 'backup.db');
    // Two polls in, the user closes the dialog.
    await Promise.resolve();
    runner.dispose();
    await running;

    const seen = polls;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(polls).toBe(seen);
    expect(runner.running).toBe(false);
  });

  it('does NOT cancel the backup — closing a dialog is not abandoning it', async () => {
    const { runner, deps } = makeRunner([done]);
    await runner.run('C:\\dir', 'backup.db');
    runner.dispose();
    expect(deps.cancel).not.toHaveBeenCalled();
  });
});

describe('BackupRunner — cancelling', () => {
  it('asks the server, and waits for the server to say it stopped', async () => {
    const cancelled = status({ state: 'cancelled', finishedAt: '2026-11-14T10:00:02.000Z' });
    let polls = 0;

    const runner = new BackupRunner({
      start: async () => status(),
      poll: async () => (++polls >= 2 ? cancelled : status({ percent: 10 })),
      cancel: vi.fn(async () => ({ accepted: true })),
      onChange: () => {},
      delay: async () => {}
    });

    const running = runner.run('C:\\dir', 'backup.db');
    await Promise.resolve();
    await runner.requestCancel();
    await running;

    expect(runner.status?.state).toBe('cancelled');
    expect(runner.message).toMatch(/no file was left behind/i);
  });

  it('does nothing when there is no job to cancel', async () => {
    const { runner, deps } = makeRunner([done]);
    await runner.requestCancel();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it('swallows a failed cancel request rather than showing an error', async () => {
    // The job is still running and the next poll will say so, which is
    // more honest than an error about a button press.
    const runner = new BackupRunner({
      start: async () => status(),
      poll: async () => done,
      cancel: async () => {
        throw new Error('nope');
      },
      onChange: () => {},
      delay: async () => {}
    });

    const running = runner.run('C:\\dir', 'backup.db');
    await Promise.resolve();
    await expect(runner.requestCancel()).resolves.toBeUndefined();
    await running;
  });
});

describe('messageFrom', () => {
  it('prefers the server\'s sentence', () => {
    expect(messageFrom({ error: { error: 'That is not a backup.' } })).toBe(
      'That is not a backup.'
    );
  });

  it('falls back to an Error message', () => {
    expect(messageFrom(new Error('Http failure'))).toBe('Http failure');
  });

  it('never returns undefined or an empty string', () => {
    expect(messageFrom(null)).toBeTruthy();
    expect(messageFrom({})).toBeTruthy();
    expect(messageFrom({ error: '' })).toBeTruthy();
  });
});
