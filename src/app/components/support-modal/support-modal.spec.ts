/**
 * support-modal.spec.ts — the consent flow.
 *
 * WHAT IS ACTUALLY BEING TESTED
 * The redaction has its own canaries on the server. What this dialog is
 * responsible for is CONSENT, and consent is a sequence:
 *
 *   1. nothing is attached that the user did not pick, file by file;
 *   2. the blunt warning is not decorative — the file picker does not work
 *      until it has been acknowledged;
 *   3. the user sees the actual text, editable, before anything is written;
 *   4. the text that goes out is the text they approved, including edits;
 *   5. if the link is too long, the body goes to the clipboard and the user
 *      is TOLD, rather than the report being silently truncated.
 *
 * Every one of those is a thing that could be implemented backwards and
 * still look right on screen.
 *
 * NO DOM HERE
 * The frontend suite runs under Node with no jsdom, so there is no `File`
 * and no `document`. The component is therefore written so that every
 * decision happens in a method that takes plain data — `addFiles` takes
 * `FileLike`, not a FileList — and the only DOM in the whole feature lives
 * behind SupportService.openIssue / copyToClipboard, which are stubbed here.
 */

import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SupportModal } from './support-modal';
import { RecentErrorsService } from '../../services/support/recent-errors.service';
import {
  BundleResult,
  ChosenAttachment,
  FileLike,
  SupportPreview,
  SupportService
} from '../../services/support/support.service';

function previewResponse(overrides: Partial<SupportPreview> = {}): SupportPreview {
  return {
    markdown: '## Problem report\n\nenvironment etc\n',
    receipt: [{ placeholder: '<USER>', what: 'your Windows user name', occurrences: 3 }],
    outputDirectory: 'C:\\Users\\dev\\Desktop',
    repositoryUrl: 'https://github.com/owner/coin-inventory',
    repositoryConfigured: true,
    limits: { maxFiles: 10, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024 },
    ...overrides
  };
}

function bundleResponse(overrides: Partial<BundleResult> = {}): BundleResult {
  return {
    path: 'C:\\Users\\dev\\Desktop\\coin-inventory-problem-report-2026-11-08-180405.zip',
    fileName: 'coin-inventory-problem-report-2026-11-08-180405.zip',
    directory: 'C:\\Users\\dev\\Desktop',
    bytes: 2048,
    entries: ['report.md', 'logs/recent.log', 'redaction-receipt.txt'],
    receipt: [],
    rejected: [],
    ...overrides
  };
}

/** A stand-in for a browser File. */
function fileLike(name: string, contents: string): FileLike {
  const bytes = new TextEncoder().encode(contents);
  return {
    name,
    size: bytes.length,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  };
}

interface Harness {
  modal: SupportModal;
  support: {
    preview: ReturnType<typeof vi.fn>;
    createBundle: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    copyToClipboard: ReturnType<typeof vi.fn>;
    openIssue: ReturnType<typeof vi.fn>;
  };
  recent: RecentErrorsService;
}

function createModal(): Harness {
  const recent = new RecentErrorsService();

  const support = {
    preview: vi.fn().mockResolvedValue(previewResponse()),
    createBundle: vi.fn().mockResolvedValue(bundleResponse()),
    readFile: vi.fn(async (file: FileLike): Promise<ChosenAttachment> => ({
      name: file.name,
      bytes: file.size,
      contentBase64: 'AAAA'
    })),
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

let h: Harness;
beforeEach(() => {
  h = createModal();
});

// ---- Step 1 — describing the problem ----

describe('the first step', () => {
  it('opens on the description step with nothing attached', () => {
    expect(h.modal.step()).toBe('describe');
    expect(h.modal.attachments()).toEqual([]);
  });

  it('nothing is attached by default — there is no automatic collection', () => {
    expect(h.modal.attachments()).toHaveLength(0);
    expect(h.modal.attachmentsUnderstood()).toBe(false);
  });
});

// ---- Attaching the user's own files ----

describe('attaching a file', () => {
  /**
   * THE WARNING IS NOT DECORATION. A real QIF export can carry stock
   * holdings, retirement accounts, a street address and private company
   * names. A user attaching "just my QIF" to a public issue is publishing
   * all of it without knowing. The picker stays shut until they have said
   * they understand.
   */
  it('refuses to accept a file before the warning is acknowledged', async () => {
    await h.modal.addFiles([fileLike('GoldCoins.QIF', '!Type:Invst')]);

    expect(h.modal.attachments()).toEqual([]);
    expect(h.modal.errorMessage()).toMatch(/confirm|understand/i);
  });

  it('accepts a file once the warning is acknowledged', async () => {
    h.modal.attachmentsUnderstood.set(true);
    await h.modal.addFiles([fileLike('GoldCoins.QIF', '!Type:Invst')]);

    expect(h.modal.attachments().map(a => a.name)).toEqual(['GoldCoins.QIF']);
  });

  it('adds files one at a time, cumulatively', async () => {
    h.modal.attachmentsUnderstood.set(true);
    await h.modal.addFiles([fileLike('a.qif', 'a')]);
    await h.modal.addFiles([fileLike('b.xlsx', 'b')]);

    expect(h.modal.attachments().map(a => a.name)).toEqual(['a.qif', 'b.xlsx']);
  });

  it('lets the user take one back out', async () => {
    h.modal.attachmentsUnderstood.set(true);
    await h.modal.addFiles([fileLike('a.qif', 'a'), fileLike('b.qif', 'b')]);

    h.modal.removeAttachment(0);

    expect(h.modal.attachments().map(a => a.name)).toEqual(['b.qif']);
  });

  it('un-ticking the warning clears everything already attached', async () => {
    // Withdrawing consent has to actually withdraw it. Leaving the files
    // staged with the box un-ticked would mean the UI says one thing and
    // the payload says another.
    h.modal.attachmentsUnderstood.set(true);
    await h.modal.addFiles([fileLike('a.qif', 'a')]);

    h.modal.setAttachmentsUnderstood(false);

    expect(h.modal.attachments()).toEqual([]);
  });

  it('rejects a file bigger than the server will take, before sending it', async () => {
    h.modal.attachmentsUnderstood.set(true);
    h.modal.applyLimits(previewResponse().limits);

    const huge: FileLike = {
      name: 'huge.xlsx',
      size: 11 * 1024 * 1024,
      arrayBuffer: async () => new ArrayBuffer(0)
    };
    await h.modal.addFiles([huge]);

    expect(h.modal.attachments()).toEqual([]);
    expect(h.modal.errorMessage()).toMatch(/too large/i);
  });

  it('refuses more files than the limit allows', async () => {
    h.modal.attachmentsUnderstood.set(true);
    h.modal.applyLimits({ maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 4096 });

    await h.modal.addFiles([fileLike('a', 'a'), fileLike('b', 'b'), fileLike('c', 'c')]);

    expect(h.modal.attachments()).toHaveLength(2);
    expect(h.modal.errorMessage()).toMatch(/at most 2|only 2/i);
  });
});

// ---- Step 2 — the preview ----

describe('building the preview', () => {
  it('sends the description, the recent errors and the attachment names', async () => {
    h.recent.record('saving failed');
    h.modal.description.set('It crashes on export');
    h.modal.attachmentsUnderstood.set(true);
    await h.modal.addFiles([fileLike('GoldCoins.QIF', '!Type:Invst')]);

    await h.modal.buildPreview();

    expect(h.support.preview).toHaveBeenCalledWith({
      userDescription: 'It crashes on export',
      clientErrors: [expect.objectContaining({ message: 'saving failed' })],
      attachments: [{ name: 'GoldCoins.QIF', bytes: 11 }]
    });
  });

  it('sends the attachment NAME and SIZE only, never its content', async () => {
    h.modal.attachmentsUnderstood.set(true);
    await h.modal.addFiles([fileLike('GoldCoins.QIF', '!Type:Invst')]);
    await h.modal.buildPreview();

    const sent = h.support.preview.mock.calls[0][0];
    expect(JSON.stringify(sent)).not.toContain('contentBase64');
    expect(JSON.stringify(sent)).not.toContain('!Type:Invst');
  });

  it('moves to the review step and shows the text', async () => {
    await h.modal.buildPreview();

    expect(h.modal.step()).toBe('review');
    expect(h.modal.reportText()).toContain('## Problem report');
  });

  it('shows the receipt so the user knows what was replaced', async () => {
    await h.modal.buildPreview();
    expect(h.modal.receipt()[0].placeholder).toBe('<USER>');
  });

  it('stays put and explains itself when the preview fails', async () => {
    h.support.preview.mockRejectedValue(new Error('backend is down'));

    await h.modal.buildPreview();

    expect(h.modal.step()).toBe('describe');
    expect(h.modal.errorMessage()).toContain('backend is down');
  });

  it('clears a previous error when a retry succeeds', async () => {
    h.support.preview.mockRejectedValueOnce(new Error('backend is down'));
    await h.modal.buildPreview();
    await h.modal.buildPreview();

    expect(h.modal.errorMessage()).toBe('');
    expect(h.modal.step()).toBe('review');
  });

  it('can go back to editing the description', async () => {
    await h.modal.buildPreview();
    h.modal.backToDescribe();
    expect(h.modal.step()).toBe('describe');
  });
});

// ---- Step 3 — writing the file and opening the issue ----

describe('sending the report', () => {
  beforeEach(async () => {
    await h.modal.buildPreview();
  });

  /** The preview is editable. Sending anything else would make it theatre. */
  it('sends the text the user edited, not the text we generated', async () => {
    h.modal.reportText.set('## Problem report\n\nI removed the bit I did not like\n');

    await h.modal.sendReport();

    expect(h.support.createBundle).toHaveBeenCalledWith(
      '## Problem report\n\nI removed the bit I did not like\n',
      []
    );
  });

  it('sends the chosen attachments with their content', async () => {
    h.modal.backToDescribe();
    h.modal.attachmentsUnderstood.set(true);
    await h.modal.addFiles([fileLike('a.qif', 'abc')]);
    await h.modal.buildPreview();

    await h.modal.sendReport();

    expect(h.support.createBundle.mock.calls[0][1]).toEqual([
      { name: 'a.qif', bytes: 3, contentBase64: 'AAAA' }
    ]);
  });

  it('reports where the file was written', async () => {
    await h.modal.sendReport();

    expect(h.modal.step()).toBe('done');
    expect(h.modal.result()!.fileName).toContain('coin-inventory-problem-report-');
  });

  it('opens the pre-filled issue in the browser', async () => {
    await h.modal.sendReport();

    expect(h.support.openIssue).toHaveBeenCalledTimes(1);
    expect(h.support.openIssue.mock.calls[0][0]).toContain('/issues/new?');
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
    h.modal.reportText.set('x'.repeat(30_000));

    await h.modal.sendReport();

    expect(h.support.copyToClipboard).toHaveBeenCalledWith('x'.repeat(30_000));
    expect(h.modal.submissionNote()).toMatch(/clipboard/i);
    expect(h.support.openIssue).toHaveBeenCalledTimes(1);
  });

  it('says so when the clipboard itself was refused', async () => {
    h.modal.reportText.set('x'.repeat(30_000));
    h.support.copyToClipboard.mockResolvedValue(false);

    await h.modal.sendReport();

    expect(h.modal.submissionNote()).toMatch(/copy it yourself|could not copy/i);
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
    h.support.preview.mockResolvedValue(previewResponse({ repositoryConfigured: false }));
    await h.modal.buildPreview();

    await h.modal.sendReport();

    expect(h.support.openIssue).not.toHaveBeenCalled();
    expect(h.modal.step()).toBe('done');
    expect(h.modal.submissionNote()).toMatch(/saved/i);
    expect(h.modal.submissionNote()).toContain('Desktop');
  });

  it('surfaces attachments the server had to turn away', async () => {
    h.support.createBundle.mockResolvedValue(
      bundleResponse({ rejected: [{ name: 'huge.bin', reason: 'too large' }] })
    );

    await h.modal.sendReport();

    expect(h.modal.rejected()).toEqual([{ name: 'huge.bin', reason: 'too large' }]);
  });

  it('stays on the review step and explains itself when writing fails', async () => {
    h.support.createBundle.mockRejectedValue(new Error('disk is full'));

    await h.modal.sendReport();

    expect(h.modal.step()).toBe('review');
    expect(h.modal.errorMessage()).toContain('disk is full');
    expect(h.support.openIssue).not.toHaveBeenCalled();
  });

  it('cannot be submitted twice by double-clicking', async () => {
    // `busy` is what the template disables the button on; without it a
    // double-click writes two files and opens two browser tabs.
    const first = h.modal.sendReport();
    const second = h.modal.sendReport();
    await Promise.all([first, second]);

    expect(h.support.createBundle).toHaveBeenCalledTimes(1);
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
