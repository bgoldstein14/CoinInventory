import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_RETENTION_DAYS,
  RotatedLog,
  adoptLegacyLog,
  formatLogDateKey,
  listRotatedLogs,
  pruneLogDirectory,
  resolveActiveLogFile
} from './log-rotation';

/**
 * logger.ts — the file-based logger for the Express backend: one file per UTC
 * day, each capped, about a fortnight retained. The naming and retention
 * arithmetic lives in log-rotation.ts (and explains why rotation exists at
 * all); this file is the part that writes.
 *
 * It also exposes what the support bundle needs to read logs back:
 * getLogDirectory(), listLogFiles(), readRecentLogLines().
 *
 * NOTHING HERE MAY THROW. logError() is called from the process-level safety
 * net in process-safety.ts, i.e. from inside an uncaughtException handler. A
 * throw from this module there would replace a logged crash with an unlogged
 * one. Every filesystem call below is therefore inside a try/catch whose
 * fallback is the console.
 */

/**
 * Overrides where logs are written.
 *
 * Two reasons this exists rather than a hardcoded `server/logs`:
 *   - tests must not scribble into the developer's real log, and in
 *     particular must not pollute the log the support bundle reads;
 *   - the packaged build puts logs under %LOCALAPPDATA%\CoinInventory, because
 *     `Program Files` is not writable by a standard user and logs next to the
 *     executable would fail to open.
 */
const LOG_DIR_ENV_VAR = 'COIN_LOG_DIR';

/** Live rotation limits. Mutable only through setLogRotationLimits(). */
let maxFileBytes = DEFAULT_MAX_FILE_BYTES;
let retentionDays = DEFAULT_RETENTION_DAYS;

/**
 * Memoised directory. Resolved on FIRST USE rather than at module load so the
 * environment variable can be set by a caller (or a test) that imports this
 * module transitively before it has had a chance to configure anything.
 */
let logDir: string | null = null;

/** Set once the one-off startup housekeeping (adopt + prune) has run. */
let housekeepingDone = false;

/**
 * The file currently being appended to, and how many bytes we believe are in
 * it.
 *
 * A cached byte count rather than a statSync per line: this logger is on the
 * request path (server.ts logs every API call) and can produce tens of
 * thousands of lines a day, and the only question being asked is "am I near
 * the cap". The count is seeded from a real stat when a file is first opened,
 * so a restart part-way through a day still picks up the true size.
 */
let activeFile: string | null = null;
let activeBytes = 0;
let activeDateKey = '';

/** Where logs are written. Exported for the support bundle's inventory. */
export function getLogDirectory(): string {
  if (logDir === null) {
    const override = process.env[LOG_DIR_ENV_VAR];
    logDir = override && override.trim().length > 0
      ? path.resolve(override.trim())
      : path.resolve(__dirname, 'logs');
  }
  return logDir;
}

/**
 * Test seam for the rotation limits.
 *
 * Proving the roll happens with the production 5 MB cap would mean writing
 * 5 MB in a unit test. Lowering the cap is the only honest way to exercise
 * the branch quickly — the alternative is not testing it, which is how
 * rotation bugs ship.
 *
 * Also resets the memoised directory and the once-only housekeeping flag, so
 * a test that changes COIN_LOG_DIR between cases gets a clean logger.
 */
export function setLogRotationLimits(limits: {
  maxFileBytes?: number;
  retentionDays?: number;
}): void {
  if (limits.maxFileBytes !== undefined) maxFileBytes = limits.maxFileBytes;
  if (limits.retentionDays !== undefined) retentionDays = limits.retentionDays;
  logDir = null;
  housekeepingDone = false;
  activeFile = null;
  activeBytes = 0;
  activeDateKey = '';
}

/**
 * Create the log directory if it is not there yet.
 *
 * Returns false when it could not be created — a read-only install folder, a
 * dead network share, or (in one of the tests) a parent that is a file. The
 * caller falls back to the console rather than failing the request that
 * happened to produce the log line.
 */
function ensureLogDirectory(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Adopt a pre-rotation app.log and prune anything expired. Runs once per
 * process, plus once more whenever the UTC day ticks over (see below), which
 * is what keeps retention honest in a long-running desktop session rather
 * than only at startup.
 */
function runHousekeeping(dir: string, todayKey: string): void {
  try {
    adoptLegacyLog(dir);
    pruneLogDirectory(dir, todayKey, retentionDays);
  } catch {
    // Housekeeping is best-effort. A locked file must never cost a log line.
  }
}

/**
 * Work out which file this line belongs in, rolling by day and by size.
 *
 * Returns null when the directory is unusable, which is the caller's cue to
 * fall back to the console.
 */
function selectTargetFile(dir: string, lineBytes: number): string | null {
  if (!ensureLogDirectory(dir)) return null;

  const todayKey = formatLogDateKey(new Date());

  // Day boundary, or first line of the process: re-run retention. Doing this
  // on the day tick (not only at startup) matters because a desktop app can
  // easily be left running for a fortnight, which is exactly long enough for
  // the retention window to stop meaning anything.
  if (!housekeepingDone || todayKey !== activeDateKey) {
    runHousekeeping(dir, todayKey);
    housekeepingDone = true;
  }

  const needsNewFile =
    activeFile === null ||
    todayKey !== activeDateKey ||
    activeBytes + lineBytes > maxFileBytes;

  if (needsNewFile) {
    activeDateKey = todayKey;
    activeFile = resolveActiveLogFile(dir, todayKey, maxFileBytes);
    // Seed the counter from the real file so a restart mid-day, or a file we
    // have just rolled onto that already has content, is accounted for.
    try {
      activeBytes = fs.statSync(activeFile).size;
    } catch {
      activeBytes = 0;
    }
  }

  return activeFile;
}

/**
 * Appends a timestamped line to the current log file.
 * Uses appendFileSync so log writes are immediate and ordered.
 *
 * @param level - Log level: 'INFO', 'WARN', or 'ERROR'
 * @param message - The main log message
 * @param details - Optional additional details (often error stack traces)
 */
export function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: string): void {
  const timestamp = new Date().toISOString();
  const line = details
    ? `[${timestamp}] [${level}] ${message} | ${details}\n`
    : `[${timestamp}] [${level}] ${message}\n`;

  try {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const target = selectTargetFile(getLogDirectory(), lineBytes);
    if (target) {
      fs.appendFileSync(target, line);
      activeBytes += lineBytes;
    } else {
      console.error(`[LOG WRITE FAILED] ${line}`);
    }
  } catch {
    // Fall back to the console: logging must never crash the app.
    console.error(`[LOG WRITE FAILED] ${line}`);
  }

  // Echo to the console so dev-mode output is visible.
  if (level === 'ERROR') console.error(line.trim());
  else console.log(line.trim());
}

export function logInfo(message: string): void {
  log('INFO', message);
}

export function logWarn(message: string): void {
  log('WARN', message);
}

/** An Error argument contributes its message and stack as the detail field. */
export function logError(message: string, err?: unknown): void {
  const details = err instanceof Error ? `${err.message}\n${err.stack}` : String(err ?? '');
  log('ERROR', message, details);
}

/** Every rotated log on disk, newest first. Names and sizes only. */
export function listLogFiles(): RotatedLog[] {
  return listRotatedLogs(getLogDirectory());
}

/**
 * How much of a single file we are willing to pull into memory while hunting
 * for the tail. 1 MB is far more than the few hundred lines any caller asks
 * for, and it bounds the cost on a file that has been rolled right up to the
 * cap.
 */
const TAIL_READ_BYTES = 1024 * 1024;

/** The last `maxBytes` of a file, as text. Never throws. */
function readFileTail(file: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';

    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already gone */ }
    }
  }
}

/**
 * The most recent `maxLines` log lines, oldest first.
 *
 * It walks BACKWARDS ACROSS FILES because rotation means "the newest file"
 * and "the last hundred lines" are not the same thing: a roll two minutes ago
 * leaves a current file with three lines in it, precisely when something has
 * just gone wrong and filled a file. So the file list is walked newest-first,
 * prepending each file's tail, until there is enough.
 *
 * Returns raw, UNREDACTED lines. Redaction is the caller's job and happens in
 * support/redaction.ts — deliberately NOT here, because these logs are also
 * read directly on the user's own machine, where the paths are the useful part.
 */
export function readRecentLogLines(maxLines: number): string[] {
  if (maxLines <= 0) return [];

  const dir = getLogDirectory();
  const collected: string[] = [];

  for (const file of listRotatedLogs(dir)) {
    const text = readFileTail(path.join(dir, file.name), TAIL_READ_BYTES);
    if (text.length === 0) continue;

    // A tail read can begin mid-line; dropping the first fragment is cheaper
    // and more honest than presenting half a stack frame as a log line.
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    collected.unshift(...lines);

    if (collected.length >= maxLines) break;
  }

  return collected.slice(-maxLines);
}
