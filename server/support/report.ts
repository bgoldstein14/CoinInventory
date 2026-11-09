/**
 * support/report.ts — turns a snapshot of "what is going on" into the text
 * the user will read, edit, and then publish.
 *
 * THE SHAPE OF THE PROMISE
 * This text is going to end up in a PUBLIC issue tracker. Everything in it
 * is therefore governed by two rules that are easy to state and easy to
 * break by accident:
 *
 *   COUNTS, NOT CONTENT   The collection is described by how many coins,
 *                         photos and transactions there are. Not one coin,
 *                         price, note, grade or photo path. "How big" is a
 *                         useful debugging fact; "what is in it" is the
 *                         user's private financial position.
 *
 *   REDACT BEFORE WRITE   The markdown is redacted here, in the builder,
 *                         before it is returned — not on the way out to the
 *                         network. There is never an unredacted artefact
 *                         lying around for somebody to attach by mistake.
 *
 * EVERYTHING IS CAPPED
 * An uncapped report is the same failure as an uncapped log: too big to send
 * is indistinguishable from not sent. Every list here has a limit and says
 * out loud how much it dropped, because a silently truncated log is worse
 * than a short one — the reader does not know what they are missing.
 *
 * WHY THE RECEIPT IS GENERATED, NOT WRITTEN
 * The "what was removed" section is built from the redactor's own counters
 * after the pass has run. A hand-written list ("we remove usernames and
 * machine names") would be a claim; this is a report of what actually
 * happened to this particular text, and it cannot drift from the rules.
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
  /** Oldest first, as readRecentLogLines returns them. */
  logLines: string[];
  logFiles: FileSummary[];
  attachments: FileSummary[];
  /** The user's own description of the problem, if they typed one first. */
  userDescription?: string;
}

/**
 * The caps.
 *
 * `maxLogLines` is the one worth arguing about. 150 lines is roughly the last
 * two or three minutes of a busy session, which is where the cause of a
 * just-reported bug almost always is — and the full day's log is in the zip
 * anyway, so nothing is actually lost by keeping the readable summary short.
 *
 * `maxLineChars` exists because a single base64 image payload or a serialised
 * HttpErrorResponse can be tens of kilobytes on one line, which would blow
 * the whole budget on one entry.
 */
export const REPORT_LIMITS = {
  maxLogLines: 150,
  maxClientErrors: 20,
  maxLogFilesListed: 30,
  maxAttachmentsListed: 20,
  maxLineChars: 500,
  maxUserDescriptionChars: 4000,
  /** Final backstop. Nothing should reach it; if it does, the report says so. */
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

/**
 * Render the un-redacted body.
 *
 * Kept as one function returning a string rather than a template-literal soup
 * so that the section order is visible at a glance.
 */
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
    // Newest first: the one that made the user press the button is the one
    // worth reading, and it is the last one recorded.
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
  out.push('### Recent log lines');
  out.push('');
  if (snapshot.logLines.length === 0) {
    out.push('No log lines were available.');
  } else {
    const shown = snapshot.logLines.slice(-REPORT_LIMITS.maxLogLines);
    const dropped = snapshot.logLines.length - shown.length;
    if (dropped > 0) {
      out.push(`*${dropped} earlier line${dropped === 1 ? '' : 's'} omitted. The full log is in the attached zip.*`);
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
  out.push('### Files you chose to attach');
  out.push('');
  if (snapshot.attachments.length === 0) {
    out.push('No files were attached.');
  } else {
    out.push('*These are in the zip because you chose them, file by file. Nothing is attached automatically.*');
    out.push('');
    const shown = snapshot.attachments.slice(0, REPORT_LIMITS.maxAttachmentsListed);
    for (const file of shown) out.push(`- \`${file.name}\` — ${formatBytes(file.bytes)}`);
    const dropped = snapshot.attachments.length - shown.length;
    if (dropped > 0) out.push(`- …and ${dropped} more`);
  }
  out.push('');

  return out.join('\n');
}

/**
 * The "what was removed" block, rendered from the redactor's own counters.
 *
 * NOTE WHAT IS NOT HERE: the replaced values. `describePlaceholder` returns a
 * description, never a value, and there is a canary test asserting this
 * section cannot be made to echo a secret back into the document it was just
 * removed from.
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
 * Build the report: render, redact, then append the receipt.
 *
 * THE ORDER IS THE WHOLE DESIGN. The receipt can only be written after the
 * redaction pass, because it is a report OF that pass; and the redaction pass
 * must happen before anything is returned, because the caller writes what it
 * gets straight to a file on the Desktop.
 */
export function buildSupportReport(
  snapshot: SupportSnapshot,
  identity: RedactionIdentity
): SupportReport {
  const redactor = createRedactor(identity);

  const redactedBody = redactor.apply(renderBody(snapshot));
  const receipt = redactor.receipt();

  let markdown = `${redactedBody}\n${renderReceipt(receipt)}`;

  // Final backstop. Nothing above should get near it — the per-section caps
  // bound the total — but a report that silently exceeded every limit and
  // still went out would be a worse failure than one that says it was cut.
  if (markdown.length > REPORT_LIMITS.maxReportChars) {
    markdown =
      `${markdown.slice(0, REPORT_LIMITS.maxReportChars)}\n\n` +
      '*[report truncated: it exceeded the maximum size]*\n';
  }

  return { markdown, receipt };
}
