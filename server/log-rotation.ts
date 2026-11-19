/**
 * Naming, rolling and retention policy for app logs:
 *
 *   app-2026-11-08.log      the day's log
 *   app-2026-11-08.1.log    continuation once the first hits the size cap
 *
 * One file per UTC day (lines are stamped in UTC, so the file name matches
 * its contents), each capped, about 14 days kept. Retention keeps logs small
 * enough to attach and lets paths and usernames age out.
 *
 * parseLogFileName is strict because pruning deletes whatever it accepts;
 * anything not exactly one of our names is left alone.
 */

import fs from 'node:fs';
import path from 'node:path';

/** `app-` … `.log`. Kept as constants so the parser and the printer agree. */
const FILE_PREFIX = 'app-';
const FILE_SUFFIX = '.log';

/** The pre-rotation file name. See adoptLegacyLog(). */
export const LEGACY_LOG_NAME = 'app.log';

/**
 * Days of logs kept, counting today. Long enough to report a problem a week
 * later, short enough that old paths don't linger.
 */
export const DEFAULT_RETENTION_DAYS = 14;

/** Hard cap on one file: keeps files attachable and contains runaway logging. */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Upper bound on the sequence search in resolveActiveLogFile (5 GB/day at the cap). */
const MAX_SEQUENCE = 1000;

/** One rotated log on disk. Names and sizes only — never contents. */
export interface RotatedLog {
  name: string;
  bytes: number;
}

/** The UTC day of a timestamp as `YYYY-MM-DD`, via toISOString() like the line stamps. */
export function formatLogDateKey(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/** `('2026-11-08', 0)` -> `app-2026-11-08.log`; `(…, 2)` -> `app-2026-11-08.2.log`. */
export function logFileName(dateKey: string, seq = 0): string {
  return seq === 0
    ? `${FILE_PREFIX}${dateKey}${FILE_SUFFIX}`
    : `${FILE_PREFIX}${dateKey}.${seq}${FILE_SUFFIX}`;
}

/**
 * Strict inverse of `logFileName`; returns null for anything else, including
 * impossible dates like `app-2026-13-08.log`.
 */
export function parseLogFileName(name: string): { dateKey: string; seq: number } | null {
  const match = /^app-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.log$/.exec(name);
  if (!match) return null;

  const [, year, month, day, seq] = match;
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > 31) return null;

  return {
    dateKey: `${year}-${month}-${day}`,
    seq: seq === undefined ? 0 : Number(seq)
  };
}

/**
 * Whole days from `fromKey` to `toKey` (negative if `fromKey` is in the
 * future). Uses Date.UTC so daylight saving can't shift the boundary.
 */
function daysBetweenKeys(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Which of `names` have aged out. Unrecognised names are never returned (the
 * result is deleted), and future-dated logs (clock skew) are never expired.
 * Inclusive: with 14 days, a log 14 days old is kept.
 */
export function selectExpiredLogs(
  names: readonly string[],
  todayKey: string,
  retentionDays: number
): string[] {
  const expired: string[] = [];

  for (const name of names) {
    const parsed = parseLogFileName(name);
    if (!parsed) continue;

    const age = daysBetweenKeys(parsed.dateKey, todayKey);
    if (age < 0) continue;              // future-dated; leave it alone
    if (age > retentionDays) expired.push(name);
  }

  return expired;
}

/** Directory listing that never throws; a missing log folder is normal on first run. */
function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Size in bytes, or null when the file has gone away underneath us. */
function safeSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * The file the next line should go to: the first in the sequence for
 * `dateKey` that is missing or under the cap. Checked before the write, so a
 * file can exceed the cap by one line rather than splitting a line.
 */
export function resolveActiveLogFile(dir: string, dateKey: string, maxBytes: number): string {
  for (let seq = 0; seq < MAX_SEQUENCE; seq++) {
    const candidate = path.join(dir, logFileName(dateKey, seq));
    const size = safeSize(candidate);
    if (size === null || size < maxBytes) return candidate;
  }

  // Ran off the end: keep logging to the last file rather than losing lines.
  return path.join(dir, logFileName(dateKey, MAX_SEQUENCE - 1));
}

/**
 * Deletes every expired log in `dir` and returns the names removed. Failures
 * are swallowed (this runs on the logging path); the file is retried later.
 */
export function pruneLogDirectory(
  dir: string,
  todayKey: string,
  retentionDays: number
): string[] {
  const removed: string[] = [];

  for (const name of selectExpiredLogs(safeReaddir(dir), todayKey, retentionDays)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // Locked, gone, or permission denied. Try again next time.
    }
  }

  return removed;
}

/** Every rotated log in `dir`, newest first, with sizes. Names and sizes only. */
export function listRotatedLogs(dir: string): RotatedLog[] {
  const logs: Array<RotatedLog & { dateKey: string; seq: number }> = [];

  for (const name of safeReaddir(dir)) {
    const parsed = parseLogFileName(name);
    if (!parsed) continue;
    const bytes = safeSize(path.join(dir, name));
    if (bytes === null) continue;
    logs.push({ name, bytes, dateKey: parsed.dateKey, seq: parsed.seq });
  }

  // Newest first: later date, then higher sequence. Sorted on parsed fields
  // because a string sort puts 'app-…08.log' after 'app-…08.1.log'.
  logs.sort((a, b) =>
    a.dateKey === b.dateKey ? b.seq - a.seq : b.dateKey.localeCompare(a.dateKey)
  );

  return logs.map(({ name, bytes }) => ({ name, bytes }));
}

/**
 * Renames a pre-rotation `app.log` into the dated scheme so the retention rule
 * applies to it. Uses the file's modified date and the first free sequence.
 * Returns the new name, or null when there was nothing to adopt.
 */
export function adoptLegacyLog(dir: string, legacyName: string = LEGACY_LOG_NAME): string | null {
  const legacy = path.join(dir, legacyName);

  let modified: Date;
  try {
    modified = fs.statSync(legacy).mtime;
  } catch {
    return null;   // no legacy file: the normal case from the second run onwards
  }

  const dateKey = formatLogDateKey(modified);

  for (let seq = 0; seq < MAX_SEQUENCE; seq++) {
    const name = logFileName(dateKey, seq);
    const target = path.join(dir, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.renameSync(legacy, target);
      return name;
    } catch {
      // Locked; the next startup can try again.
      return null;
    }
  }

  return null;
}
