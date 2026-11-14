/**
 * support/report-file.spec.ts — the `.md` file that lands on the Desktop.
 *
 * WHAT IS BEING PINNED DOWN HERE
 *  - Where the file goes. "The Desktop" is not a fixed path on a modern
 *    Windows install: OneDrive Known Folder Move relocates it, and getting
 *    this wrong means telling the user to drag in a file that is not there.
 *  - That it is a PLAIN FILE and not an archive. This module used to build a
 *    zip. The owner's instruction was that the app must not zip anything —
 *    zipping text gains nothing and zipping a JPG hides it, because GitHub
 *    renders a dragged-in image inline and cannot see inside an archive.
 *  - That the text is redacted ON THE WAY TO DISK, not merely by whoever
 *    built it. This endpoint takes markdown from the renderer, so the pass
 *    here is the one that cannot be routed around.
 *  - That the path put in the PUBLIC issue body is redacted, while the path
 *    shown locally and logged is not. Those are two different audiences and
 *    getting them the same way round is the whole point.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  prepareReportFile,
  prepareSupportFiles,
  redactReportPath,
  reportFileName,
  resolveDesktopDirectory,
  writeReportToDesktop,
  writeSupportFile
} from './report-file';

const IDENTITY = {
  username: 'devuser',
  machineName: 'MYSERVER',
  homeDir: 'C:\\Users\\devuser'
};

// Where it goes

describe('resolveDesktopDirectory', () => {
  it('uses the Desktop under the user profile when it is there', () => {
    const exists = (p: string) => p === 'C:\\Users\\dev\\Desktop';
    expect(resolveDesktopDirectory({ USERPROFILE: 'C:\\Users\\dev' }, 'C:\\Users\\dev', exists))
      .toBe('C:\\Users\\dev\\Desktop');
  });

  /**
   * OneDrive Known Folder Move. On a machine where it is on, the real
   * Desktop is C:\Users\dev\OneDrive\Desktop and the profile one either does
   * not exist or is a stub. Telling a user to look on their Desktop for a
   * file that is in the other Desktop is the kind of failure that ends a
   * support conversation before it starts.
   */
  it('falls back to the OneDrive Desktop when the profile one is absent', () => {
    const exists = (p: string) => p === 'C:\\Users\\dev\\OneDrive\\Desktop';
    expect(
      resolveDesktopDirectory(
        { USERPROFILE: 'C:\\Users\\dev', OneDrive: 'C:\\Users\\dev\\OneDrive' },
        'C:\\Users\\dev',
        exists
      )
    ).toBe('C:\\Users\\dev\\OneDrive\\Desktop');
  });

  it('falls back to the home folder when there is no Desktop at all', () => {
    expect(resolveDesktopDirectory({}, '/home/dev', () => false)).toBe('/home/dev');
  });
});

describe('reportFileName', () => {
  it('is dated, sortable and unmistakably ours', () => {
    const name = reportFileName(new Date('2026-11-08T18:04:05.000Z'));
    expect(name).toBe('coin-inventory-problem-report-2026-11-08-180405.md');
  });

  /**
   * NOT .zip. The owner's instruction, and the reason the archive writer was
   * deleted: a zip hides what it holds, and a report is text.
   */
  it('is a plain markdown file, not an archive', () => {
    const name = reportFileName(new Date('2026-11-08T18:04:05.000Z'));
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toMatch(/\.zip$/);
  });

  /**
   * Two reports a few seconds apart is a completely ordinary thing to do —
   * a question comes back, the user reports again. A minute-resolution
   * name would make the second file silently overwrite the first.
   */
  it('two reports seconds apart do not collide', () => {
    const a = reportFileName(new Date('2026-11-08T18:04:00.000Z'));
    const b = reportFileName(new Date('2026-11-08T18:04:01.000Z'));
    expect(a).not.toBe(b);
  });
});

// The text

describe('prepareReportFile', () => {
  it('keeps the report the user approved', () => {
    const { text } = prepareReportFile('## Problem report\n\nit broke\n', IDENTITY);
    expect(text).toContain('it broke');
  });

  /**
   * THE HOLE THIS CLOSES: this module is handed markdown by the renderer. The
   * builder redacts what IT produces, but nothing guarantees the text that
   * arrives here came from the builder. One pass at the point the file is
   * created means no unredacted artefact can exist on disk.
   */
  it('redacts the text on the way to disk, whatever built it', () => {
    const { text } = prepareReportFile(
      'I was looking at C:\\Users\\devuser\\Pictures when it crashed',
      IDENTITY
    );

    expect(text).not.toContain('devuser');
    expect(text).toContain('C:\\Users\\<USER>\\Pictures');
  });

  it('redacts the machine name too', () => {
    const { text } = prepareReportFile(
      'Connecting to SQL Server at MYSERVER\\SQLEXPRESS/CoinInventory',
      IDENTITY
    );

    expect(text).not.toContain('MYSERVER');
    expect(text).toContain('<MACHINE>\\SQLEXPRESS');
  });

  it('returns a receipt that names no values', () => {
    const { receipt } = prepareReportFile(
      'Password=hunter2; and C:\\Users\\devuser\\x',
      IDENTITY
    );

    const asText = JSON.stringify(receipt);
    expect(asText).not.toContain('hunter2');
    expect(asText).not.toContain('devuser');
    expect(asText).toContain('<USER>');
  });

  it('is idempotent on text that is already clean', () => {
    const once = prepareReportFile('C:\\Users\\devuser\\x', IDENTITY).text;
    const twice = prepareReportFile(once, IDENTITY).text;
    expect(twice).toBe(once);
  });
});

// The path that goes into a public issue

/**
 * The plan says the report file's full path goes in the ISSUE BODY, so the
 * user can see where it is while they are on the page that needs it. The
 * issue body is public, and a raw path carries the user name — the one thing
 * every other line of this feature removes. So the body gets the redacted
 * form, which still tells the user everything they need: they know who they
 * are, and the file name is the part they have to recognise.
 */
// The pair: the report and the optional log, redacted together

/**
 * THE SHARED REDACTOR IS A CORRECTNESS REQUIREMENT, NOT AN OPTIMISATION.
 *
 * `createRedactor` allocates placeholders in first-seen order against its own
 * table. Redact the report and the log separately and the same folder can be
 * `<USER2>` in one file and `<USER3>` in the other — at which point the pair
 * is worse than either file alone, because a reader comparing them concludes
 * two different accounts were involved and goes looking for a second person
 * who does not exist.
 *
 * The identity's own `devuser` cannot show this: it is reserved up front and
 * always gets `<USER>` whichever redactor runs. The test therefore uses two
 * STRANGERS, mentioned in opposite orders in the two files, which is exactly
 * the case independent passes would number differently.
 */
describe('prepareSupportFiles', () => {
  const REPORT = 'report: C:\\Users\\alice\\Pictures then C:\\Users\\bob\\Pictures';
  const LOG = 'log: C:\\Users\\bob\\Pictures then C:\\Users\\alice\\Pictures';

  function aliasesIn(text: string): string[] {
    return [...text.matchAll(/Users\\(<USER\d*>)\\/g)].map(m => m[1]);
  }

  it('gives the same path the same placeholder in both files', () => {
    const { reportText, logText } = prepareSupportFiles(REPORT, LOG, IDENTITY);

    const [reportAlice, reportBob] = aliasesIn(reportText);
    const [logBob, logAlice] = aliasesIn(logText!);

    expect(reportAlice).not.toBe(reportBob);
    expect(logAlice).toBe(reportAlice);
    expect(logBob).toBe(reportBob);
  });

  it('redacts the log, not only the report', () => {
    const { logText } = prepareSupportFiles(REPORT, LOG, IDENTITY);

    expect(logText).not.toContain('alice');
    expect(logText).not.toContain('bob');
    expect(logText).toContain('<USER2>');
  });

  /** One submission, one receipt. It covers both files or it is not a receipt. */
  it('returns one receipt counting both files', () => {
    const pair = prepareSupportFiles(REPORT, LOG, IDENTITY);
    const reportOnly = prepareSupportFiles(REPORT, null, IDENTITY);

    const total = (entries: typeof pair.receipt) =>
      entries.reduce((sum, e) => sum + e.occurrences, 0);

    expect(total(pair.receipt)).toBeGreaterThan(total(reportOnly.receipt));
    expect(JSON.stringify(pair.receipt)).not.toContain('alice');
  });

  /** No log asked for means no log text — not an empty string to write. */
  it('returns null for the log when none was requested', () => {
    const { logText, reportText } = prepareSupportFiles(REPORT, null, IDENTITY);

    expect(logText).toBeNull();
    expect(reportText).toContain('<USER2>');
  });

  /** The single-file wrapper the write endpoint used before still agrees. */
  it('matches prepareReportFile for the report alone', () => {
    expect(prepareSupportFiles(REPORT, null, IDENTITY).reportText)
      .toBe(prepareReportFile(REPORT, IDENTITY).text);
  });
});

describe('redactReportPath', () => {
  it('replaces the user name in a path bound for a public issue', () => {
    const redacted = redactReportPath(
      'C:\\Users\\devuser\\Desktop\\coin-inventory-problem-report-2026-11-08-180405.md',
      IDENTITY
    );

    expect(redacted).not.toContain('devuser');
    expect(redacted).toContain('<USER>');
  });

  it('keeps the file name, which is the part the user has to find', () => {
    const redacted = redactReportPath(
      'C:\\Users\\devuser\\Desktop\\coin-inventory-problem-report-2026-11-08-180405.md',
      IDENTITY
    );

    expect(redacted).toContain('coin-inventory-problem-report-2026-11-08-180405.md');
    expect(redacted).toContain('Desktop');
  });
});

// Actually writing it

describe('writeReportToDesktop', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-desktop-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a real file and reports where it put it', () => {
    const result = writeReportToDesktop(dir, '## Problem report\n', new Date('2026-11-08T18:04:00Z'));

    expect(fs.existsSync(result.path)).toBe(true);
    expect(path.dirname(result.path)).toBe(dir);
    expect(result.fileName).toBe('coin-inventory-problem-report-2026-11-08-180400.md');
    expect(result.bytes).toBeGreaterThan(0);
  });

  /** Readable in Notepad, with no extraction step. That is the whole change. */
  it('writes the text as plain readable UTF-8, not an archive', () => {
    const result = writeReportToDesktop(dir, '## Problem report\n\nit broke\n', new Date());

    expect(fs.readFileSync(result.path, 'utf8')).toBe('## Problem report\n\nit broke\n');
    expect(fs.readFileSync(result.path).subarray(0, 2).toString('latin1')).not.toBe('PK');
  });

  it('creates the directory if it is somehow missing', () => {
    const nested = path.join(dir, 'Desktop');
    const result = writeReportToDesktop(nested, 'x', new Date());
    expect(fs.existsSync(result.path)).toBe(true);
  });

  /**
   * The log file goes out through the same writer under a name the caller
   * chose. The caller names it because both files of one submission must
   * share a timestamp, and deciding the name in the writer would mean two
   * `new Date()` calls and a pair that occasionally disagrees by a second.
   */
  it('writes a second file beside the report, under the name it was given', () => {
    const report = writeReportToDesktop(dir, '## report\n', new Date('2026-11-13T18:04:05Z'));
    const log = writeSupportFile(dir, 'coin-inventory-log-2026-11-13-180405.txt', 'a log line\n');

    expect(fs.readdirSync(dir).sort()).toEqual([
      'coin-inventory-log-2026-11-13-180405.txt',
      'coin-inventory-problem-report-2026-11-13-180405.md'
    ]);
    expect(fs.readFileSync(log.path, 'utf8')).toBe('a log line\n');
    expect(path.dirname(report.path)).toBe(path.dirname(log.path));
  });
});

// Canary

describe('canary: a marker does not reach the written file', () => {
  const CANARY = 'CANARYLEAK7391';

  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-desktop-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is absent from the bytes on disk', () => {
    const identity = { username: `user${CANARY}`, machineName: `pc${CANARY}` };

    const { text } = prepareReportFile(
      `crashed in C:\\Users\\user${CANARY}\\Pictures while talking to pc${CANARY}\\SQLEXPRESS`,
      identity
    );
    const written = writeReportToDesktop(dir, text, new Date());

    expect(fs.readFileSync(written.path, 'latin1')).not.toContain(CANARY);
  });

  it('is absent from the receipt', () => {
    const identity = { username: `user${CANARY}`, machineName: `pc${CANARY}` };

    const { receipt } = prepareReportFile(
      `Password=${CANARY}; signed in as user${CANARY}`,
      identity
    );

    expect(JSON.stringify(receipt)).not.toContain(CANARY);
  });

  it('is absent from the path that goes into the public issue', () => {
    const identity = { username: `user${CANARY}`, machineName: `pc${CANARY}` };

    const redacted = redactReportPath(
      `C:\\Users\\user${CANARY}\\Desktop\\coin-inventory-problem-report-2026-11-08-180405.md`,
      identity
    );

    expect(redacted).not.toContain(CANARY);
  });
});
