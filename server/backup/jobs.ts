/**
 * Backup job registry. A large backup takes minutes, so POST starts the copy
 * and returns a job id immediately; the dialog polls the status endpoint and
 * Cancel is a separate call. Polling (not SSE) keeps it simple for one local
 * client. Only one backup may run at a time.
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
 * Where a job is: running, done, cancelled (user stopped it; nothing left on
 * disk) or failed (`error` says why).
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
 * Finished jobs kept in memory, so a page refresh can still see the result.
 * Nothing is persisted.
 */
const MAX_REMEMBERED_JOBS = 8;

const jobs = new Map<string, BackupJob>();

/** The id of the job currently running, or null. Enforces one at a time. */
let runningJobId: string | null = null;

/**
 * Starts a backup and returns its initial status immediately. Throws
 * BackupRequestError synchronously (a 400) for problems the user can fix:
 * bad folder, not a `.db` name, or a backup already running.
 */
export function startBackupJob(
  request: Omit<BackupRequest, 'onProgress' | 'isCancelled'>
): BackupJobStatus {
  if (runningJobId !== null) {
    throw new BackupRequestError(
      'A backup is already running. Wait for it to finish, or cancel it first.'
    );
  }

  // Resolved before the job exists, so a typo in the folder is a 400 next to
  // the input rather than a failed job; and before runningJobId is claimed.
  // Resolved once, since it picks a free name.
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
      // The final path, including any " (2)" suffix.
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

  // Not awaited: callers learn the outcome from the status endpoint. Every
  // path below records a terminal state.
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
      // Always cleared, or every later backup would be refused.
      if (runningJobId === id) runningJobId = null;
    });

  return job.status;
}

/** The job's current status, or undefined if that id was never ours. */
export function getBackupJob(id: string): BackupJobStatus | undefined {
  return jobs.get(id)?.status;
}

/**
 * Asks a running job to stop; returns false for an unknown id. The job
 * becomes 'cancelled' when the next batch notices, so the dialog keeps
 * polling. Cancelling a finished job is a no-op.
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

/** Drops the oldest finished jobs once there are too many. Running jobs are never dropped. */
function forgetOldJobs(): void {
  while (jobs.size > MAX_REMEMBERED_JOBS) {
    const oldest = [...jobs.entries()].find(([, job]) => job.status.state !== 'running');
    if (!oldest) return;
    jobs.delete(oldest[0]);
  }
}

/** Clears the registry. For tests only. */
export function resetBackupJobsForTesting(): void {
  jobs.clear();
  runningJobId = null;
}
