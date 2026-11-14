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
 * SupportModal — "Help → Report a problem".
 *
 * THIS DIALOG'S JOB IS CONSENT
 *
 * The redaction lives on the server and has its own canary tests. What
 * happens here is the thing a user can actually be wronged by: deciding what
 * leaves their machine. The flow is two steps:
 *
 *   describe  say what went wrong; choose whether to include the log; read a
 *             plain-language list of what will be included; optionally expand
 *             the exact report text; and read what attaching a file of your
 *             own on GitHub would mean before you go and do it.
 *   done      the report file is on the Desktop — with a redacted log file
 *             beside it if you asked for one — the browser is at a pre-filled
 *             issue, nothing was uploaded, and the link is there to click
 *             again.
 *
 * "INCLUDE RECENT LOG" IS A CONSENT CONTROL, NOT A CONVENIENCE
 *
 * Removing the zip removed the only REDACTED log a user could share, leaving
 * the raw `app.log` — account name, machine name, photo paths — as the only
 * thing to hand for a public issue. Ticking the box writes a redacted `.txt`
 * beside the report. Unticking it means no log content at all, including the
 * 150-line tail that would otherwise sit in the report body, because
 * "include the log" has to mean all of it.
 *
 * It is ticked by default: this dialog is reached from "Report a problem" and
 * a log is the most useful thing in a bug report. But a feature request does
 * not need one, so it is one click off — and `includedSummary` changes when
 * it is, so the state is never ambiguous.
 *
 * THERE IS NO FILE PICKER, AND THAT IS NOT AN OMISSION
 *
 * The dialog used to stage files, base64 them, and post them to the server
 * to be put in a zip. The zip is gone — the owner's instruction, because
 * zipping a report that is already text gains nothing and zipping a JPG
 * actively hides it: GitHub renders a dragged-in image inline and cannot see
 * inside an archive. With no archive, a staged file had nowhere to go: the
 * app cannot upload to GitHub, because there is no official attachment API,
 * only undocumented routes that disagree about whether a token even works.
 *
 * So the picker was removed rather than left collecting files it would
 * silently drop, and with it the per-file and total size caps — they bounded
 * an archive that is no longer built. GitHub enforces its own 25 MB on what
 * the user drags in, which is the only place a limit can now be applied.
 *
 * WHY THE WARNING SURVIVED THE PICKER
 *
 * The blunt acknowledgement text existed because a QIF or a spreadsheet can
 * carry far more than coins — real exports have held stock holdings,
 * retirement accounts, a home address and private company names — and the
 * issue is PUBLIC. None of that changes because the user is now the one
 * doing the attaching. So the warning stayed and was re-aimed: it is
 * guidance next to the "attach them on GitHub" instruction, not a gate on a
 * control that no longer exists.
 *
 * THE LINK IS THE FEATURE
 *
 * Pointing at GitHub is not a consolation prize for a missing uploader, it
 * is the only route that works — so the address is offered as a real
 * clickable link on BOTH steps, and the user never has to retype or hunt for
 * it. That is why `config()` is fetched on construction rather than taken
 * out of the preview response: the link has to be on screen before anything
 * is built, and building the report reads the log and queries the database.
 *
 * WHILE THE REPOSITORY IS THE SHIPPED PLACEHOLDER, NO LINK IS RENDERED. The
 * one thing worse than no support button is one that sends the user to a 404
 * while telling them their report has been filed.
 *
 * WHY THERE IS NO MANDATORY REVIEW STEP
 *
 * There used to be a third step between those two: the generated Markdown in
 * an editable textarea, which everybody had to walk through. It was the
 * consent gate, and it was a bad one. The thing it showed is a technical
 * artefact — headings, version tables, a log tail — and a wall of markup that
 * a non-technical user cannot evaluate does not inform consent, it just
 * trains them to press Next.
 *
 * What replaced it is NOT less disclosure:
 *
 *   - `includedSummary` says, in sentences, what goes in — including the live
 *     count of errors. That is the part a person can actually act on.
 *   - the exact text is still one click away, in a disclosure, for anyone who
 *     wants it. It is VIEW-ONLY, and that is deliberate (see below).
 *   - nothing is written to disk until the submit button is pressed, exactly
 *     as before. The preview endpoint still builds the text and still writes
 *     nothing.
 *
 * WHY THE DISCLOSURE SHOWS, BUT DOES NOT EDIT
 *
 * The old textarea's editability only made sense as part of a mandatory stop:
 * you read the text, you changed it, you sent what was on the screen. Hanging
 * that off an optional disclosure would create a box whose contents may or
 * may not be what is sent, depending on whether the user later changed the
 * description — which is the one property a "this is what will be sent" box
 * must never have. So the disclosure shows the cached, already-built report,
 * byte for byte the same text that `sendReport` hands to the writer, and says
 * so when it has gone stale.
 *
 * WHY THE REPORT IS CACHED AGAINST ITS INPUTS
 *
 * `inputKey` fingerprints everything that can change the report: the
 * description, and how many errors have been recorded. A build is reused only
 * while that fingerprint still matches. Without it, "show me the text" and
 * "send it" would be two builds with two different `generatedAt` timestamps,
 * and the text shown would not be the text sent — true in a way too small to
 * notice and too annoying to defend.
 *
 * NO DOM IN THE DECISIONS
 *
 * Every method below takes plain data, and the only browser APIs in the whole
 * feature sit behind SupportService.openIssue / copyToClipboard. That is what
 * makes this testable at all: the frontend suite runs under Node with no
 * jsdom.
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
   * "Include recent log".
   *
   * DEFAULT TICKED. This dialog is reached from "Report a problem" and a log
   * is the single most useful thing in a bug report — but it is one click to
   * turn off, and `includedSummary` changes when it is, so the state is never
   * ambiguous.
   *
   * IT IS NOT JUST ABOUT THE SECOND FILE. Unticking also removes the 150-line
   * tail from the report body: "include the log" has to mean all of it, or a
   * user who turned it off because they did not want log lines in a public
   * issue would publish 150 of them anyway. That is why this is part of
   * `inputKey` — changing it changes the document.
   */
  readonly includeLog = signal(true);

  // ---- Where issues go -------------------------------------------------
  readonly repositoryUrl = signal('');
  readonly repositoryConfigured = signal(false);
  readonly outputDirectory = signal('');
  /** True when the settings could not be read at all, which is not the same
   *  thing as "no repository is configured" and must not be reported as it. */
  readonly configFailed = signal(false);

  /**
   * Resolves once the settings request has finished, successfully or not.
   *
   * `sendReport` awaits it so that a user who opens the dialog and submits
   * immediately still gets the right answer about whether a repository
   * exists, rather than racing the fetch and silently not opening anything.
   */
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
   * Everything that changes what the report says.
   *
   * The error count rather than the errors themselves: the buffer only ever
   * grows within one dialog session, so a change in length is the only way
   * its contents can differ.
   *
   * `includeLog` BELONGS HERE. It is not a write-time switch: unticking it
   * removes the log tail from the report body, so a cached build made while
   * it was ticked is a different document. Leaving it out would let the
   * disclosure show 150 log lines the user has since turned off, and then
   * write that same stale text to disk.
   */
  private readonly inputKey = computed(() =>
    JSON.stringify({
      description: this.description(),
      errors: this.recentErrorCount(),
      includeLog: this.includeLog()
    })
  );

  /**
   * The log file the server actually wrote, or null.
   *
   * The done step quotes this rather than re-deriving it from `includeLog()`:
   * the path shown to the user must be a file that exists.
   */
  readonly savedLog = computed<SavedLogFile | null>(() => this.saved()?.log ?? null);

  /** The exact text that will be sent, or '' if none has been built yet. */
  readonly reportText = computed(() => this.built()?.preview.markdown ?? '');
  readonly receipt = computed<RedactionReceiptEntry[]>(() => this.built()?.preview.receipt ?? []);

  /** True when something changed after the shown text was built. */
  readonly reportStale = computed(() => {
    const current = this.built();
    return current !== null && current.key !== this.inputKey();
  });

  /**
   * The clickable address, or '' when there is nothing safe to link to.
   *
   * '' rather than the placeholder URL: the template renders a link only when
   * this is non-empty, which is what stops a 404 ever being offered.
   */
  readonly issuePageLink = computed(() =>
    this.repositoryConfigured() ? issuePageUrl(this.repositoryUrl()) : ''
  );

  /**
   * What the done step links to: the pre-filled issue that was opened, if one
   * was, so a user whose pop-up blocker ate the tab can simply click it.
   */
  readonly doneLink = computed(() => this.openedIssueUrl() || this.issuePageLink());

  /**
   * What goes in, in sentences.
   *
   * This is the replacement for the mandatory markdown stop, so it has to be
   * specific where it can be: the live error count, and a flat statement that
   * none of the user's own files are involved. "Some diagnostic information"
   * would be exactly the vagueness the old preview existed to prevent.
   */
  readonly includedSummary = computed<string[]>(() => [
    'Which versions of the app, the server and Windows you are running, and your processor type.',
    'How many coins, photos and sold coins you have — counts only, never anything that is in them.',
    `${this.recentErrorCount()} error(s) the app recorded this session.`,
    this.logSummaryLine(),
    'Whatever you typed in the box above.',
    'None of your own files. The app cannot attach or upload anything — if you want to send a file, you add it yourself on GitHub.'
  ]);

  /**
   * The one line in the summary that the checkbox changes.
   *
   * IT MUST CHANGE, and visibly. A summary that read the same either way
   * would leave the state ambiguous at exactly the moment the user is
   * deciding what to publish — which is the one thing this dialog exists to
   * make unambiguous.
   *
   * The unticked wording is careful about what remains: the names and sizes
   * of the log files still go, because they are not log CONTENT and they
   * answer "is it even logging". Saying so is better than quietly keeping
   * them under a sentence that implies nothing log-related is sent.
   */
  private logSummaryLine(): string {
    return this.includeLog()
      ? 'Your recent log: the last lines in the report itself, and a separate redacted log file ' +
        'saved next to it for you to attach. Also the names and sizes of your log files.'
      : 'No log lines at all — not in the report, and no log file is written. Only the names and ' +
        'sizes of your log files, which say how much there is, never what is in it.';
  }

  // ---- Where issues go -------------------------------------------------

  /**
   * Read the repository address.
   *
   * A failure is NOT reported as "no repository is configured": those are
   * different facts and the user can act on only one of them. Either way no
   * link is rendered, which is the safe side of the only decision that
   * matters here.
   */
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

  /**
   * Ask the backend to build the report, or hand back the one already built
   * from these same inputs.
   *
   * Nothing is written to disk by this call. It is still the preview
   * endpoint; the user has consented to nothing by reaching it.
   */
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
   * Open or close the "show me the exact text" disclosure.
   *
   * Opening it builds the report if there is not already a current one. A
   * failure here is reported where the user is — it does not move them
   * anywhere, and it does not stop them submitting.
   *
   * It deliberately does NOT clear `errorMessage` first: that field may be
   * holding something about the user's own last action, and wiping it because
   * somebody looked at the report text would lose that message.
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
   * The report, plus a footer naming the saved file and saying what to do.
   *
   * WHY THE PATH IS IN THE BODY. The user is on the GitHub page when they
   * need to find that file; a path shown only in a dialog they have since
   * closed is a path they have to remember.
   *
   * WHY IT IS THE REDACTED PATH. The issue is public, and a raw
   * `C:\Users\dave\Desktop\…` would republish the user name that every other
   * line of this feature removes. The redacted form still tells the user
   * everything: they know who they are, and the file name is the part they
   * have to recognise.
   *
   * THE LOG FILE'S PATH GETS THE SAME TREATMENT, for the same reason and with
   * no exception made because it is the second file. It is named here only
   * when one was actually written — `saved.log` is what the server says it
   * did, not what the checkbox asked for.
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
   * Build the report if needed, write the file, then open the pre-filled
   * issue.
   *
   * The double-click guard is not cosmetic: `busy` is set synchronously,
   * before the first await. Without that, a double-click writes two files to
   * the Desktop and opens two browser tabs, and the user then attaches
   * whichever one they happen to click.
   *
   * The browser may not open at all. No repository need be configured, and
   * opening a 404 while telling the user their report has been filed leaves
   * them believing they have been heard when they have not. In that case we
   * say, plainly, that the file has been saved and where it is.
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

      // Built from `saved`, which is what the server says it wrote, rather
      // than from the checkbox, which is only what was asked for. The user is
      // being told what is on their own Desktop; that has to be true.
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
