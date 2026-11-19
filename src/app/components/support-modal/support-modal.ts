import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  RedactionReceiptEntry,
  SavedLogFile,
  SavedReport,
  SupportPreview,
  SupportService
} from '../../services/support/support.service';
import { RecentErrorsService } from '../../services/support/recent-errors.service';
import { issuePageUrl, planIssueSubmission } from '../../services/support/issue-url';

/**
 * "Help -> Report a problem". Two steps: describe (what went wrong, whether to
 * include the log, a plain-language summary of what is included, and an
 * optional view-only copy of the exact report) and done (report saved to disk,
 * pre-filled GitHub issue opened). Nothing is uploaded; the user attaches files
 * on GitHub themselves.
 *
 * No link is rendered while the repository is unconfigured, to avoid a 404.
 * Browser APIs are confined to SupportService so this runs in Node tests.
 */

export type SupportStep = 'describe' | 'done';

/** A report the server built, remembered with the inputs it was built from. */
interface BuiltReport {
  key: string;
  preview: SupportPreview;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Component({
  selector: 'app-support-modal',
  imports: [FormsModule],
  templateUrl: './support-modal.html',
  styleUrl: './support-modal.scss'
})
export class SupportModal {
  private readonly support = inject(SupportService);
  private readonly recentErrors = inject(RecentErrorsService);

  readonly closed = output<void>();

  // ---- Where we are --------------------------------------------------
  readonly step = signal<SupportStep>('describe');
  readonly busy = signal(false);
  readonly errorMessage = signal('');

  // ---- What the user told us ------------------------------------------
  readonly description = signal('');

  /**
   * "Include recent log" (ticked by default). Unticking removes the log tail
   * from the report body as well as the separate log file.
   */
  readonly includeLog = signal(true);

  // ---- Where issues go -------------------------------------------------
  readonly repositoryUrl = signal('');
  readonly repositoryConfigured = signal(false);
  readonly outputDirectory = signal('');
  /** True when the settings could not be read (distinct from "no repository configured"). */
  readonly configFailed = signal(false);

  /** Resolves once the settings request has finished; sendReport awaits it to avoid a race. */
  readonly configReady: Promise<void>;

  // ---- The optional "show me the exact text" disclosure -----------------
  readonly showReportText = signal(false);
  readonly loadingReport = signal(false);

  // ---- What the server gave back ---------------------------------------
  /** The last report the server built, plus the inputs it was built from. */
  readonly built = signal<BuiltReport | null>(null);
  readonly saved = signal<SavedReport | null>(null);
  readonly submissionNote = signal('');
  /** The pre-filled issue that was actually opened, so it can be clicked again. */
  readonly openedIssueUrl = signal('');

  /** De-duplicates a build that the disclosure and the submit both want. */
  private pending: Promise<SupportPreview> | null = null;
  private pendingKey: string | null = null;

  constructor() {
    this.configReady = this.loadConfig();
  }

  readonly recentErrorCount = computed(() => this.recentErrors.errors().length);

  /**
   * Fingerprint of everything that changes the report, so a cached build is
   * reused only while it matches (the shown text must be the sent text). The
   * error buffer only grows, so its length is enough.
   */
  private readonly inputKey = computed(() =>
    JSON.stringify({
      description: this.description(),
      errors: this.recentErrorCount(),
      includeLog: this.includeLog()
    })
  );

  /** The log file the server actually wrote, or null. */
  readonly savedLog = computed<SavedLogFile | null>(() => this.saved()?.log ?? null);

  /** The exact text that will be sent, or '' if none has been built yet. */
  readonly reportText = computed(() => this.built()?.preview.markdown ?? '');
  readonly receipt = computed<RedactionReceiptEntry[]>(() => this.built()?.preview.receipt ?? []);

  /** True when something changed after the shown text was built. */
  readonly reportStale = computed(() => {
    const current = this.built();
    return current !== null && current.key !== this.inputKey();
  });

  /** The issues page link, or '' when no repository is configured (no link is rendered). */
  readonly issuePageLink = computed(() =>
    this.repositoryConfigured() ? issuePageUrl(this.repositoryUrl()) : ''
  );

  /** The done step's link: the opened issue if any, so a blocked pop-up can be retried. */
  readonly doneLink = computed(() => this.openedIssueUrl() || this.issuePageLink());

  /** Plain-language list of what the report includes. */
  readonly includedSummary = computed<string[]>(() => [
    'Which versions of the app, the server and Windows you are running, and your processor type.',
    'How many coins, photos and sold coins you have — counts only, never anything that is in them.',
    `${this.recentErrorCount()} error(s) the app recorded this session.`,
    this.logSummaryLine(),
    'Whatever you typed in the box above.',
    'None of your own files. The app cannot attach or upload anything — if you want to send a file, you add it yourself on GitHub.'
  ]);

  /** The summary line that reflects the "include log" checkbox. */
  private logSummaryLine(): string {
    return this.includeLog()
      ? 'Your recent log: the last lines in the report itself, and a separate redacted log file ' +
        'saved next to it for you to attach. Also the names and sizes of your log files.'
      : 'No log lines at all — not in the report, and no log file is written. Only the names and ' +
        'sizes of your log files, which say how much there is, never what is in it.';
  }

  // ---- Where issues go -------------------------------------------------

  /** Reads the repository settings. On failure, sets configFailed and renders no link. */
  private async loadConfig(): Promise<void> {
    try {
      const config = await this.support.config();
      this.repositoryUrl.set(config.repositoryUrl);
      this.repositoryConfigured.set(config.repositoryConfigured);
      this.outputDirectory.set(config.outputDirectory);
    } catch {
      this.configFailed.set(true);
      this.repositoryConfigured.set(false);
    }
  }

  // ---- Building the report ---------------------------------------------

  /** Builds the report via the preview endpoint (writes nothing), or reuses a current build. */
  private async ensureReport(): Promise<SupportPreview> {
    const key = this.inputKey();

    const current = this.built();
    if (current && current.key === key) return current.preview;

    if (!this.pending || this.pendingKey !== key) {
      this.pendingKey = key;
      this.pending = this.fetchReport(key);
    }
    return this.pending;
  }

  private async fetchReport(key: string): Promise<SupportPreview> {
    try {
      const preview = await this.support.preview({
        userDescription: this.description(),
        clientErrors: this.recentErrors.snapshot(),
        includeLog: this.includeLog()
      });

      this.built.set({ key, preview });
      return preview;
    } finally {
      if (this.pendingKey === key) {
        this.pending = null;
        this.pendingKey = null;
      }
    }
  }

  /**
   * Opens or closes the exact-text disclosure, building the report if needed.
   * Does not clear errorMessage, which may hold an error from the last action.
   */
  async setReportTextVisible(visible: boolean): Promise<void> {
    this.showReportText.set(visible);
    if (!visible || this.loadingReport()) return;

    this.loadingReport.set(true);
    try {
      await this.ensureReport();
    } catch (err) {
      this.errorMessage.set(describeError(err));
    } finally {
      this.loadingReport.set(false);
    }
  }

  // ---- Send ------------------------------------------------------------

  /** A short, useful issue title derived from what the user typed. */
  private issueTitle(): string {
    const firstLine = this.description().trim().split(/\r?\n/)[0]?.trim() ?? '';
    if (firstLine.length === 0) return 'Problem report from Coin Inventory';
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  }

  /**
   * The report plus a footer naming the saved file(s). Uses redacted paths
   * because the issue is public.
   */
  private issueBody(report: string, saved: SavedReport): string {
    const out: string[] = [
      report,
      '',
      '---',
      '',
      '### Files',
      '',
      '**Nothing was uploaded by the app.** It saved the report above to a file on the',
      'reporter’s own machine:',
      '',
      '```',
      saved.redactedPath,
      '```',
      ''
    ];

    if (saved.log) {
      out.push(
        'It also saved a **redacted copy of the recent log** beside it, because the',
        'reporter ticked "Include recent log". Same placeholders as the report above —',
        'a folder shown as `<USER>` here is the same folder there:',
        '',
        '```',
        saved.log.redactedPath,
        '```',
        ''
      );
    }

    out.push(
      'To add anything else — those files, a screenshot, a QIF or a spreadsheet — drag',
      'them into this issue. Images display inline.',
      ''
    );

    return out.join('\n');
  }

  /**
   * Builds the report if needed, saves it, then opens the pre-filled issue
   * (only when a repository is configured).
   * `busy` is set before the first await so a double-click can't save twice.
   */
  async sendReport(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.errorMessage.set('');

    try {
      await this.configReady;

      const report = await this.ensureReport();
      const saved = await this.support.saveReport(report.markdown, this.includeLog());
      this.saved.set(saved);

      const body = this.issueBody(report.markdown, saved);

      // Based on what the server actually wrote, not on the checkbox.
      const notes: string[] = [
        `Nothing was uploaded. The report was saved to ${saved.directory} as ${saved.fileName}.`
      ];

      if (saved.log) {
        notes.push(
          `A redacted copy of your recent log was saved beside it as ${saved.log.fileName}.`
        );
      }

      if (this.repositoryConfigured()) {
        const plan = planIssueSubmission(this.repositoryUrl(), this.issueTitle(), body);

        if (plan.mode === 'clipboard') {
          const copied = await this.support.copyToClipboard(plan.clipboardText ?? body);
          notes.push(
            copied
              ? 'The report was too long for a link, so it has been copied to your clipboard — paste it into the issue.'
              : 'The report was too long for a link and the clipboard was not available, so please copy the report text out of the saved file yourself.'
          );
        }

        notes.push(
          saved.log
            ? 'Drag those files into the issue if you want to include them, along with any ' +
              'screenshots or exports — images display inline on GitHub.'
            : 'Drag that file into the issue if you want to include it, along with any ' +
              'screenshots or exports — images display inline on GitHub.'
        );

        this.openedIssueUrl.set(plan.url);
        this.support.openIssue(plan.url);
      } else {
        notes.push(
          this.configFailed()
            ? 'The support settings could not be read, so nothing was opened. ' +
              'The report file is saved and can be sent on however you like.'
            : 'No GitHub repository has been configured yet, so nothing was opened. ' +
              'The report file is saved and can be sent on however you like.'
        );
      }

      this.submissionNote.set(notes.join(' '));
      this.step.set('done');
    } catch (err) {
      this.errorMessage.set(describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  close(): void {
    this.closed.emit();
  }
}
