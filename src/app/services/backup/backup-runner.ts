/**
 * services/backup/backup-runner.ts — DRIVING A BACKUP THAT TAKES MINUTES.
 *
 * An ordinary class created with `new`, not an Angular service — the same
 * choice InventoryService makes for its helpers, and for the same reason:
 * it must be constructible from a spec with nothing but a couple of stubs,
 * and the suite runs under Node with no jsdom and no TestBed.
 *
 * *** WHY THERE IS A RUNNER AT ALL. *** The owner's collection is ~600 MB
 * today and design §4.9a makes multiple gigabytes ordinary, so a backup is
 * a job measured in minutes. The server starts it and hands back an id;
 * somebody has to ask "how far?" until it stops, keep the answer somewhere
 * the dialog can render it, and stop asking when the user closes the
 * dialog. That is this class, and it is separate from the component so
 * that all of it can be tested.
 *
 * THE THREE THINGS IT HAS TO GET RIGHT, in rough order of how badly each
 * one bites:
 *
 *   1. STOP POLLING. A dialog closed mid-backup must not leave a timer
 *      firing an HTTP request every 400 ms for the rest of the session.
 *      `dispose()` exists for that and the component calls it.
 *   2. SURVIVE A FAILED POLL. One dropped request during a ten-minute
 *      copy must not abandon the job — the backup is still running on the
 *      server, and giving up on watching it would report a false failure
 *      for a file that is about to appear. Transient failures are counted,
 *      not fatal.
 *   3. NEVER REPORT SUCCESS IT DID NOT SEE. The only route to 'done' is
 *      the server saying 'done'.
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

/**
 * How often to ask.
 *
 * Fast enough that the bar moves smoothly, slow enough that a
 * ten-minute backup is 1,500 requests rather than 60,000. The requests
 * are to localhost and read a plain object, so the cost is negligible
 * either way — this is chosen for how it LOOKS.
 */
export const POLL_INTERVAL_MS = 400;

/**
 * How many consecutive failed polls before giving up.
 *
 * Not one. A ten-minute copy is long enough to catch a momentary hiccup,
 * and the backup is running on the SERVER — the poll failing says nothing
 * about whether the file is being written. Four in a row (about 1.6
 * seconds of silence) means something is actually wrong.
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 4;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BackupRunner {
  /** The latest status from the server, or null before anything started. */
  private statusValue: BackupJobStatus | null = null;

  /** A problem with the REQUEST, as opposed to with the backup. */
  private errorValue: string | null = null;

  /** Set by dispose(). Stops the loop at its next check. */
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

  /** The finished backup, or null. The dialog shows the path from this. */
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
   * Starts a backup and watches it to the end.
   *
   * Resolves when the job reaches a terminal state (or the watch gives
   * up); it does not throw. A failure to even START is reported through
   * `error`, because the caller is a button handler and there is nothing
   * useful for it to catch.
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
      // The server refused: a folder that does not exist, a name that is
      // not a .db, a backup already running. Its sentence is the useful
      // thing, so it is shown rather than "request failed".
      this.errorValue = messageFrom(err);
      this.busy = false;
      this.deps.onChange();
      return;
    }

    await this.watch();
  }

  /** Asks the server to stop. The state changes on the next poll. */
  async requestCancel(): Promise<void> {
    const id = this.statusValue?.id;
    if (!id || this.statusValue?.state !== 'running') return;

    try {
      await this.deps.cancel(id);
    } catch {
      // Best effort. If the cancel request itself failed, the job is
      // still running and the next poll will say so — which is more
      // honest than an error about a button press.
    }
  }

  /**
   * Stops watching. MUST be called when the dialog closes.
   *
   * It does NOT cancel the backup: closing a dialog is not a decision to
   * abandon a nine-minute copy, and a user who wanted that has a Cancel
   * button. It only stops this object asking questions.
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
          // Carefully worded: we have lost SIGHT of the backup, which is
          // not the same as the backup having failed. Telling the user it
          // failed when the file is about to appear would be a lie that
          // makes them do it again.
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

/** The server's sentence if there is one, else something harmless. */
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
