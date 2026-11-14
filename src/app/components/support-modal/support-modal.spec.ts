/**
 * support-modal.spec.ts — the consent flow.
 *
 * WHAT IS ACTUALLY BEING TESTED
 * The redaction has its own canaries on the server. What this dialog is
 * responsible for is CONSENT, and consent here means:
 *
 *   1. the user is told, in sentences they can act on, what is going to be
 *      sent — including the live error count — before anything is written;
 *   2. the exact text remains available to anyone who wants it, and what it
 *      shows is byte for byte what gets written;
 *   3. nothing is written until the submit button is pressed, once;
 *   4. if the link is too long, the body goes to the clipboard and the user
 *      is TOLD, rather than the report being silently truncated;
 *   5. the user is given the repository as a REAL CLICKABLE LINK, on both
 *      steps — and never a link to the shipped placeholder, which is a 404;
 *   6. the done screen says plainly that nothing was uploaded.
 *
 * Every one of those is a thing that could be implemented backwards and
 * still look right on screen.
 *
 * THE FILE PICKER IS GONE, AND SO ARE ITS TESTS
 * This file used to carry a whole `describe('attaching a file')` block: the
 * warning gating the picker, the staging list, the per-file and total caps,
 * un-ticking discarding staged files, and the rejected-files report. All of
 * it was DELETED rather than softened, because the feature underneath it was
 * deleted. The app cannot upload to GitHub and no longer builds a zip, so a
 * staged file had nowhere to go; a picker that collects files and drops them
 * is worse than none. What those tests protected that still exists — that
 * nothing of the user's goes anywhere without them doing it, and that they
 * are warned before they do — is covered below and in the template grep.
 *
 * THE REVIEW STEP IS GONE ON PURPOSE
 * There used to be a mandatory middle step holding the generated Markdown in
 * an editable textarea. The tests that asserted the user was *forced* through
 * it were deleted with it; the tests for what it protected — the receipt, the
 * ability to see the real text, the text sent being the text shown — were
 * kept and moved onto the optional disclosure.
 *
 * NO DOM HERE
 * The frontend suite runs under Node with no jsdom, so there is no `document`
 * and nothing can render. The component is therefore written so that every
 * decision happens in a method that takes plain data, and the only DOM in the
 * whole feature lives behind SupportService.openIssue / copyToClipboard,
 * which are stubbed here. The handful of things that live only in the
 * template are checked by the source grep at the bottom, which is the only
 * instrument available.
 */

import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SupportModal } from './support-modal';
import { RecentErrorsService } from '../../services/support/recent-errors.service';
import {
  SavedLogFile,
  SavedReport,
  SupportConfig,
  SupportPreview,
  SupportService
} from '../../services/support/support.service';

const REPO = 'https://github.com/owner/coin-inventory';

function configResponse(overrides: Partial<SupportConfig> = {}): SupportConfig {
  return {
    repositoryUrl: REPO,
    repositoryConfigured: true,
    outputDirectory: 'C:\\Users\\dev\\Desktop',
    ...overrides
  };
}

function previewResponse(overrides: Partial<SupportPreview> = {}): SupportPreview {
  return {
    markdown: '## Problem report\n\nenvironment etc\n',
    receipt: [{ placeholder: '<USER>', what: 'your Windows user name', occurrences: 3 }],
    ...overrides
  };
}

/**
 * The log file the server says it wrote. Default-ticked, so the default
 * fixture has one — a harness whose default did not would quietly stop
 * exercising the usual path.
 */
function savedLogResponse(overrides: Partial<SavedLogFile> = {}): SavedLogFile {
  return {
    path: 'C:\\Users\\dev\\Desktop\\coin-inventory-log-2026-11-08-180405.txt',
    redactedPath: 'C:\\Users\\<USER>\\Desktop\\coin-inventory-log-2026-11-08-180405.txt',
    fileName: 'coin-inventory-log-2026-11-08-180405.txt',
    bytes: 65536,
    ...overrides
  };
}

function savedResponse(overrides: Partial<SavedReport> = {}): SavedReport {
  return {
    path: 'C:\\Users\\dev\\Desktop\\coin-inventory-problem-report-2026-11-08-180405.md',
    redactedPath: 'C:\\Users\\<USER>\\Desktop\\coin-inventory-problem-report-2026-11-08-180405.md',
    fileName: 'coin-inventory-problem-report-2026-11-08-180405.md',
    directory: 'C:\\Users\\dev\\Desktop',
    bytes: 2048,
    log: savedLogResponse(),
    receipt: [],
    ...overrides
  };
}

interface Harness {
  modal: SupportModal;
  support: {
    config: ReturnType<typeof vi.fn>;
    preview: ReturnType<typeof vi.fn>;
    saveReport: ReturnType<typeof vi.fn>;
    copyToClipboard: ReturnType<typeof vi.fn>;
    openIssue: ReturnType<typeof vi.fn>;
  };
  recent: RecentErrorsService;
}

function createModal(configOverrides: Partial<SupportConfig> = {}): Harness {
  const recent = new RecentErrorsService();

  const support = {
    config: vi.fn().mockResolvedValue(configResponse(configOverrides)),
    preview: vi.fn().mockResolvedValue(previewResponse()),
    // Mirrors the real endpoint's contract: the response describes what was
    // ACTUALLY written, so a stub that always claimed a log file would let
    // the unticked tests pass against a dialog that ignored the checkbox.
    saveReport: vi.fn(async (_markdown: string, includeLog: boolean) =>
      savedResponse({ log: includeLog ? savedLogResponse() : null })
    ),
    copyToClipboard: vi.fn().mockResolvedValue(true),
    openIssue: vi.fn()
  };

  const injector = Injector.create({
    providers: [
      { provide: SupportService, useValue: support },
      { provide: RecentErrorsService, useValue: recent }
    ]
  });

  const modal = runInInjectionContext(injector, () => new SupportModal());
  return { modal, support, recent };
}

/**
 * Makes every build of the report distinguishable, the way the real server's
 * `generatedAt` timestamp does. Any test that cannot tell a reused build from
 * a fresh one is not testing the thing it claims to.
 */
function numberedBuilds(h: Harness): void {
  let build = 0;
  h.support.preview.mockImplementation(async () =>
    previewResponse({ markdown: `## build ${++build}\n` })
  );
}

let h: Harness;
beforeEach(() => {
  h = createModal();
});

// ---- Step 1 — describing the problem ----

describe('the first step', () => {
  it('opens on the description step', () => {
    expect(h.modal.step()).toBe('describe');
  });

  it('builds nothing until the user asks for it', () => {
    // Opening the dialog is not consent to anything, and the report is not
    // free to build: it reads the log and queries the database.
    expect(h.support.preview).not.toHaveBeenCalled();
    expect(h.modal.reportText()).toBe('');
  });

  /**
   * The link has to be on screen BEFORE anything is built, so the settings
   * cannot be a by-product of the preview: building the report to find out a
   * URL would read the log and query the database for nothing.
   */
  it('reads the repository settings on open, without building a report', async () => {
    await h.modal.configReady;

    expect(h.support.config).toHaveBeenCalledTimes(1);
    expect(h.support.preview).not.toHaveBeenCalled();
  });
});

// ---- What the user is told will be sent ----

/**
 * THIS IS THE REPLACEMENT FOR THE MANDATORY MARKDOWN STEP, so it has to say
 * something a person can act on. A summary that said "some diagnostic
 * information" would be worse than the wall of markup it replaced.
 */
describe('the plain-language summary of what will be sent', () => {
  it('says the collection appears as counts only', () => {
    expect(h.modal.includedSummary().join(' ')).toMatch(/counts only/i);
  });

  it('gives the live number of recorded errors, not a vague "any errors"', () => {
    h.recent.record('saving failed');
    h.recent.record('export failed');

    expect(h.modal.includedSummary().join(' ')).toContain('2 error(s)');
  });

  it('mentions the log and what the user typed', () => {
    const summary = h.modal.includedSummary().join(' ');
    expect(summary).toMatch(/log/i);
    expect(summary).toMatch(/typed/i);
  });

  /**
   * Replaces "none of your own files are going unless you pick them below".
   * There is no "below" any more, and the reason is worth stating: the app
   * CANNOT attach anything, so this is not a default the user could change.
   */
  it('says none of the user\u2019s own files go, and that the app cannot send one', () => {
    const summary = h.modal.includedSummary().join(' ');

    expect(summary).toMatch(/none of your own files/i);
    expect(summary).toMatch(/cannot attach or upload/i);
  });
});

// ---- "Include recent log" ----

/**
 * WHY THIS BLOCK IS ABOUT SAFETY AND NOT PREFERENCE
 *
 * Removing the zip removed the only REDACTED log a user could share, leaving
 * the raw `app.log` — account name, machine name, photo paths — as the only
 * thing to hand for a public issue. The checkbox writes a redacted one
 * instead. So the properties here are the ones that make that promise true:
 *
 *  - ticked by default, because this dialog is reached from "Report a
 *    problem" and a log is the most useful thing in a bug report;
 *  - unticked means NO log content, body tail included, or the unticked
 *    state is a half-truth;
 *  - the summary CHANGES, so the state is never ambiguous;
 *  - the log file is named and located as plainly as the report is, and its
 *    path reaches the public issue only in redacted form.
 */
describe('the "Include recent log" choice', () => {
  it('starts ticked, because this dialog is reached from "Report a problem"', () => {
    expect(h.modal.includeLog()).toBe(true);
  });

  it('sends the choice to the builder, both ways', async () => {
    await h.modal.setReportTextVisible(true);
    expect(h.support.preview.mock.calls[0][0].includeLog).toBe(true);

    h.modal.includeLog.set(false);
    await h.modal.setReportTextVisible(true);
    expect(h.support.preview.mock.calls[1][0].includeLog).toBe(false);
  });

  it('sends the choice to the writer', async () => {
    h.modal.includeLog.set(false);
    await h.modal.sendReport();

    expect(h.support.saveReport.mock.calls[0][1]).toBe(false);
  });

  /**
   * THE SUMMARY MUST CHANGE. A "what will be sent" list that reads the same
   * whichever way the box is set leaves the user guessing at the one moment
   * this dialog exists to make unambiguous.
   */
  it('changes what the summary says when it is unticked', () => {
    const ticked = h.modal.includedSummary().join(' ');

    h.modal.includeLog.set(false);
    const unticked = h.modal.includedSummary().join(' ');

    expect(unticked).not.toBe(ticked);
  });

  it('promises a separate log file while it is ticked', () => {
    const summary = h.modal.includedSummary().join(' ');

    expect(summary).toMatch(/log file/i);
    expect(summary).toMatch(/redacted/i);
  });

  /**
   * Specifically "no log lines", not a quieter wording. The user is deciding
   * whether log lines reach a public issue; "a reduced log" would not answer
   * the question they are asking.
   */
  it('says plainly that NO log lines go when it is unticked', () => {
    h.modal.includeLog.set(false);
    const summary = h.modal.includedSummary().join(' ');

    expect(summary).toMatch(/no log lines at all/i);
    expect(summary).toMatch(/no log file is written/i);
  });

  /**
   * The names and sizes still go, and the summary says so. Keeping them
   * silently under a sentence that implies nothing log-related is sent would
   * be the same half-truth in the other direction.
   */
  it('still owns up to the log file names and sizes when unticked', () => {
    h.modal.includeLog.set(false);
    expect(h.modal.includedSummary().join(' ')).toMatch(/names and sizes/i);
  });

  /**
   * THE REPORT IS A DIFFERENT DOCUMENT EITHER WAY, because the body tail
   * goes with the box. A cached build made while it was ticked would show —
   * and then WRITE — 150 log lines the user has since turned off.
   */
  it('rebuilds the report when the box is changed after it was built', async () => {
    numberedBuilds(h);
    await h.modal.setReportTextVisible(true);
    expect(h.modal.reportText()).toBe('## build 1\n');

    h.modal.includeLog.set(false);

    expect(h.modal.reportStale()).toBe(true);
    await h.modal.sendReport();
    expect(h.support.preview).toHaveBeenCalledTimes(2);
    expect(h.support.saveReport.mock.calls[0][0]).toBe('## build 2\n');
  });

  it('says the log file was written, and where, exactly as the report does', async () => {
    await h.modal.sendReport();

    expect(h.modal.savedLog()!.fileName).toBe('coin-inventory-log-2026-11-08-180405.txt');
    expect(h.modal.submissionNote()).toContain('coin-inventory-log-2026-11-08-180405.txt');
    expect(h.modal.submissionNote()).toMatch(/redacted/i);
  });

  it('claims no log file when none was written', async () => {
    h.modal.includeLog.set(false);
    await h.modal.sendReport();

    expect(h.modal.savedLog()).toBeNull();
    expect(h.modal.submissionNote()).not.toMatch(/coin-inventory-log-/);
  });

  /**
   * THE ISSUE BODY IS PUBLIC. The log file's path goes in it for the same
   * reason the report's does — the user is on the GitHub page when they need
   * to find it — and in the same REDACTED form, because a raw
   * `C:\Users\dave\…` would republish the user name every other part of this
   * feature removes.
   */
  it('puts the log file\u2019s REDACTED path in the issue body', async () => {
    h.support.saveReport.mockResolvedValue(
      savedResponse({
        log: savedLogResponse({
          path: 'C:\\Users\\dave\\Desktop\\coin-inventory-log-2026-11-08-180405.txt',
          redactedPath: 'C:\\Users\\<USER>\\Desktop\\coin-inventory-log-2026-11-08-180405.txt'
        })
      })
    );

    await h.modal.sendReport();

    const body = decodeURIComponent(h.support.openIssue.mock.calls[0][0]);
    expect(body).toContain('coin-inventory-log-2026-11-08-180405.txt');
    expect(body).not.toContain('dave');
    expect(body).toContain('<USER>');
  });

  /** A reader of the issue has to know the two files share placeholders. */
  it('tells the issue\u2019s reader the two files were redacted together', async () => {
    await h.modal.sendReport();

    const body = decodeURIComponent(h.support.openIssue.mock.calls[0][0]);
    expect(body).toMatch(/same placeholders/i);
  });

  it('names no log file in the issue body when none was written', async () => {
    h.modal.includeLog.set(false);
    await h.modal.sendReport();

    const body = decodeURIComponent(h.support.openIssue.mock.calls[0][0]);
    expect(body).not.toMatch(/coin-inventory-log-/);
    expect(body).not.toMatch(/Include recent log/);
  });

  /**
   * The dialog reports what the SERVER says it wrote, not what the checkbox
   * asked for. If those ever disagreed, the user would still be told the
   * truth about what is on their own Desktop.
   */
  it('believes the server, not the checkbox, about what was written', async () => {
    h.modal.includeLog.set(true);
    h.support.saveReport.mockResolvedValue(savedResponse({ log: null }));

    await h.modal.sendReport();

    expect(h.modal.savedLog()).toBeNull();
    expect(h.modal.submissionNote()).not.toMatch(/coin-inventory-log-/);
  });
});

// ---- The clickable link: the owner's explicit requirement ----

/**
 * Attaching is a GitHub-side action, and saying so without handing over the
 * address is telling the user to go and find it. The link is offered on the
 * describe step and again when it is done.
 */
describe('the link to GitHub', () => {
  it('offers the new-issue page as a real URL once the settings have loaded', async () => {
    await h.modal.configReady;

    expect(h.modal.issuePageLink()).toBe('https://github.com/owner/coin-inventory/issues/new');
  });

  it('tidies a repository URL that was pasted from a clone command', async () => {
    const harness = createModal({ repositoryUrl: `${REPO}.git` });
    await harness.modal.configReady;

    expect(harness.modal.issuePageLink()).toBe('https://github.com/owner/coin-inventory/issues/new');
  });

  /**
   * LOAD-BEARING, AND KEPT FROM THE OLD BEHAVIOUR. The shipped placeholder is
   * a 404. Linking to it while telling the user their report has been filed
   * leaves them believing they have been heard when they have not.
   */
  it('offers NO link while the repository is the shipped placeholder', async () => {
    const harness = createModal({ repositoryConfigured: false });
    await harness.modal.configReady;

    expect(harness.modal.issuePageLink()).toBe('');
    expect(harness.modal.doneLink()).toBe('');
  });

  /**
   * Not being able to READ the settings is a different fact from there being
   * no repository, and the dialog must not report one as the other. Both
   * produce no link, which is the safe side.
   */
  it('offers no link, and says why, when the settings could not be read', async () => {
    const harness = createModal();
    harness.support.config.mockRejectedValue(new Error('backend is down'));

    const refetched = runInInjectionContext(
      Injector.create({
        providers: [
          { provide: SupportService, useValue: harness.support },
          { provide: RecentErrorsService, useValue: harness.recent }
        ]
      }),
      () => new SupportModal()
    );
    await refetched.configReady;

    expect(refetched.issuePageLink()).toBe('');
    expect(refetched.configFailed()).toBe(true);
  });

  /**
   * The pre-filled issue, so a user whose pop-up blocker ate the tab can
   * simply click it rather than start again.
   */
  it('the done step links to the issue that was actually opened', async () => {
    await h.modal.sendReport();

    expect(h.modal.doneLink()).toContain('/issues/new?');
    expect(h.modal.doneLink()).toBe(h.support.openIssue.mock.calls[0][0]);
  });
});

// ---- The optional "show me the exact text" disclosure ----

describe('showing the exact report text', () => {
  it('builds the report when the disclosure is opened, and shows it', async () => {
    await h.modal.setReportTextVisible(true);

    expect(h.modal.showReportText()).toBe(true);
    expect(h.modal.reportText()).toContain('## Problem report');
    expect(h.modal.loadingReport()).toBe(false);
  });

  it('shows the receipt so the user knows what was replaced', async () => {
    await h.modal.setReportTextVisible(true);
    expect(h.modal.receipt()[0].placeholder).toBe('<USER>');
  });

  it('sends the description and the recent errors', async () => {
    h.recent.record('saving failed');
    h.modal.description.set('It crashes on export');

    await h.modal.setReportTextVisible(true);

    expect(h.support.preview).toHaveBeenCalledWith({
      userDescription: 'It crashes on export',
      clientErrors: [expect.objectContaining({ message: 'saving failed' })],
      includeLog: true
    });
  });

  /**
   * THE WHOLE POINT OF THE DISCLOSURE. A box captioned "the exact report
   * text" that shows a different build from the one that gets written is a
   * lie, and a quiet one — the two differ only in the timestamp and in
   * anything that changed in between.
   */
  it('writes exactly the build it showed', async () => {
    numberedBuilds(h);

    await h.modal.setReportTextVisible(true);
    const shown = h.modal.reportText();

    await h.modal.sendReport();

    expect(shown).toBe('## build 1\n');
    expect(h.support.saveReport.mock.calls[0][0]).toBe(shown);
    expect(h.support.preview).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the user changes something after looking', async () => {
    numberedBuilds(h);
    await h.modal.setReportTextVisible(true);

    h.modal.description.set('…and it only happens on Tuesdays');
    await h.modal.sendReport();

    expect(h.support.preview).toHaveBeenCalledTimes(2);
    expect(h.support.saveReport.mock.calls[0][0]).toBe('## build 2\n');
  });

  it('marks the shown text stale once the inputs no longer match it', async () => {
    await h.modal.setReportTextVisible(true);
    expect(h.modal.reportStale()).toBe(false);

    h.modal.description.set('something new');

    expect(h.modal.reportStale()).toBe(true);
  });

  it('does not rebuild when nothing changed', async () => {
    await h.modal.setReportTextVisible(true);
    await h.modal.setReportTextVisible(false);
    await h.modal.setReportTextVisible(true);

    expect(h.support.preview).toHaveBeenCalledTimes(1);
  });

  it('looking and submitting at the same moment is one build, not two', async () => {
    numberedBuilds(h);

    const looking = h.modal.setReportTextVisible(true);
    const sending = h.modal.sendReport();
    await Promise.all([looking, sending]);

    expect(h.support.preview).toHaveBeenCalledTimes(1);
    expect(h.support.saveReport.mock.calls[0][0]).toBe('## build 1\n');
  });

  it('says so when the report could not be built, and stays put', async () => {
    h.support.preview.mockRejectedValue(new Error('backend is down'));

    await h.modal.setReportTextVisible(true);

    expect(h.modal.errorMessage()).toContain('backend is down');
    expect(h.modal.step()).toBe('describe');
    expect(h.modal.loadingReport()).toBe(false);
  });

  it('keeps an earlier complaint on screen when the box is opened', async () => {
    // errorMessage may be holding something about the user's own last
    // action. Clearing it because somebody looked at the markup would lose
    // a message they have not read yet.
    h.modal.errorMessage.set('Could not save the report file: the disk is full.');

    await h.modal.setReportTextVisible(true);

    expect(h.modal.errorMessage()).toMatch(/disk is full/i);
  });
});

// ---- Step 2 — writing the file and opening the issue ----

describe('sending the report', () => {
  it('builds the report itself when the user never opened the disclosure', async () => {
    await h.modal.sendReport();

    expect(h.support.preview).toHaveBeenCalledTimes(1);
    expect(h.support.saveReport.mock.calls[0][0]).toContain('## Problem report');
  });

  it('writes nothing when the report cannot be built', async () => {
    h.support.preview.mockRejectedValue(new Error('backend is down'));

    await h.modal.sendReport();

    expect(h.support.saveReport).not.toHaveBeenCalled();
    expect(h.support.openIssue).not.toHaveBeenCalled();
    expect(h.modal.step()).toBe('describe');
    expect(h.modal.errorMessage()).toContain('backend is down');
  });

  it('clears a previous error when a retry succeeds', async () => {
    h.support.preview.mockRejectedValueOnce(new Error('backend is down'));
    await h.modal.sendReport();
    await h.modal.sendReport();

    expect(h.modal.errorMessage()).toBe('');
    expect(h.modal.step()).toBe('done');
  });

  /**
   * TWO arguments, and they are the text and the log choice. Nothing else
   * goes: no staged file, no base64, no log lines from the browser. The log
   * is read on the server, so the raw one never passes through here.
   */
  it('sends the report text and the log choice, and nothing else', async () => {
    await h.modal.sendReport();

    const call = h.support.saveReport.mock.calls[0];
    expect(call).toHaveLength(2);
    expect(typeof call[0]).toBe('string');
    expect(typeof call[1]).toBe('boolean');
  });

  it('reports where the file was written', async () => {
    await h.modal.sendReport();

    expect(h.modal.step()).toBe('done');
    expect(h.modal.saved()!.fileName).toMatch(/^coin-inventory-problem-report-.*\.md$/);
  });

  it('opens the pre-filled issue in the browser', async () => {
    await h.modal.sendReport();

    expect(h.support.openIssue).toHaveBeenCalledTimes(1);
    expect(h.support.openIssue.mock.calls[0][0]).toContain('/issues/new?');
  });

  /**
   * The user is on the GitHub page when they need to find that file. A path
   * shown only in a dialog they have since closed is a path they have to
   * remember.
   */
  it('puts the report file\u2019s full path in the issue body', async () => {
    await h.modal.sendReport();

    const body = decodeURIComponent(h.support.openIssue.mock.calls[0][0]);
    expect(body).toContain('coin-inventory-problem-report-2026-11-08-180405.md');
    expect(body).toContain('Desktop');
  });

  /**
   * AND IT IS THE REDACTED PATH. The issue is public; a raw
   * `C:\Users\dave\Desktop\…` would republish the user name that every other
   * part of this feature removes.
   */
  it('puts the REDACTED path in the issue body, never the raw one', async () => {
    h.support.saveReport.mockResolvedValue(
      savedResponse({
        path: 'C:\\Users\\dave\\Desktop\\report.md',
        redactedPath: 'C:\\Users\\<USER>\\Desktop\\report.md'
      })
    );

    await h.modal.sendReport();

    const body = decodeURIComponent(h.support.openIssue.mock.calls[0][0]);
    expect(body).not.toContain('dave');
    expect(body).toContain('<USER>');
  });

  it('tells the user, in the issue itself, to drag files in', async () => {
    await h.modal.sendReport();

    const body = decodeURIComponent(h.support.openIssue.mock.calls[0][0]);
    expect(body).toMatch(/drag/i);
    expect(body).toMatch(/inline/i);
  });

  /** The user pressed a button labelled "open GitHub" and is entitled to know. */
  it('says plainly that nothing was uploaded', async () => {
    await h.modal.sendReport();

    expect(h.modal.submissionNote()).toMatch(/nothing was uploaded/i);
  });

  it('tells the user to drag the file in — GitHub has no attachment API', async () => {
    await h.modal.sendReport();
    expect(h.modal.submissionNote()).toMatch(/drag/i);
  });

  /**
   * The body of a real report is far larger than a URL can carry. The
   * failure mode if this is wrong is silent truncation — a report that
   * looks complete and is not.
   */
  it('falls back to the clipboard when the report is too long for a link', async () => {
    const huge = 'x'.repeat(30_000);
    h.support.preview.mockResolvedValue(previewResponse({ markdown: huge }));

    await h.modal.sendReport();

    expect(h.support.copyToClipboard).toHaveBeenCalledTimes(1);
    expect(h.support.copyToClipboard.mock.calls[0][0]).toContain(huge);
    expect(h.modal.submissionNote()).toMatch(/clipboard/i);
    expect(h.support.openIssue).toHaveBeenCalledTimes(1);
    expect(h.support.openIssue.mock.calls[0][0].length).toBeLessThan(8000);
  });

  /** The footer is part of the submission, so it must survive the fallback. */
  it('the clipboard copy carries the file path too, not just the report', async () => {
    h.support.preview.mockResolvedValue(previewResponse({ markdown: 'x'.repeat(30_000) }));

    await h.modal.sendReport();

    expect(h.support.copyToClipboard.mock.calls[0][0])
      .toContain('coin-inventory-problem-report-2026-11-08-180405.md');
  });

  it('says so when the clipboard itself was refused', async () => {
    h.support.preview.mockResolvedValue(previewResponse({ markdown: 'x'.repeat(30_000) }));
    h.support.copyToClipboard.mockResolvedValue(false);

    await h.modal.sendReport();

    expect(h.modal.submissionNote()).toMatch(/clipboard was not available/i);
    expect(h.modal.submissionNote()).toMatch(/copy/i);
  });

  it('does not use the clipboard for a short report', async () => {
    await h.modal.sendReport();
    expect(h.support.copyToClipboard).not.toHaveBeenCalled();
  });

  /**
   * No repository need be configured. Opening a 404 while saying "we have
   * filed your report" leaves the user believing they have been heard when
   * they have not.
   */
  it('does not open a browser when no repository has been configured', async () => {
    const harness = createModal({ repositoryConfigured: false });

    await harness.modal.sendReport();

    expect(harness.support.openIssue).not.toHaveBeenCalled();
    expect(harness.modal.step()).toBe('done');
    expect(harness.modal.submissionNote()).toMatch(/saved/i);
    expect(harness.modal.submissionNote()).toMatch(/no github repository has been configured/i);
  });

  /**
   * The race the `configReady` await exists for: a user who opens the dialog
   * and submits before the settings have arrived must still get the right
   * answer, not an unconfigured one.
   */
  it('waits for the settings rather than racing them', async () => {
    const harness = createModal();
    let release = (): void => {};
    harness.support.config.mockImplementation(
      () => new Promise<SupportConfig>(resolve => {
        release = () => resolve(configResponse());
      })
    );

    const modal = runInInjectionContext(
      Injector.create({
        providers: [
          { provide: SupportService, useValue: harness.support },
          { provide: RecentErrorsService, useValue: harness.recent }
        ]
      }),
      () => new SupportModal()
    );

    const sending = modal.sendReport();
    release();
    await sending;

    expect(harness.support.openIssue).toHaveBeenCalledTimes(1);
  });

  it('stays on the describe step and explains itself when writing fails', async () => {
    h.support.saveReport.mockRejectedValue(new Error('disk is full'));

    await h.modal.sendReport();

    expect(h.modal.step()).toBe('describe');
    expect(h.modal.errorMessage()).toContain('disk is full');
    expect(h.support.openIssue).not.toHaveBeenCalled();
  });

  it('cannot be submitted twice by double-clicking', async () => {
    // `busy` is what the template disables the button on, and it is set
    // synchronously before the first await; without that a double-click
    // writes two files and opens two browser tabs.
    const first = h.modal.sendReport();
    const second = h.modal.sendReport();
    await Promise.all([first, second]);

    expect(h.support.saveReport).toHaveBeenCalledTimes(1);
    expect(h.support.openIssue).toHaveBeenCalledTimes(1);
  });
});

describe('closing', () => {
  it('emits closed', () => {
    const spy = vi.fn();
    h.modal.closed.subscribe(spy);
    h.modal.close();
    expect(spy).toHaveBeenCalled();
  });
});

// ---- The template ----

/**
 * WHY A GREP AND NOT A REAL TEST
 *
 * No jsdom, so nothing here can render the component. Several of this
 * dialog's promises live only in the template and nowhere else: the submit
 * button is genuinely disabled while a submit is in flight, the report text
 * is shown but not editable, the repository is offered as a genuine `<a
 * href>` rather than prose, and there is no file input anywhere. A source
 * grep is the only instrument available — weak, but it catches the mutation
 * that matters.
 *
 * COMMENTS ARE STRIPPED FIRST. Both files carry long comments quoting the
 * very strings asserted on, and without the stripping the documentation
 * alone would satisfy the test.
 */
describe('the template', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));

  function stripComments(source: string): string {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  const TEMPLATE = stripComments(readFileSync(resolve(HERE, 'support-modal.html'), 'utf8'));

  it('has only the two steps', () => {
    expect(TEMPLATE).toContain("step() === 'describe'");
    expect(TEMPLATE).toContain("step() === 'done'");
    expect(TEMPLATE).not.toContain("'review'");
  });

  /**
   * The owner's explicit ask: a real clickable link, not prose and not a path
   * to retype. An `<a href>` bound to the computed URL is the only thing that
   * satisfies it.
   */
  it('renders the repository as a real anchor on the describe step', () => {
    expect(TEMPLATE).toContain('[href]="issuePageLink()"');
    expect(TEMPLATE).toContain('{{ issuePageLink() }}');
  });

  it('renders a real anchor on the done step too', () => {
    expect(TEMPLATE).toContain('[href]="doneLink()"');
  });

  /**
   * Both anchors are inside an `@if` on the link being non-empty, which is
   * what stops the shipped placeholder ever being rendered as a 404.
   */
  it('guards both links on there being something safe to link to', () => {
    expect(TEMPLATE).toContain('@if (issuePageLink())');
    expect(TEMPLATE).toContain('@if (doneLink())');
  });

  it('says on the describe step that files are dragged in on GitHub', () => {
    expect(TEMPLATE).toMatch(/dragging them into the issue/i);
    expect(TEMPLATE).toMatch(/display inline/i);
  });

  /**
   * THE WARNING SURVIVED THE PICKER. The reason for it — a QIF or spreadsheet
   * carries far more than coins, and the issue is public — is unchanged by
   * who does the attaching.
   */
  it('still carries the blunt warning about public issues', () => {
    expect(TEMPLATE).toContain('class="support-warning"');
    expect(TEMPLATE).toMatch(/public/);
    expect(TEMPLATE).toMatch(/stock holdings/i);
  });

  /**
   * THE PICKER IS GONE AND MUST STAY GONE. A file input that posts nowhere
   * would collect a user's QIF and drop it, which is worse than not asking.
   */
  it('has no file input, no staging list and no size cap', () => {
    expect(TEMPLATE).not.toContain('type="file"');
    expect(TEMPLATE).not.toContain('attachments()');
    expect(TEMPLATE).not.toContain('attachmentsUnderstood');
    expect(TEMPLATE).not.toContain('removeAttachment');
    expect(TEMPLATE).not.toMatch(/\bMB\b/);
  });

  it('disables the submit button while a submit is in flight', () => {
    expect(TEMPLATE).toContain('[disabled]="busy()"');
  });

  it('shows the plain-words summary on the describe step', () => {
    expect(TEMPLATE).toContain('includedSummary()');
  });

  /**
   * The checkbox exists ONLY in the template, so a grep is the only
   * instrument available — but it is enough to catch the mutation that
   * matters: a control bound to nothing, or bound one-way so that clicking
   * it changes nothing in the component.
   */
  it('offers "Include recent log" as a real checkbox bound both ways', () => {
    expect(TEMPLATE).toContain('type="checkbox"');
    expect(TEMPLATE).toContain('[ngModel]="includeLog()"');
    expect(TEMPLATE).toContain('includeLog.set($event)');
    expect(TEMPLATE).toMatch(/Include recent log/);
  });

  /** The one file input that is allowed is no file input. */
  it('the checkbox did not bring a file picker back with it', () => {
    expect(TEMPLATE).not.toContain('type="file"');
  });

  /**
   * The log file is told to the user as plainly as the report is: a sentence
   * and the full path, on the done step. Driven by what the server wrote,
   * so a path on screen is a file that exists.
   */
  it('names the log file and its path on the done step', () => {
    expect(TEMPLATE).toContain('savedLog()');
    expect(TEMPLATE).toContain('logFile.path');
  });

  it('offers the exact text as a disclosure, not as a step', () => {
    expect(TEMPLATE).toContain('setReportTextVisible(');
    expect(TEMPLATE).toContain('reportText()');
    expect(TEMPLATE).toContain('<details');
  });

  it('does not put the report back in an editable box', () => {
    // An editable box that may or may not be what gets sent is worse than
    // no box: `sendReport` sends what the server built, not what is typed.
    expect(TEMPLATE).not.toContain('reportText.set(');
  });

  it('states on the done step that nothing was uploaded', () => {
    expect(TEMPLATE).toMatch(/Nothing was uploaded/);
  });

  /** No zip anywhere: not a file name, not a promise, not a leftover word. */
  it('never mentions a zip as something the app produces', () => {
    expect(TEMPLATE).not.toMatch(/\.zip/);
    expect(TEMPLATE).not.toContain('bundle');
  });
});
