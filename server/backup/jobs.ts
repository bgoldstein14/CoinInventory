/**
 * backup/jobs.ts — THE REASON A MULTI-GIGABYTE BACKUP IS NOT A FROZEN
 * WINDOW.
 *
 * *** WHY THIS IS A JOB AND NOT JUST A POST THAT RETURNS WHEN IT IS DONE. ***
 * The owner's database is about 600 MB today, with the originals embedded
 * as base64, and design §4.9a makes multiple gigabytes the ordinary case
 * rather than the pathological one. A single request that copies that and
 * answers at the end is:
 *
 *   - a progress bar that cannot exist, because there is nothing to ask;
 *   - a Cancel button that cannot exist, because there is nothing to tell;
 *   - a request that will outlive somebody's proxy, browser or patience,
 *     and whose failure then looks identical to the backup having failed.
 *
 * §16 says it outright: "Backup cannot be a frozen window with no progress
 * and no cancel."
 *
 * So the POST starts the copy and returns an id immediately, the dialog
 * polls a status endpoint, and Cancel is its own call. POLLING RATHER THAN
 * SERVER-SENT EVENTS, deliberately: the client is one browser on localhost
 * asking a question every few hundred milliseconds, the state is a plain
 * object rather than a stream, and nothing in the app has an EventSource in
 * it today. A streaming transport would be a second thing to get wrong for
 * no behaviour the user can see.
 *
 * *** ONE BACKUP AT A TIME. *** Two concurrent copies of a 600 MB database
 * are not twice as useful; they are two jobs competing for the same disk,
 * and if the user typed the same destination twice they are two jobs
 * writing one file. A second start is refused while one is running, which
 * also means the dialog never has to decide which of several jobs it is
 * looking at.
 */

import { randomUUID } from 'crypto';

import { logError, logInfo } from '../logger';
import {
  BackupCancelled,
  BackupRequestError,
  performBackup,
  resolveBackupDestination,
  type BackupRequest,
  type BackupResult,
} from './run-backup';

/**
 * Where a job is.
 *
 *   running    the copy is in flight
 *   done       the file is on disk and complete
 *   cancelled  the user stopped it; nothing was left behind
 *   failed     something went wrong; `error` says what
 *
 * 'cancelled' is distinct from 'failed' on purpose. They are the same
 * outcome on disk — no file — and completely different news: one is what
 * the user asked for, the other is something they need to act on.
 */
export type BackupJobState = 'running' | 'done' | 'cancelled' | 'failed';

/** What GET /api/backup/jobs/:id answers. Safe to serialise as-is. */
export interface BackupJobStatus {
  readonly id: string;
  readonly state: BackupJobState;
  /** Where it is being written. Known from the first moment. */
  readonly destination: string;
  readonly percent: number;
  readonly totalPages: number;
  readonly copiedPages: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Present only when state is 'done'. */
  readonly result: BackupResult | null;
  /** A sentence for the user. Present only when state is 'failed'. */
  readonly error: string | null;
}

interface BackupJob {
  status: BackupJobStatus;
  cancelRequested: boolean;
}

/**
 * Finished jobs kept in memory.
 *
 * Small, because the only consumer is a dialog that polls the job it just
 * started. More than one exists so that a page refresh during a backup does
 * not make the result unreachable, and so the log of what happened is still
 * there when somebody asks a minute later. Nothing is persisted: a server
 * restart loses the history, which costs nothing because the FILE — the
 * actual product — is on disk with its name in the log.
 */
const MAX_REMEMBERED_JOBS = 8;

const jobs = new Map<string, BackupJob>();

/** The id of the job currently running, or null. Enforces one at a time. */
let runningJobId: string | null = null;

/**
 * Starts a backup and returns its initial status immediately.
 *
 * Throws BackupRequestError for anything the user can fix — a bad folder, a
 * name that is not a `.db`, a backup already running. Those are 400s, and
 * they are thrown SYNCHRONOUSLY from here rather than becoming a job that
 * instantly fails, so the dialog can show the message next to the box the
 * user typed in rather than in a progress panel.
 */
export function startBackupJob(
  request: Omit<BackupRequest, 'onProgress' | 'isCancelled'>
): BackupJobStatus {
  if (runningJobId !== null) {
    throw new BackupRequestError(
      'A backup is already running. Wait for it to finish, or cancel it first.'
    );
  }

  /* *** RESOLVED BEFORE THE JOB EXISTS, NOT INSIDE IT. ***
   *
   * "There is no folder called D:\Backpus" is a typo, and the user needs
   * to see it next to the box they typed it into, straight away. If the
   * destination were resolved inside performBackup() the request would
   * return 202, the dialog would open a progress panel, and a moment later
   * the typo would surface as a FAILED BACKUP — which reads as "the backup
   * feature is broken", not "you misspelt Backups".
   *
   * This also throws before `runningJobId` is claimed, so a rejected
   * request cannot leave the registry thinking a backup is in flight.
   *
   * It is resolved exactly ONCE and handed to performBackup(), because
   * resolution picks a free name: computing it twice could pick two. */
  const destinationPath = resolveBackupDestination(
    {
      directory: request.directory,
      ...(request.fileName !== undefined ? { fileName: request.fileName } : {}),
    },
    request.now ?? new Date()
  );

  const id = randomUUID();
  const startedAt = new Date().toISOString();

  const job: BackupJob = {
    cancelRequested: false,
    status: {
      id,
      state: 'running',
      // The real path, known from the first moment — including any " (2)"
      // the name needed to avoid overwriting an earlier backup.
      destination: destinationPath,
      percent: 0,
      totalPages: 0,
      copiedPages: 0,
      startedAt,
      finishedAt: null,
      result: null,
      error: null,
    },
  };

  jobs.set(id, job);
  runningJobId = id;
  forgetOldJobs();

  /* FIRE AND FORGET, ON PURPOSE. The promise is never returned to a
   * caller: this function's contract is "it has started", and the only way
   * to learn anything else is the status endpoint. Every path through the
   * chain below ends in a terminal state being recorded, so a job cannot
   * be left reading 'running' for ever. */
  void performBackup({
    ...request,
    destinationPath,
    onProgress: (progress) => {
      job.status = {
        ...job.status,
        percent: progress.percent,
        totalPages: progress.totalPages,
        copiedPages: progress.copiedPages,
      };
    },
    isCancelled: () => job.cancelRequested,
  })
    .then((result) => {
      job.status = {
        ...job.status,
        state: 'done',
        destination: result.path,
        percent: 100,
        finishedAt: new Date().toISOString(),
        result,
      };
    })
    .catch((err: unknown) => {
      if (err instanceof BackupCancelled) {
        job.status = {
          ...job.status,
          state: 'cancelled',
          finishedAt: new Date().toISOString(),
        };
        logInfo(`Backup job ${id} cancelled.`);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      job.status = {
        ...job.status,
        state: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      };
      logError(`Backup job ${id} failed`, message);
    })
    .finally(() => {
      // Cleared whatever happened, or the next backup is refused for ever.
      if (runningJobId === id) runningJobId = null;
    });

  return job.status;
}

/** The job's current status, or undefined if that id was never ours. */
export function getBackupJob(id: string): BackupJobStatus | undefined {
  return jobs.get(id)?.status;
}

/**
 * Asks a running job to stop. Returns false for an unknown id.
 *
 * ASKS. The flag is read by the progress callback once per batch, so the
 * job does not become 'cancelled' on this call — it becomes cancelled a
 * fraction of a second later, when the copy notices. Returning true here
 * means "the request was accepted", and the dialog keeps polling until the
 * state actually changes. Pretending otherwise would let the dialog tell
 * the user it had stopped while pages were still being written.
 *
 * Cancelling a job that has already finished is a no-op and NOT an error:
 * the user pressed Cancel at the same moment the copy completed, and there
 * is nothing to apologise for.
 */
export function cancelBackupJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status.state === 'running') job.cancelRequested = true;
  return true;
}

/** True while a backup is in flight. Used by restore to refuse to overlap. */
export function isBackupRunning(): boolean {
  return runningJobId !== null;
}

/**
 * Drops the oldest finished jobs once there are too many.
 *
 * A running job is never dropped, however old: losing the handle on a copy
 * that is still writing would leave the dialog polling an id that no longer
 * exists while the disk keeps filling.
 */
function forgetOldJobs(): void {
  while (jobs.size > MAX_REMEMBERED_JOBS) {
    const oldest = [...jobs.entries()].find(([, job]) => job.status.state !== 'running');
    if (!oldest) return;
    jobs.delete(oldest[0]);
  }
}

/**
 * Forgets everything. FOR TESTS ONLY — the registry is module state, and a
 * spec that started a job would otherwise leak it into the next one.
 */
export function resetBackupJobsForTesting(): void {
  jobs.clear();
  runningJobId = null;
}
