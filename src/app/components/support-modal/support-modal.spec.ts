/**
 * SupportModal: what the user is told will be sent, that the shown text is the
 * sent text, nothing is written before submit, the clipboard fallback for long
 * reports, and the GitHub link (never to the unconfigured placeholder).
 * Runs under Node without jsdom; browser APIs are stubbed on SupportService.
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
    // Like the real endpoint, reports a log file only when one was requested.
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

/** Makes each build distinguishable, like the real server's `generatedAt`. */
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
    expect(h.support.preview).not.toHaveBeenCalled();
    expect(h.modal.reportText()).toBe('');
  });

  it('reads the repository settings on open, without building a report', async () => {
    await h.modal.configReady;

    expect(h.support.config).toHaveBeenCalledTimes(1);
    expect(h.support.preview).not.toHaveBeenCalled();
  });
});

// ---- What the user is told will be sent ----

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

  it('says none of the user\u2019s own files go, and that the app cannot send one', () => {
    const summary = h.modal.includedSummary().join(' ');

    expect(summary).toMatch(/none of your own files/i);
    expect(summary).toMatch(/cannot attach or upload/i);
  });
});

// ---- "Include recent log" ----

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

  it('says plainly that NO log lines go when it is unticked', () => {
    h.modal.includeLog.set(false);
    const summary = h.modal.includedSummary().join(' ');

    expect(summary).toMatch(/no log lines at all/i);
    expect(summary).toMatch(/no log file is written/i);
  });

  it('still owns up to the log file names and sizes when unticked', () => {
    h.modal.includeLog.set(false);
    expect(h.modal.includedSummary().join(' ')).toMatch(/names and sizes/i);
  });

  // The checkbox changes the report body, so a cached build must not be reused.
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

  // The issue is public, so only redacted paths may appear in it.
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

  it('believes the server, not the checkbox, about what was written', async () => {
    h.modal.includeLog.set(true);
    h.support.saveReport.mockResolvedValue(savedResponse({ log: null }));

    await h.modal.sendReport();

    expect(h.modal.savedLog()).toBeNull();
    expect(h.modal.submissionNote()).not.toMatch(/coin-inventory-log-/);
  });
});

// ---- The GitHub link ----

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

  // The shipped placeholder repository would 404.
  it('offers NO link while the repository is the shipped placeholder', async () => {
    const harness = createModal({ repositoryConfigured: false });
    await harness.modal.configReady;

    expect(harness.modal.issuePageLink()).toBe('');
    expect(harness.modal.doneLink()).toBe('');
  });

  // A settings read failure is reported separately from "no repository configured".
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

  // The log is read on the server; the browser never sends log content.
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

  it('puts the report file\u2019s full path in the issue body', async () => {
    await h.modal.sendReport();

    const body = decodeURIComponent(h.support.openIssue.mock.calls[0][0]);
    expect(body).toContain('coin-inventory-problem-report-2026-11-08-180405.md');
    expect(body).toContain('Desktop');
  });

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

  it('says plainly that nothing was uploaded', async () => {
    await h.modal.sendReport();

    expect(h.modal.submissionNote()).toMatch(/nothing was uploaded/i);
  });

  it('tells the user to drag the file in — GitHub has no attachment API', async () => {
    await h.modal.sendReport();
    expect(h.modal.submissionNote()).toMatch(/drag/i);
  });

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

  it('does not open a browser when no repository has been configured', async () => {
    const harness = createModal({ repositoryConfigured: false });

    await harness.modal.sendReport();

    expect(harness.support.openIssue).not.toHaveBeenCalled();
    expect(harness.modal.step()).toBe('done');
    expect(harness.modal.submissionNote()).toMatch(/saved/i);
    expect(harness.modal.submissionNote()).toMatch(/no github repository has been configured/i);
  });

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
    // `busy` is set synchronously before the first await.
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
 * Template checks on the source text (no DOM available). Comments are
 * stripped first so only markup can satisfy the assertions.
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

  it('renders the repository as a real anchor on the describe step', () => {
    expect(TEMPLATE).toContain('[href]="issuePageLink()"');
    expect(TEMPLATE).toContain('{{ issuePageLink() }}');
  });

  it('renders a real anchor on the done step too', () => {
    expect(TEMPLATE).toContain('[href]="doneLink()"');
  });

  it('guards both links on there being something safe to link to', () => {
    expect(TEMPLATE).toContain('@if (issuePageLink())');
    expect(TEMPLATE).toContain('@if (doneLink())');
  });

  it('says on the describe step that files are dragged in on GitHub', () => {
    expect(TEMPLATE).toMatch(/dragging them into the issue/i);
    expect(TEMPLATE).toMatch(/display inline/i);
  });

  it('still carries the blunt warning about public issues', () => {
    expect(TEMPLATE).toContain('class="support-warning"');
    expect(TEMPLATE).toMatch(/public/);
    expect(TEMPLATE).toMatch(/stock holdings/i);
  });

  // The app cannot upload, so there must be no file input.
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

  it('offers "Include recent log" as a real checkbox bound both ways', () => {
    expect(TEMPLATE).toContain('type="checkbox"');
    expect(TEMPLATE).toContain('[ngModel]="includeLog()"');
    expect(TEMPLATE).toContain('includeLog.set($event)');
    expect(TEMPLATE).toMatch(/Include recent log/);
  });

  it('the checkbox did not bring a file picker back with it', () => {
    expect(TEMPLATE).not.toContain('type="file"');
  });

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
    expect(TEMPLATE).not.toContain('reportText.set(');
  });

  it('states on the done step that nothing was uploaded', () => {
    expect(TEMPLATE).toMatch(/Nothing was uploaded/);
  });

  it('never mentions a zip as something the app produces', () => {
    expect(TEMPLATE).not.toMatch(/\.zip/);
    expect(TEMPLATE).not.toContain('bundle');
  });
});
