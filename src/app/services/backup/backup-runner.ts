/**
 * Drives a server-side backup job, which can take minutes: starts it, polls
 * progress for the dialog, and stops polling on dispose(). A plain class so
 * specs can construct it with stubs.
 *
 * - dispose() must be called when the dialog closes, or polling continues.
 * - Transient poll failures are counted, not fatal; the job keeps running on the server.
 * - The only route to 'done' is the server reporting 'done'.
 */

import {
  BackupJobStatus,
  BackupResult,
  canCancelBackup,
  describeBackupStatus
} from './backup-messages';

/** Everything the runner needs from the outside world. */
export interface BackupRunnerDeps {
  /** POST /api/backup/jobs */
  readonly start: (directory: string, fileName: string) => Promise<BackupJobStatus>;
  /** GET /api/backup/jobs/:id */
  readonly poll: (id: string) => Promise<BackupJobStatus>;
  /** POST /api/backup/jobs/:id/cancel */
  readonly cancel: (id: string) => Promise<unknown>;
  /** Called whenever the visible state changes. */
  readonly onChange: () => void;
  /** Injected so specs do not wait in real time. */
  readonly delay?: (ms: number) => Promise<void>;
}

/** Poll interval: smooth progress bar, modest request count (localhost only). */
export const POLL_INTERVAL_MS = 400;

/**
 * Consecutive failed polls (~1.6 s) before giving up. One failure says nothing
 * about the server-side job.
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 4;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BackupRunner {
  /** The latest status from the server, or null before anything started. */
  private statusValue: BackupJobStatus | null = null;

  /** A problem with the request, as opposed to the backup. */
  private errorValue: string | null = null;

  /** Set by dispose(); stops the loop at its next check. */
  private disposed = false;

  /** True between pressing Back up and the job reaching a terminal state. */
  private busy = false;

  constructor(private readonly deps: BackupRunnerDeps) {}

  get status(): BackupJobStatus | null {
    return this.statusValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  get running(): boolean {
    return this.busy;
  }

  /** The finished backup, or null. */
  get result(): BackupResult | null {
    return this.statusValue?.state === 'done' ? this.statusValue.result : null;
  }

  /** The sentence under the progress bar. */
  get message(): string {
    return this.errorValue ?? describeBackupStatus(this.statusValue);
  }

  get canCancel(): boolean {
    return canCancelBackup(this.statusValue);
  }

  get percent(): number {
    return this.statusValue?.percent ?? 0;
  }

  /**
   * Starts a backup and watches it to the end. Never throws: a failure to start
   * is reported through `error`.
   */
  async run(directory: string, fileName: string): Promise<void> {
    if (this.busy) return;

    this.busy = true;
    this.errorValue = null;
    this.statusValue = null;
    this.deps.onChange();

    try {
      this.statusValue = await this.deps.start(directory, fileName);
      this.deps.onChange();
    } catch (err) {
      // Show the server's refusal (missing folder, bad name, backup already running).
      this.errorValue = messageFrom(err);
      this.busy = false;
      this.deps.onChange();
      return;
    }

    await this.watch();
  }

  /** Asks the server to stop; the state changes on the next poll. */
  async requestCancel(): Promise<void> {
    const id = this.statusValue?.id;
    if (!id || this.statusValue?.state !== 'running') return;

    try {
      await this.deps.cancel(id);
    } catch {
      // Best effort: if cancel failed, the next poll still shows the job running.
    }
  }

  /**
   * Stops watching; must be called when the dialog closes. Does not cancel the
   * backup itself.
   */
  dispose(): void {
    this.disposed = true;
  }

  /** Clears the panel so the dialog can be used again. */
  reset(): void {
    this.statusValue = null;
    this.errorValue = null;
    this.busy = false;
    this.deps.onChange();
  }

  private async watch(): Promise<void> {
    const id = this.statusValue?.id;
    if (!id) {
      this.busy = false;
      return;
    }

    const delay = this.deps.delay ?? sleep;
    let consecutiveFailures = 0;

    while (!this.disposed) {
      await delay(POLL_INTERVAL_MS);
      if (this.disposed) break;

      try {
        this.statusValue = await this.deps.poll(id);
        consecutiveFailures = 0;
        this.deps.onChange();

        if (this.statusValue.state !== 'running') break;
      } catch (err) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          // "Lost contact" rather than "failed": the backup may still finish.
          this.errorValue =
            `Lost contact with the backup (${messageFrom(err)}). It may still be ` +
            `running — check the folder before starting another one.`;
          this.deps.onChange();
          break;
        }
      }
    }

    this.busy = false;
    this.deps.onChange();
  }
}

/** The server's message if there is one, else a generic one. */
export function messageFrom(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const body = (err as { error?: unknown }).error;
    if (typeof body === 'object' && body !== null) {
      const message = (body as { error?: unknown }).error;
      if (typeof message === 'string' && message.length > 0) return message;
    }
    if (typeof body === 'string' && body.length > 0) return body;

    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'The request could not be completed.';
}
