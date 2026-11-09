import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  BundleResult,
  ChosenAttachment,
  FileLike,
  RedactionReceiptEntry,
  SupportLimits,
  SupportPreview,
  SupportService
} from '../../services/support/support.service';
import { RecentErrorsService } from '../../services/support/recent-errors.service';
import { planIssueSubmission } from '../../services/support/issue-url';

/**
 * SupportModal — "Help → Report a problem".
 *
 * THIS DIALOG'S JOB IS CONSENT
 *
 * The redaction lives on the server and has its own canary tests. What
 * happens here is the thing a user can actually be wronged by: deciding what
 * leaves their machine. So the flow is a sequence, and the order is the
 * design:
 *
 *   describe  say what went wrong, and — separately, deliberately, behind a
 *             warning they have to acknowledge — attach their own files.
 *   review    see the ACTUAL text, editable, with a list of what was
 *             replaced. Nothing has been written yet.
 *   done      the zip is on the Desktop, the browser is at a pre-filled
 *             issue, and they are told to drag the file in.
 *
 * Nothing is uploaded. Nothing is collected without being shown. Nothing is
 * attached that was not picked by hand.
 *
 * WHY THE ATTACHMENT WARNING GATES THE PICKER
 *
 * A checkbox that only records an opinion is decoration. This one disables
 * the file picker until it is ticked, and un-ticking it DISCARDS everything
 * already staged — because withdrawing consent has to actually withdraw it,
 * not just change what the screen says.
 *
 * The warning is blunt for a concrete reason: a real QIF export can carry
 * stock holdings, retirement accounts, a street address and private company
 * names. A user attaching "just my QIF" to a public issue is about to publish
 * all of that without knowing it, and a softly-worded note would not stop
 * them.
 *
 * NO DOM IN THE DECISIONS
 *
 * Every method below takes plain data — `addFiles` takes `FileLike[]`, not a
 * FileList — and the only browser APIs in the whole feature sit behind
 * SupportService.openIssue / copyToClipboard. That is what makes this
 * testable at all: the frontend suite runs under Node with no jsdom.
 */

export type SupportStep = 'describe' | 'review' | 'done';

/** Used until the backend tells us its real limits in the preview response. */
const FALLBACK_LIMITS: SupportLimits = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024
};

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
   * Public and writable because the template binds a checkbox to it and the
   * tests drive it directly. Use `setAttachmentsUnderstood` for the
   * un-ticking path — it has the clearing behaviour.
   */
  readonly attachmentsUnderstood = signal(false);
  readonly attachments = signal<ChosenAttachment[]>([]);
  readonly limits = signal<SupportLimits>(FALLBACK_LIMITS);

  // ---- What the server gave back ---------------------------------------
  readonly preview = signal<SupportPreview | null>(null);
  /** The editable report. Bound to a textarea; this is what gets sent. */
  readonly reportText = signal('');
  readonly receipt = signal<RedactionReceiptEntry[]>([]);
  readonly result = signal<BundleResult | null>(null);
  readonly rejected = signal<Array<{ name: string; reason: string }>>([]);
  readonly submissionNote = signal('');

  readonly recentErrorCount = computed(() => this.recentErrors.errors().length);
  readonly attachmentCount = computed(() => this.attachments().length);

  readonly totalAttachmentBytes = computed(() =>
    this.attachments().reduce((sum, file) => sum + file.bytes, 0)
  );

  // ---- Attachments -----------------------------------------------------

  /** Called by the template's checkbox. Un-ticking discards staged files. */
  setAttachmentsUnderstood(understood: boolean): void {
    this.attachmentsUnderstood.set(understood);
    if (!understood) {
      this.attachments.set([]);
    }
  }

  /** Apply the limits the backend reported, replacing the local fallback. */
  applyLimits(limits: SupportLimits): void {
    this.limits.set(limits);
  }

  /**
   * Stage files the user picked.
   *
   * Checks the limits HERE as well as on the server. Not duplication for its
   * own sake: reading a 4 GB file into memory and base64-ing it before the
   * server says no would hang the app for a minute and then fail. Refusing
   * up front is both faster and a better message.
   */
  async addFiles(files: readonly FileLike[]): Promise<void> {
    if (!this.attachmentsUnderstood()) {
      this.errorMessage.set(
        'Please confirm that you understand the file will be public before attaching anything.'
      );
      return;
    }

    const limits = this.limits();
    const staged = [...this.attachments()];
    let total = staged.reduce((sum, file) => sum + file.bytes, 0);
    let problem = '';

    for (const file of files) {
      if (staged.length >= limits.maxFiles) {
        problem = `You can attach at most ${limits.maxFiles} files to one report.`;
        break;
      }
      if (file.size > limits.maxFileBytes) {
        problem = `"${file.name}" is too large — the limit is ${Math.round(limits.maxFileBytes / (1024 * 1024))} MB per file.`;
        continue;
      }
      if (total + file.size > limits.maxTotalBytes) {
        problem = `"${file.name}" would take the total over ${Math.round(limits.maxTotalBytes / (1024 * 1024))} MB.`;
        continue;
      }

      staged.push(await this.support.readFile(file));
      total += file.size;
    }

    this.attachments.set(staged);
    this.errorMessage.set(problem);
  }

  /** Take one back out. Indexed, because two files can share a name. */
  removeAttachment(index: number): void {
    this.attachments.set(this.attachments().filter((_, i) => i !== index));
  }

  /**
   * The template's `<input type="file">` handler.
   *
   * Kept to three lines, all of them DOM, so that everything worth testing
   * is in `addFiles`. The input is cleared afterwards so picking the same
   * file twice still fires a change event.
   */
  async onFileInput(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = '';
    if (picked.length > 0) await this.addFiles(picked);
  }

  // ---- Preview ---------------------------------------------------------

  /**
   * Ask the backend to build the report.
   *
   * ATTACHMENT NAMES AND SIZES ONLY go in this request. The content stays in
   * the browser until the user has approved the text — there is no reason
   * for a 20 MB spreadsheet to cross the wire for a preview, and sending it
   * early would mean the bytes had left the page before consent was given.
   */
  async buildPreview(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.errorMessage.set('');

    try {
      const preview = await this.support.preview({
        userDescription: this.description(),
        clientErrors: this.recentErrors.snapshot(),
        attachments: this.attachments().map(file => ({ name: file.name, bytes: file.bytes }))
      });

      this.preview.set(preview);
      this.reportText.set(preview.markdown);
      this.receipt.set(preview.receipt);
      this.applyLimits(preview.limits);
      this.step.set('review');
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  backToDescribe(): void {
    this.step.set('describe');
  }

  // ---- Send ------------------------------------------------------------

  /** A short, useful issue title derived from what the user typed. */
  private issueTitle(): string {
    const firstLine = this.description().trim().split(/\r?\n/)[0]?.trim() ?? '';
    if (firstLine.length === 0) return 'Problem report from Coin Inventory';
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
  }

  /**
   * Write the zip, then open the pre-filled issue.
   *
   * The double-click guard is not cosmetic: `busy` is set synchronously,
   * before the first await. Without that, a double-click writes two zips to
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
      const body = this.reportText();
      const result = await this.support.createBundle(body, this.attachments());

      this.result.set(result);
      this.rejected.set(result.rejected ?? []);

      const preview = this.preview();
      const notes: string[] = [`Saved to ${result.directory} as ${result.fileName}.`];

      if (preview && preview.repositoryConfigured) {
        const plan = planIssueSubmission(preview.repositoryUrl, this.issueTitle(), body);

        if (plan.mode === 'clipboard') {
          const copied = await this.support.copyToClipboard(plan.clipboardText ?? body);
          notes.push(
            copied
              ? 'The report was too long for a link, so it has been copied to your clipboard — paste it into the issue.'
              : 'The report was too long for a link and the clipboard was not available, so please copy it yourself from the box above.'
          );
        }

        notes.push(`Now drag ${result.fileName} from your Desktop into the issue before submitting.`);
        this.support.openIssue(plan.url);
      } else {
        notes.push(
          'No GitHub repository has been configured yet, so nothing was opened. ' +
          'The report file is saved and can be sent on however you like.'
        );
      }

      this.submissionNote.set(notes.join(' '));
      this.step.set('done');
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  close(): void {
    this.closed.emit();
  }
}
