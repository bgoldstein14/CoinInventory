/**
 * Builds the support report markdown, which may be published in a public
 * issue tracker:
 *
 *   - Counts, not content: the collection is described by numbers only, never
 *     coins, prices, notes or paths.
 *   - Redacted here, before returning, so no unredacted copy exists.
 *   - Every list is capped and says how much it dropped.
 *   - The "what was removed" receipt is generated from the redactor's counters.
 */

import {
  RedactionIdentity,
  RedactionReceiptEntry,
  createRedactor
} from './redaction';

/** Counts only. The value is null when a particular count could not be read. */
export type SupportCounts = Record<string, number | null>;

/** One error the user actually saw in the app, as recorded by the frontend. */
export interface ClientError {
  timestamp: string;
  message: string;
  details?: string;
}

/** A file on disk, described by name and size. Never by content. */
export interface FileSummary {
  name: string;
  bytes: number;
}

/** Everything the report is rendered from. Assembled by routes/support. */
export interface SupportSnapshot {
  generatedAt: string;
  appVersion: string;
  serverVersion: string;
  nodeVersion: string;
  platform: string;
  osRelease: string;
  arch: string;
  /** null when the database could not be reached — see countsError. */
  counts: SupportCounts | null;
  countsError?: string;
  /** Oldest first, as the frontend's ring buffer stores them. */
  clientErrors: ClientError[];
  /** Oldest first, as readRecentLogLines returns them. Ignored when includeLog is false. */
  logLines: string[];
  logFiles: FileSummary[];
  /**
   * Did the reporter tick "Include recent log"? False means no log content
   * anywhere in the report. Defaults to true.
   */
  includeLog?: boolean;
  /** The user's own description of the problem, if they typed one first. */
  userDescription?: string;
}

/**
 * Size limits. 150 log lines covers the last few minutes, where a just-reported
 * bug's cause usually is; the optional log file carries 2,000 more.
 * `maxLineChars` stops one huge line (e.g. base64) using the whole budget.
 */
export const REPORT_LIMITS = {
  maxLogLines: 150,
  maxClientErrors: 20,
  maxLogFilesListed: 30,
  maxLineChars: 500,
  maxUserDescriptionChars: 4000,
  /** Final backstop; the report says if it was cut. */
  maxReportChars: 120_000
} as const;

/** Human-readable size. Used for log files and attachments. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line, shortened if it is absurd. The ellipsis is deliberate and visible. */
function clampLine(line: string, max: number = REPORT_LIMITS.maxLineChars): string {
  return line.length <= max ? line : `${line.slice(0, max)}… [${line.length - max} more characters]`;
}

/** Renders the unredacted body, one section after another. */
function renderBody(snapshot: SupportSnapshot): string {
  const out: string[] = [];

  out.push('## Problem report');
  out.push('');

  if (snapshot.userDescription && snapshot.userDescription.trim().length > 0) {
    out.push('### What happened');
    out.push('');
    out.push(clampLine(snapshot.userDescription.trim(), REPORT_LIMITS.maxUserDescriptionChars));
    out.push('');
  }

  // ---- Environment -------------------------------------------------------
  out.push('### Environment');
  out.push('');
  out.push('| | |');
  out.push('|---|---|');
  out.push(`| Report generated | ${snapshot.generatedAt} |`);
  out.push(`| App version | ${snapshot.appVersion} |`);
  out.push(`| Server version | ${snapshot.serverVersion} |`);
  out.push(`| Node | ${snapshot.nodeVersion} |`);
  out.push(`| OS | ${snapshot.platform} ${snapshot.osRelease} (${snapshot.arch}) |`);
  out.push('');

  // ---- Collection size ---------------------------------------------------
  out.push('### Collection size');
  out.push('');
  out.push('*Counts only. No coin, price, note or photo from your collection is included.*');
  out.push('');
  if (snapshot.counts === null) {
    out.push(
      `The collection could not be read${snapshot.countsError ? ` (${snapshot.countsError})` : ''}. ` +
      'That is often itself the problem being reported, so the rest of this report is unaffected.'
    );
  } else {
    for (const [label, value] of Object.entries(snapshot.counts)) {
      out.push(`- ${label}: ${value === null ? 'could not be read' : value}`);
    }
  }
  out.push('');

  // ---- Recent errors -----------------------------------------------------
  out.push('### Recent errors in the app');
  out.push('');
  if (snapshot.clientErrors.length === 0) {
    out.push('No errors were recorded during this session.');
  } else {
    // Newest first: the last error is usually the one that prompted the report.
    const newestFirst = [...snapshot.clientErrors].reverse();
    const shown = newestFirst.slice(0, REPORT_LIMITS.maxClientErrors);
    const dropped = newestFirst.length - shown.length;

    for (const error of shown) {
      out.push(`- \`${error.timestamp}\` ${clampLine(error.message)}`);
      if (error.details) out.push(`  - ${clampLine(error.details)}`);
    }
    if (dropped > 0) {
      out.push('');
      out.push(`*…and ${dropped} older error${dropped === 1 ? '' : 's'} not shown.*`);
    }
  }
  out.push('');

  // ---- Log tail ----------------------------------------------------------
  // Say whether log lines are absent or were deliberately excluded.
  const includeLog = snapshot.includeLog !== false;

  out.push('### Recent log lines');
  out.push('');
  if (!includeLog) {
    out.push(
      '*Not included. The reporter did not tick “Include recent log”, so no log ' +
      'lines are in this report and no log file was written beside it.*'
    );
  } else if (snapshot.logLines.length === 0) {
    out.push('No log lines were available.');
  } else {
    const shown = snapshot.logLines.slice(-REPORT_LIMITS.maxLogLines);
    const dropped = snapshot.logLines.length - shown.length;
    if (dropped > 0) {
      out.push(
        `*${dropped} earlier line${dropped === 1 ? '' : 's'} omitted. ` +
        'The full log file is still on the machine that produced it.*'
      );
      out.push('');
    }
    out.push('```');
    for (const line of shown) out.push(clampLine(line));
    out.push('```');
  }
  out.push('');

  // ---- Log inventory -----------------------------------------------------
  out.push('### Log files on this machine');
  out.push('');
  if (snapshot.logFiles.length === 0) {
    out.push('None.');
  } else {
    const shown = snapshot.logFiles.slice(0, REPORT_LIMITS.maxLogFilesListed);
    for (const file of shown) out.push(`- ${file.name} — ${formatBytes(file.bytes)}`);
    const dropped = snapshot.logFiles.length - shown.length;
    if (dropped > 0) out.push(`- …and ${dropped} more`);
  }
  out.push('');

  // ---- Attachments -------------------------------------------------------
  // The app attaches nothing; anything else in the issue the user added.
  out.push('### Files attached to this issue');
  out.push('');
  out.push(
    '*The app attached nothing and uploaded nothing. Anything else on this issue ' +
    'was dragged in by hand after this report was written.*'
  );
  out.push('');

  return out.join('\n');
}

/**
 * The "what was removed" block, from the redactor's counters. Contains
 * descriptions only, never the replaced values.
 */
function renderReceipt(receipt: readonly RedactionReceiptEntry[]): string {
  const out: string[] = [];
  out.push('### What was removed from this report');
  out.push('');

  if (receipt.length === 0) {
    out.push('Nothing needed removing — no user name, machine name, path or credential was found.');
    out.push('');
    return out.join('\n');
  }

  out.push('Before this report was written, the following was replaced with placeholders.');
  out.push('The same real value always becomes the same placeholder, so paths still line up.');
  out.push('');
  out.push('| Placeholder | What it stands for | Times replaced |');
  out.push('|---|---|---|');
  for (const entry of receipt) {
    out.push(`| \`${entry.placeholder}\` | ${entry.what} | ${entry.occurrences} |`);
  }
  out.push('');
  out.push('*Check the text above before you send it. You can edit anything out.*');
  out.push('');
  return out.join('\n');
}

export interface SupportReport {
  markdown: string;
  receipt: RedactionReceiptEntry[];
}

/**
 * Builds the report: render, redact, then append the receipt (which
 * describes the redaction pass, so it must come after).
 */
export function buildSupportReport(
  snapshot: SupportSnapshot,
  identity: RedactionIdentity
): SupportReport {
  const redactor = createRedactor(identity);

  const redactedBody = redactor.apply(renderBody(snapshot));
  const receipt = redactor.receipt();

  let markdown = `${redactedBody}\n${renderReceipt(receipt)}`;

  // Final backstop; the per-section caps should keep it well under.
  if (markdown.length > REPORT_LIMITS.maxReportChars) {
    markdown =
      `${markdown.slice(0, REPORT_LIMITS.maxReportChars)}\n\n` +
      '*[report truncated: it exceeded the maximum size]*\n';
  }

  return { markdown, receipt };
}
