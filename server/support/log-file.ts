/**
 * The optional log file written beside the support report when "Include
 * recent log" is ticked (default on): a redacted `.txt` of the last 2,000
 * log lines, so the user never needs to share the raw app.log. Kept separate
 * so the report stays readable.
 *
 * This renders unredacted text; prepareSupportFiles() redacts it with the
 * report's redactor so placeholders match across both files.
 */

import { supportFileTimestamp } from './report-file';

export const LOG_FILE_LIMITS = {
  /** Much larger than the report body's 150 lines; this file's job is to contain the cause. */
  maxLines: 2000,
  /** Stops one huge line (e.g. base64) using the budget. */
  maxLineChars: 500
} as const;

/**
 * `coin-inventory-log-2026-11-13-180405.txt`. `.txt` so GitHub accepts it and
 * Windows opens it in Notepad. Shares the report's timestamp.
 */
export function logFileName(when: Date): string {
  return `coin-inventory-log-${supportFileTimestamp(when)}.txt`;
}

/** One line, shortened if it is absurd. The ellipsis is deliberate and visible. */
function clampLine(line: string): string {
  const max = LOG_FILE_LIMITS.maxLineChars;
  return line.length <= max ? line : `${line.slice(0, max)}… [${line.length - max} more characters]`;
}

export interface LogFileContext {
  /** Same instant as the report's, so the two headers agree. */
  generatedAt: Date;
  /** The report this log was written beside, by name. Never a full path. */
  reportFileName: string;
}

/**
 * Renders the file's text, unredacted (the caller redacts it). The header
 * explains what the file is and that placeholders match the report's.
 */
export function renderLogFile(lines: readonly string[], context: LogFileContext): string {
  const shown = lines.slice(-LOG_FILE_LIMITS.maxLines);
  const dropped = lines.length - shown.length;

  const out: string[] = [];
  out.push('Coin Inventory — recent log');
  out.push(`Written ${context.generatedAt.toISOString()}`);
  out.push(`Goes with ${context.reportFileName}`);
  out.push('');
  out.push(
    'You asked for this when you ticked "Include recent log". Nothing was uploaded; ' +
    'this file is on your machine until you choose to attach it.'
  );
  out.push('');
  out.push(
    'THIS FILE IS REDACTED. Your user name, computer name, folder paths, email ' +
    'addresses and anything that looked like a password, key or connection string ' +
    'have been replaced with placeholders — by the same pass, and the same ' +
    'placeholder table, as the problem report. A folder that reads as <USER> here ' +
    'is the same folder that reads as <USER> there.'
  );
  out.push('');

  if (shown.length === 0) {
    out.push('No log lines were available.');
  } else if (dropped > 0) {
    out.push(
      `${shown.length} lines — the most recent. ${dropped} earlier ` +
      `line${dropped === 1 ? ' was' : 's were'} not included; the full log is still ` +
      'in the log folder on the machine that produced it.'
    );
  } else {
    out.push(`${shown.length} line${shown.length === 1 ? '' : 's'} — the whole of what is kept.`);
  }

  out.push('');
  out.push('----------------------------------------------------------------------');
  out.push('');
  for (const line of shown) out.push(clampLine(line));
  out.push('');

  return out.join('\n');
}
