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
 * File logger for the backend: one file per UTC day, size-capped, about two
 * weeks retained (naming and retention are in log-rotation.ts). Also lets the
 * support report read logs back.
 *
 * Nothing here may throw: logError() is called from the uncaughtException
 * handler in process-safety.ts, so every filesystem call falls back to the
 * console.
 */

/**
 * Overrides where logs are written: tests use a temp folder, and the packaged
 * build uses %LOCALAPPDATA%\CoinInventory (Program Files isn't writable).
 */
const LOG_DIR_ENV_VAR = 'COIN_LOG_DIR';

/** Live rotation limits. Mutable only through setLogRotationLimits(). */
let maxFileBytes = DEFAULT_MAX_FILE_BYTES;
let retentionDays = DEFAULT_RETENTION_DAYS;

/** Resolved on first use, so the env var can be set after this module is imported. */
let logDir: string | null = null;

/** Set once the one-off startup housekeeping (adopt + prune) has run. */
let housekeepingDone = false;

/**
 * The file being appended to and its byte count. Cached rather than stat'ed
 * per line (every API call is logged); seeded from a real stat when a file is
 * first opened.
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
 * Test seam: lowers the rotation limits so rolling can be tested without
 * writing 5 MB. Also resets the memoised directory and housekeeping flag.
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
 * Creates the log directory if needed. Returns false if it can't (read-only
 * folder, dead share), and the caller falls back to the console.
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
 * Adopts a pre-rotation app.log and prunes expired files. Runs once per
 * process and again whenever the UTC day changes.
 */
function runHousekeeping(dir: string, todayKey: string): void {
  try {
    adoptLegacyLog(dir);
    pruneLogDirectory(dir, todayKey, retentionDays);
  } catch {
    // Best effort; a locked file must never cost a log line.
  }
}

/** Picks the file for this line, rolling by day and size. Null means fall back to the console. */
function selectTargetFile(dir: string, lineBytes: number): string | null {
  if (!ensureLogDirectory(dir)) return null;

  const todayKey = formatLogDateKey(new Date());

  // Re-run retention on the day tick too, since the app may run for weeks.
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
    // Seed the counter from the real file (restart mid-day, or rolled onto an existing file).
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

/** Max bytes read from one file when collecting the tail. */
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
 * The most recent `maxLines` log lines, oldest first. Walks back across files,
 * since a recent roll can leave the current file nearly empty. Returns
 * unredacted lines; support/redaction.ts redacts them for reports.
 */
export function readRecentLogLines(maxLines: number): string[] {
  if (maxLines <= 0) return [];

  const dir = getLogDirectory();
  const collected: string[] = [];

  for (const file of listRotatedLogs(dir)) {
    const text = readFileTail(path.join(dir, file.name), TAIL_READ_BYTES);
    if (text.length === 0) continue;

    // A tail read can start mid-line; drop the partial first line.
    const lines = text.split(/\r?\n/).filter(l => l.length > 0);
    collected.unshift(...lines);

    if (collected.length >= maxLines) break;
  }

  return collected.slice(-maxLines);
}
