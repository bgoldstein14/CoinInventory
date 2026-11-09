/**
 * log-rotation.spec.ts — the rotation POLICY, tested without a logger.
 *
 * WHY THIS IS A SEPARATE FILE FROM logger.spec.ts
 * Every interesting decision in rotation is arithmetic on file NAMES —
 * "which day is this line for", "which file do I append to now that the
 * current one is full", "which of these may I delete". None of that needs a
 * filesystem, and testing it through the logger would mean writing megabytes
 * to disk to prove a comparison operator. So the policy is pure functions
 * here, and logger.spec.ts tests only that the logger actually obeys them.
 *
 * THE BUG THIS WHOLE MODULE PREVENTS
 * A single unbounded app.log reaches several megabytes and tens of thousands
 * of lines in ordinary use. That is two separate failures:
 *
 *   support  — nobody can attach a 200 MB log to a GitHub issue, so the one
 *              artefact that would explain their bug is the one artefact
 *              they cannot send.
 *   privacy  — every line carries absolute paths, and therefore the Windows
 *              username and the machine name. An unbounded file accumulates
 *              those forever, with no point at which they age out.
 *
 * Retention is the privacy control. Pruning is not housekeeping here, it is
 * the feature.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_RETENTION_DAYS,
  adoptLegacyLog,
  formatLogDateKey,
  listRotatedLogs,
  logFileName,
  parseLogFileName,
  pruneLogDirectory,
  resolveActiveLogFile,
  selectExpiredLogs
} from './log-rotation';

// Naming

describe('log file naming', () => {
  it('names the first file of a day app-YYYY-MM-DD.log', () => {
    expect(logFileName('2026-11-08', 0)).toBe('app-2026-11-08.log');
  });

  it('appends a sequence number for files after the first', () => {
    expect(logFileName('2026-11-08', 1)).toBe('app-2026-11-08.1.log');
    expect(logFileName('2026-11-08', 12)).toBe('app-2026-11-08.12.log');
  });

  it('round-trips through parseLogFileName', () => {
    expect(parseLogFileName('app-2026-11-08.log')).toEqual({ dateKey: '2026-11-08', seq: 0 });
    expect(parseLogFileName('app-2026-11-08.3.log')).toEqual({ dateKey: '2026-11-08', seq: 3 });
  });

  /**
   * The pruner deletes files. parseLogFileName is the ONLY thing standing
   * between it and somebody's unrelated file that happened to be sitting in
   * the log directory, so it has to be strict rather than forgiving.
   */
  it('refuses to recognise anything that is not one of our own log files', () => {
    expect(parseLogFileName('app.log')).toBeNull();
    expect(parseLogFileName('app-2026-11-08.txt')).toBeNull();
    expect(parseLogFileName('app-2026-13-08.log')).toBeNull();   // month 13
    expect(parseLogFileName('app-2026-11-32.log')).toBeNull();   // day 32
    expect(parseLogFileName('app-26-11-08.log')).toBeNull();     // two-digit year
    expect(parseLogFileName('notes-2026-11-08.log')).toBeNull();
    expect(parseLogFileName('app-2026-11-08.x.log')).toBeNull(); // non-numeric sequence
    expect(parseLogFileName('')).toBeNull();
  });

  it('derives the date key in UTC, matching the UTC timestamps inside the lines', () => {
    // 2026-11-09T01:30Z is still 2026-11-08 in US local time. The lines in the
    // file are stamped with toISOString(), i.e. UTC, so the file name has to
    // agree with them or a log opened on its own reads as the wrong day.
    expect(formatLogDateKey(new Date('2026-11-09T01:30:00.000Z'))).toBe('2026-11-09');
    expect(formatLogDateKey(new Date('2026-01-02T00:00:00.000Z'))).toBe('2026-01-02');
  });
});

// Retention

describe('selectExpiredLogs', () => {
  const names = [
    'app-2026-11-08.log',
    'app-2026-11-08.1.log',
    'app-2026-10-26.log',   // 13 days before the 8th — inside a 14-day window
    'app-2026-10-25.log',   // 14 days before — the boundary
    'app-2026-10-24.log',   // 15 days before — out
    'app-2026-09-01.log'    // long gone
  ];

  it('keeps today and anything inside the retention window', () => {
    const expired = selectExpiredLogs(names, '2026-11-08', 14);
    expect(expired).not.toContain('app-2026-11-08.log');
    expect(expired).not.toContain('app-2026-11-08.1.log');
    expect(expired).not.toContain('app-2026-10-26.log');
  });

  it('expires anything older than the window', () => {
    const expired = selectExpiredLogs(names, '2026-11-08', 14);
    expect(expired).toContain('app-2026-10-24.log');
    expect(expired).toContain('app-2026-09-01.log');
  });

  /**
   * "~14 days retained" is stated as a count of files-worth-of-days, so the
   * 14th day back is still one of the fourteen. Off-by-one here is invisible
   * in normal use and only shows up as a log somebody expected to still be
   * there, so it is pinned explicitly.
   */
  it('treats the oldest day in the window as retained, not expired', () => {
    const expired = selectExpiredLogs(names, '2026-11-08', 14);
    expect(expired).not.toContain('app-2026-10-25.log');
  });

  it('never selects a file it does not recognise as one of ours', () => {
    const expired = selectExpiredLogs(
      ['app.log', 'my-tax-return.log', 'README.md', 'app-2019-01-01.log'],
      '2026-11-08',
      14
    );
    expect(expired).toEqual(['app-2019-01-01.log']);
  });

  it('crossing a month and a year boundary still measures real days', () => {
    const expired = selectExpiredLogs(
      ['app-2025-12-28.log', 'app-2025-12-19.log', 'app-2025-12-15.log'],
      '2026-01-02',
      14
    );
    expect(expired).not.toContain('app-2025-12-28.log'); // 5 days back  — kept
    expect(expired).not.toContain('app-2025-12-19.log'); // 14 days back — the boundary, kept
    expect(expired).toContain('app-2025-12-15.log');     // 18 days back — gone
  });

  it('a future-dated file is never deleted', () => {
    // Clock skew, or the user changing their system date. Deleting a log we
    // cannot explain is worse than keeping it.
    expect(selectExpiredLogs(['app-2027-01-01.log'], '2026-11-08', 14)).toEqual([]);
  });
});

describe('the shipped defaults', () => {
  it('retains about two weeks', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(14);
  });

  /**
   * The cap exists so one runaway loop cannot produce a file too big to send.
   * 5 MB is comfortably attachable and already larger than a normal day.
   */
  it('caps a single file at 5 MB', () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});

// Against a real directory

describe('resolveActiveLogFile / pruneLogDirectory / adoptLegacyLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-logs-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the plain dated name when nothing exists yet', () => {
    expect(path.basename(resolveActiveLogFile(dir, '2026-11-08', 1000)))
      .toBe('app-2026-11-08.log');
  });

  it('keeps appending to the current file while it is under the cap', () => {
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.log'), 'x'.repeat(500));
    expect(path.basename(resolveActiveLogFile(dir, '2026-11-08', 1000)))
      .toBe('app-2026-11-08.log');
  });

  it('rolls to the next sequence once the current file is at the cap', () => {
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.log'), 'x'.repeat(1000));
    expect(path.basename(resolveActiveLogFile(dir, '2026-11-08', 1000)))
      .toBe('app-2026-11-08.1.log');
  });

  it('keeps rolling past the first overflow', () => {
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.log'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.1.log'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.2.log'), 'x'.repeat(10));
    expect(path.basename(resolveActiveLogFile(dir, '2026-11-08', 1000)))
      .toBe('app-2026-11-08.2.log');
  });

  it('a new day starts a new file even though yesterday had room left', () => {
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.log'), 'x');
    expect(path.basename(resolveActiveLogFile(dir, '2026-11-09', 1_000_000)))
      .toBe('app-2026-11-09.log');
  });

  it('prunes only expired logs and reports what it removed', () => {
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.log'), 'keep');
    fs.writeFileSync(path.join(dir, 'app-2026-01-01.log'), 'go');
    fs.writeFileSync(path.join(dir, 'coins-backup.zip'), 'definitely keep');

    const removed = pruneLogDirectory(dir, '2026-11-08', 14);

    expect(removed).toEqual(['app-2026-01-01.log']);
    expect(fs.existsSync(path.join(dir, 'app-2026-11-08.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'app-2026-01-01.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'coins-backup.zip'))).toBe(true);
  });

  it('pruning a directory that does not exist is a no-op, not a crash', () => {
    expect(pruneLogDirectory(path.join(dir, 'nope'), '2026-11-08', 14)).toEqual([]);
  });

  it('lists rotated logs newest first, with their sizes', () => {
    fs.writeFileSync(path.join(dir, 'app-2026-11-07.log'), 'aa');
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.log'), 'bbbb');
    fs.writeFileSync(path.join(dir, 'app-2026-11-08.1.log'), 'c');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x');

    expect(listRotatedLogs(dir)).toEqual([
      { name: 'app-2026-11-08.1.log', bytes: 1 },
      { name: 'app-2026-11-08.log', bytes: 4 },
      { name: 'app-2026-11-07.log', bytes: 2 }
    ]);
  });

  /**
   * If rotation simply stopped writing to an existing app.log, that file
   * would sit there forever — outside retention, still full of the user's
   * name and photo paths. Adoption renames it into the scheme so the
   * ordinary 14-day rule finally applies to it.
   */
  it('adopts a pre-rotation app.log into the dated scheme', () => {
    const legacy = path.join(dir, 'app.log');
    fs.writeFileSync(legacy, 'old lines');
    fs.utimesSync(legacy, new Date('2026-11-01T12:00:00Z'), new Date('2026-11-01T12:00:00Z'));

    const adopted = adoptLegacyLog(dir);

    expect(adopted).toBe('app-2026-11-01.log');
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'app-2026-11-01.log'), 'utf8')).toBe('old lines');
  });

  it('adoption picks a free sequence rather than overwriting a real log', () => {
    const legacy = path.join(dir, 'app.log');
    fs.writeFileSync(legacy, 'old lines');
    fs.utimesSync(legacy, new Date('2026-11-01T12:00:00Z'), new Date('2026-11-01T12:00:00Z'));
    fs.writeFileSync(path.join(dir, 'app-2026-11-01.log'), 'already here');

    expect(adoptLegacyLog(dir)).toBe('app-2026-11-01.1.log');
    expect(fs.readFileSync(path.join(dir, 'app-2026-11-01.log'), 'utf8')).toBe('already here');
    expect(fs.readFileSync(path.join(dir, 'app-2026-11-01.1.log'), 'utf8')).toBe('old lines');
  });

  it('adoption does nothing when there is no legacy file', () => {
    expect(adoptLegacyLog(dir)).toBeNull();
  });
});
