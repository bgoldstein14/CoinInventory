/**
 * The optional log file: capped and says what it dropped, states that it is
 * redacted and its placeholders match the report's, and shares the report's
 * timestamp. Redaction itself is tested in routes/support/support.spec.ts and
 * report-file.spec.ts, since this module renders unredacted text.
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

  /** `.txt`: accepted by GitHub and opened by Notepad. */
  it('is a plain text file, not an archive', () => {
    expect(logFileName(WHEN)).toMatch(/\.txt$/);
    expect(logFileName(WHEN)).not.toMatch(/\.zip$/);
  });

  /** Same stamp as the report, so the pair is recognisable. */
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

  /** The file itself must say it was scrubbed and that placeholders match the report's. */
  it('says it is redacted and that its placeholders match the report’s', () => {
    const text = renderLogFile(['a line'], context());

    expect(text).toMatch(/REDACTED/);
    expect(text).toMatch(/same placeholder table/i);
    expect(text).toContain('coin-inventory-problem-report-2026-11-13-180405.md');
  });

  it('says plainly that nothing was uploaded', () => {
    expect(renderLogFile(['a line'], context())).toMatch(/nothing was uploaded/i);
  });

  /** Capped, and says how many lines were dropped. */
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

  /** One huge line (e.g. base64) mustn't use the whole budget. */
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

  /** Unredacted by design: the caller redacts with the report's redactor. */
  it('does not redact — that is the shared pass’s job, one step later', () => {
    const text = renderLogFile(['signed in as devuser'], context());
    expect(text).toContain('signed in as devuser');
  });
});
