/**
 * support/log-file.spec.ts — the second file, and the caps on it.
 *
 * WHAT IS BEING PROTECTED HERE
 * This file exists because removing the zip left the raw `app.log` as the
 * only log a user could drag into a PUBLIC issue, and that one has never been
 * through the redactor. So the properties below are safety properties:
 *
 *  - it is capped, and says out loud when it dropped lines, because a
 *    silently truncated log is worse than a short one;
 *  - it says, in its own first paragraph, that it has been redacted and that
 *    its placeholders mean the same thing as the report's — someone finding
 *    this file on an issue has no other way to know either;
 *  - it is named from the same instant as the report, so the pair is a pair.
 *
 * THE REDACTION IS NOT TESTED HERE, ON PURPOSE. This module deliberately
 * renders UNREDACTED text and hands it to `prepareSupportFiles`, which
 * redacts it with the report's own redactor. The canary for the written file
 * lives in routes/support/support.spec.ts, where the real pass runs; the
 * shared-instance property is in report-file.spec.ts.
 */

import { describe, it, expect } from 'vitest';

import { LOG_FILE_LIMITS, logFileName, renderLogFile } from './log-file';
import { reportFileName } from './report-file';

const WHEN = new Date('2026-11-13T18:04:05.000Z');

function context(overrides: Partial<Parameters<typeof renderLogFile>[1]> = {}) {
  return {
    generatedAt: WHEN,
    reportFileName: 'coin-inventory-problem-report-2026-11-13-180405.md',
    ...overrides
  };
}

describe('logFileName', () => {
  it('is dated, sortable and unmistakably ours', () => {
    expect(logFileName(WHEN)).toBe('coin-inventory-log-2026-11-13-180405.txt');
  });

  /**
   * `.txt`, not `.log` or `.zip`: GitHub's attachment allow-list takes it and
   * Windows opens it in Notepad without asking which program to use.
   */
  it('is a plain text file, not an archive', () => {
    expect(logFileName(WHEN)).toMatch(/\.txt$/);
    expect(logFileName(WHEN)).not.toMatch(/\.zip$/);
  });

  /**
   * THE PAIR IS A PAIR. A Desktop can easily hold three reports; if the two
   * files of one submission carried different stamps the user would have to
   * guess which log went with which report.
   */
  it('carries the same timestamp as the report written beside it', () => {
    const stamp = /(\d{4}-\d{2}-\d{2}-\d{6})/;
    expect(logFileName(WHEN).match(stamp)![1]).toBe(reportFileName(WHEN).match(stamp)![1]);
  });

  /** Seconds, not minutes: two reports in a row must not overwrite one file. */
  it('two logs seconds apart do not collide', () => {
    const first = logFileName(new Date('2026-11-13T18:04:05.000Z'));
    const second = logFileName(new Date('2026-11-13T18:04:41.000Z'));
    expect(first).not.toBe(second);
  });
});

describe('renderLogFile', () => {
  it('carries the log lines, in order', () => {
    const text = renderLogFile(['first line', 'second line', 'third line'], context());

    expect(text).toContain('first line');
    expect(text).toContain('third line');
    expect(text.indexOf('first line')).toBeLessThan(text.indexOf('third line'));
  });

  /**
   * Somebody finding this file on a public issue has no other way to know it
   * was scrubbed — and no way to know that a `<USER>` in it is the same
   * `<USER>` as in the report. Both facts have to be in the file.
   */
  it('says it is redacted and that its placeholders match the report’s', () => {
    const text = renderLogFile(['a line'], context());

    expect(text).toMatch(/REDACTED/);
    expect(text).toMatch(/same placeholder table/i);
    expect(text).toContain('coin-inventory-problem-report-2026-11-13-180405.md');
  });

  it('says plainly that nothing was uploaded', () => {
    expect(renderLogFile(['a line'], context())).toMatch(/nothing was uploaded/i);
  });

  /**
   * THE CAP IS NOT NEGOTIABLE AND NEITHER IS SAYING SO. A file too big to
   * send is indistinguishable from one never sent; a quietly shortened one is
   * worse, because the reader cannot tell what is missing.
   */
  it('keeps only the most recent lines and says how many it dropped', () => {
    const lines = Array.from({ length: LOG_FILE_LIMITS.maxLines + 7 }, (_, i) => `line ${i}`);

    const text = renderLogFile(lines, context());

    expect(text).not.toContain('line 0\n');
    expect(text).toContain(`line ${LOG_FILE_LIMITS.maxLines + 6}`);
    expect(text).toMatch(/7 earlier lines were not included/);
  });

  it('does not claim to have dropped anything when it has not', () => {
    expect(renderLogFile(['one', 'two'], context())).not.toMatch(/earlier line/);
  });

  /**
   * One serialised HttpErrorResponse or base64 image on a single line would
   * otherwise spend the whole budget on one entry.
   */
  it('clamps an absurd line and says it did, rather than dropping it', () => {
    const monster = 'x'.repeat(LOG_FILE_LIMITS.maxLineChars + 500);

    const text = renderLogFile([monster], context());

    expect(text).not.toContain(monster);
    expect(text).toContain('[500 more characters]');
  });

  it('says so rather than looking broken when there is no log at all', () => {
    const text = renderLogFile([], context());

    expect(text).toMatch(/No log lines were available/i);
    expect(text).toMatch(/Coin Inventory/);
  });

  /**
   * It renders what it is given, unredacted, because the caller redacts it
   * with the REPORT'S redactor. If this module ever started redacting on its
   * own, the two files would disagree about placeholders — so the absence of
   * redaction here is a property worth pinning, not an oversight.
   */
  it('does not redact — that is the shared pass’s job, one step later', () => {
    const text = renderLogFile(['signed in as devuser'], context());
    expect(text).toContain('signed in as devuser');
  });
});
