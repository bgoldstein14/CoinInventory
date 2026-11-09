/**
 * log-rotation.ts — the naming, rolling and retention POLICY for app logs.
 *
 * A single append-only `app.log` solved neither of the two problems rotation
 * exists for:
 *
 *   SUPPORT  A user who hits a bug is asked for their log. Nobody can attach
 *            an unbounded file to a GitHub issue, and nobody is going to find
 *            the interesting twelve lines in forty thousand.
 *
 *   PRIVACY  Every line that carries a path carries the Windows username and,
 *            via connection strings, the machine name. An append-only file
 *            accumulates those forever.
 *
 * Retention is therefore not tidiness. It is the privacy control: things the
 * user has forgotten about age out on their own.
 *
 * THE SHAPE
 *   app-2026-11-08.log      the day's log
 *   app-2026-11-08.1.log    …and its continuation once the first hit the cap
 *   app-2026-11-08.2.log
 *
 * One file per UTC day, each capped, roughly fourteen days kept.
 *
 * WHY UTC AND NOT LOCAL TIME
 * Every line the logger writes is stamped with `new Date().toISOString()`,
 * which is UTC. If the FILE name used local dates, a log opened on its own
 * would disagree with its own contents near midnight — `app-2026-11-08.log`
 * would open on lines stamped `2026-11-09T02:...`. For a support artefact
 * somebody else reads out of context, self-consistency beats matching the
 * user's wall clock.
 *
 * WHY THE PARSER IS STRICT
 * `pruneLogDirectory` DELETES. `parseLogFileName` is the only thing between it
 * and an unrelated file somebody left in the log folder, so it rejects
 * anything that is not exactly one of our own names — wrong extension, wrong
 * prefix, impossible month, non-numeric sequence. A forgiving parser here is a
 * data-loss bug, not a convenience.
 */

import fs from 'node:fs';
import path from 'node:path';

/** `app-` … `.log`. Kept as constants so the parser and the printer agree. */
const FILE_PREFIX = 'app-';
const FILE_SUFFIX = '.log';

/** The pre-rotation file name. See adoptLegacyLog(). */
export const LEGACY_LOG_NAME = 'app.log';

/**
 * How many days of logs are kept, counting today as day one.
 *
 * Two weeks is long enough that a user who notices a problem on Monday and
 * gets round to reporting it the following week still has the evidence, and
 * short enough that a path they have since stopped using does not sit on disk
 * indefinitely.
 */
export const DEFAULT_RETENTION_DAYS = 14;

/**
 * Hard cap on one file.
 *
 * Sized so that even a pathological day splits into a couple of files that are
 * each still trivially attachable to an issue (the worst observed single log
 * is around 8 MB). The cap's real job is to contain a runaway loop — a retry
 * storm can produce more in an hour than a year of normal use.
 */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Upper bound on the sequence search in `resolveActiveLogFile`.
 *
 * At the 5 MB cap this is 5 GB of logging in a single day, which is not a
 * situation worth continuing to serve. Without a bound, a directory somehow
 * full of sequence files would turn one log line into an unbounded stat loop.
 */
const MAX_SEQUENCE = 1000;

/** One rotated log on disk. Names and sizes only — never contents. */
export interface RotatedLog {
  name: string;
  bytes: number;
}

/**
 * The UTC calendar day a timestamp belongs to, as `YYYY-MM-DD`.
 *
 * Implemented off `toISOString()` rather than `getUTCFullYear()` + padding
 * because it is the same call the logger uses to stamp the line, so the two
 * cannot drift.
 */
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
 * Strict inverse of `logFileName`. Returns null for ANYTHING else.
 *
 * The calendar check (`month <= 12`, `day <= 31`) is deliberate: a file named
 * `app-2026-13-08.log` is not something this module produced, so whatever it
 * is, it is not ours to delete.
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
 * Whole days from `fromKey` to `toKey`, negative when `fromKey` is in the
 * future.
 *
 * Date.UTC() is used rather than `new Date(key)` arithmetic so that daylight
 * saving cannot make a "day" 23 or 25 hours long and shift the boundary by
 * one. The retention window is counted in days, so it has to be counted in
 * days that are all the same length.
 */
function daysBetweenKeys(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Which of `names` have aged out, given today and a retention window.
 *
 * Two deliberate refusals:
 *
 *   - Anything `parseLogFileName` does not recognise is never returned. See
 *     the module header; this function's output is fed straight to unlink().
 *   - A FUTURE-dated log is never expired. Clock skew and users changing
 *     their system date both happen, and `age` then goes negative. Deleting a
 *     file because we cannot explain its date is the wrong way round.
 *
 * The window is inclusive of its oldest day: with `retentionDays = 14`, a log
 * 14 days old is the fourteenth of the fourteen and is kept.
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

/** Directory listing that never throws — a missing log folder is normal on first run. */
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
 * The file the next line should be appended to.
 *
 * Walks the sequence for `dateKey` until it finds one that is missing or still
 * under the cap. Note the comparison is `size < maxBytes` on the file BEFORE
 * the write, so a file can finish slightly over the cap — by at most one log
 * line. Measuring the line first and splitting it across two files would be
 * worse: a stack trace torn in half is harder to read than a 5 MB + 400 byte
 * file is to attach.
 */
export function resolveActiveLogFile(dir: string, dateKey: string, maxBytes: number): string {
  for (let seq = 0; seq < MAX_SEQUENCE; seq++) {
    const candidate = path.join(dir, logFileName(dateKey, seq));
    const size = safeSize(candidate);
    if (size === null || size < maxBytes) return candidate;
  }

  // Ran off the end of the sequence. Returning the last one keeps logging
  // working (over-cap, but working); losing log lines entirely would be worse
  // than a large file, and this is a situation that should never occur.
  return path.join(dir, logFileName(dateKey, MAX_SEQUENCE - 1));
}

/**
 * Delete every expired log in `dir`. Returns the names actually removed.
 *
 * Failures are swallowed on purpose. Pruning runs on the logging path, and a
 * file locked by an editor or an antivirus scanner must not turn into an
 * exception thrown out of `logInfo()`. The file will simply be considered
 * again next time.
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
      // Locked, already gone, or permission-denied. Try again tomorrow.
    }
  }

  return removed;
}

/**
 * Every rotated log in `dir`, newest first, with sizes.
 *
 * NAMES AND SIZES ONLY. This feeds the support report's "what logs exist"
 * section, which is explicitly a count-and-size inventory — the contents go
 * through redaction, this listing does not need to.
 */
export function listRotatedLogs(dir: string): RotatedLog[] {
  const logs: Array<RotatedLog & { dateKey: string; seq: number }> = [];

  for (const name of safeReaddir(dir)) {
    const parsed = parseLogFileName(name);
    if (!parsed) continue;
    const bytes = safeSize(path.join(dir, name));
    if (bytes === null) continue;
    logs.push({ name, bytes, dateKey: parsed.dateKey, seq: parsed.seq });
  }

  /*
   * Newest first: later date wins, and within a date the HIGHER SEQUENCE is
   * the more recent file.
   *
   * Sorted on the parsed fields rather than on the string, because a plain
   * descending string sort gets the second clause backwards:
   * 'app-2026-11-08.log' sorts after 'app-2026-11-08.1.log' (the character
   * after the date is 'l' in one and '1' in the other, and 'l' > '1'), so the
   * OLDER half of the day would be listed as the newest file.
   */
  logs.sort((a, b) =>
    a.dateKey === b.dateKey ? b.seq - a.seq : b.dateKey.localeCompare(a.dateKey)
  );

  return logs.map(({ name, bytes }) => ({ name, bytes }));
}

/**
 * Rename a pre-rotation `app.log` into the dated scheme.
 *
 * NOT "ignore the old file": an existing app.log is full of the user's name
 * and the absolute paths of their photo library. If rotation merely stopped
 * writing to it, that file would never age out — permanently outside the
 * retention rule that is the whole privacy control. Renaming it in means the
 * ordinary fourteen-day rule finally applies to it.
 *
 * The date used is the file's last-modified time, which is the closest thing
 * available to "the last day this log was true". Adoption picks the first free
 * sequence so it can never clobber a genuine rotated log.
 *
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
      // Locked by something else. Leave it; the next startup can try again.
      return null;
    }
  }

  return null;
}
