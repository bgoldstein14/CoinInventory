/**
 * support/log-file.ts — the SECOND file, written only when the reporter ticks
 * "Include recent log".
 *
 * WHY THIS EXISTS AT ALL
 * Removing the zip removed the only *redacted* log a user could share. The
 * report body carries 150 lines; the 2,000-line tail that used to sit in the
 * archive went with it. What was left was the raw `app.log` — full of the
 * account name, the machine name and photo paths — as the only thing a user
 * could drag into a PUBLIC issue. That is a safety gap, not a missing
 * convenience: the feature's whole promise is that nothing leaves the machine
 * un-redacted, and the easiest thing to reach for was the one file that had
 * never been through the redactor.
 *
 * WHY IT IS OPT-IN AND NOT AUTOMATIC
 * The owner's framing, and it is the right one: a log in every report assumes
 * every report is a bug report. A feature request does not need one. So it is
 * a checkbox — ticked by default, because the dialog is reached from "Report a
 * problem" and a log is the single most useful thing in a bug report, and one
 * click to turn off.
 *
 * WHY IT IS A SEPARATE FILE AND NOT MORE LINES IN THE REPORT
 * The report is meant to be READ — in the issue, in a browser, by someone
 * deciding whether to care. Two thousand log lines pasted into it would bury
 * the three paragraphs that say what went wrong. A second plain `.txt`
 * dragged in beside it is opened only by the person who wants it.
 *
 * THE REDACTION IS NOT DONE HERE, AND THAT IS DELIBERATE
 * This module renders the UNREDACTED text and hands it to
 * `prepareSupportFiles`, which redacts the report and this log with ONE
 * `Redactor` instance. Redacting here, separately, would be a correctness bug
 * and a nasty one: two independent redactors allocate placeholders in
 * first-seen order, so the same folder could be `<USER2>` in the report and
 * `<USER3>` in the log. The pair would then actively mislead a reader into
 * believing two different accounts were involved.
 *
 * EVERYTHING IS STILL CAPPED
 * 2,000 lines, 500 characters each. The same argument as the report: a file
 * too big to send is indistinguishable from one that was never sent, and a
 * silently truncated log is worse than a short one because the reader cannot
 * tell what is missing. So the header says out loud how much was dropped.
 */

import { supportFileTimestamp } from './report-file';

export const LOG_FILE_LIMITS = {
  /**
   * The 2,000 the archive used to carry. Deliberately much larger than the
   * report body's 150: the body's job is to be readable in an issue, this
   * file's job is to contain the cause.
   */
  maxLines: 2000,
  /** One base64 image payload on one line would otherwise eat the budget. */
  maxLineChars: 500
} as const;

/**
 * `coin-inventory-log-2026-11-13-180405.txt`.
 *
 * `.txt`, not `.log`: GitHub's attachment allow-list takes `.txt` and Windows
 * opens it in Notepad on a double-click without asking which program to use.
 *
 * THE TIMESTAMP IS SHARED WITH THE REPORT. Both files are named from the same
 * `Date`, so the pair is obviously a pair on a Desktop that may already hold
 * three of them. Seconds, not minutes, for the same reason the report uses
 * them: two reports in quick succession must not overwrite each other.
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
 * Render the file's text, UNREDACTED. The caller redacts it with the report's
 * own redactor — see the module header for why that is not optional.
 *
 * The header is not decoration. Somebody opening this file months later, or
 * finding it on a public issue, has to be able to tell what it is, that it has
 * been scrubbed, and that the placeholders in it mean the same thing as the
 * ones in the report. None of that is guessable from a wall of log lines.
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
