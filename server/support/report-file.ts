/**
 * Writes the support report as a plain `.md` file on the Desktop for the user
 * to drag into a GitHub issue (GitHub has no attachment API, and an upload
 * would need a credential shipped in a public app). Optionally writes the
 * recent log as a `.txt` beside it.
 *
 * Text is redacted again here, at the point the file is created, even though
 * the builder already redacted it; the report and log share one Redactor so
 * placeholders agree across both files.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  RedactionIdentity,
  RedactionReceiptEntry,
  createRedactor,
  describePlaceholder
} from './redaction';

/**
 * Where the Desktop actually is. OneDrive's Known Folder Move often relocates
 * it to %USERPROFILE%\OneDrive\Desktop, so that is checked first. `exists` is
 * injected for tests.
 */
export function resolveDesktopDirectory(
  env: Record<string, string | undefined>,
  homedir: string,
  exists: (p: string) => boolean = fs.existsSync
): string {
  const profile = env['USERPROFILE'] ?? homedir;
  const oneDrive = env['OneDrive'] ?? env['OneDriveConsumer'] ?? env['OneDriveCommercial'];

  const candidates = [
    path.join(profile, 'Desktop'),
    ...(oneDrive ? [path.join(oneDrive, 'Desktop')] : [])
  ];

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  // No Desktop at all: fall back to the home folder.
  return homedir;
}

/**
 * `2026-11-08-180405`, the stamp both support files are named from. Seconds,
 * so a quick second report doesn't overwrite the first; shared, so the pair
 * carries the same stamp.
 */
export function supportFileTimestamp(when: Date): string {
  const iso = when.toISOString();
  const date = iso.slice(0, 10);
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${date}-${time}`;
}

/** `coin-inventory-problem-report-2026-11-08-180405.md`. */
export function reportFileName(when: Date): string {
  return `coin-inventory-problem-report-${supportFileTimestamp(when)}.md`;
}

export interface PreparedReport {
  /** Redacted text, exactly as it will be written. */
  text: string;
  receipt: RedactionReceiptEntry[];
}

/** Both files as they will be written, plus one receipt covering the pair. */
export interface PreparedSupportFiles {
  reportText: string;
  /** null when the reporter did not tick "Include recent log". */
  logText: string | null;
  receipt: RedactionReceiptEntry[];
}

/**
 * Redacts everything about to be written with one redactor. Redacting here
 * means no unredacted file can exist whoever the caller is; sharing the
 * instance keeps placeholders consistent between report and log. The report
 * goes first so its values get the low numbers.
 */
export function prepareSupportFiles(
  markdown: string,
  logText: string | null,
  identity: RedactionIdentity
): PreparedSupportFiles {
  const redactor = createRedactor(identity);
  const reportText = redactor.apply(markdown);
  const redactedLog = logText === null ? null : redactor.apply(logText);
  return { reportText, logText: redactedLog, receipt: redactor.receipt() };
}

/** The report on its own. */
export function prepareReportFile(
  markdown: string,
  identity: RedactionIdentity
): PreparedReport {
  const { reportText, receipt } = prepareSupportFiles(markdown, null, identity);
  return { text: reportText, receipt };
}

/**
 * The path with the user and machine names replaced, for the public issue
 * body. Uses a fresh redactor so the path doesn't inflate the report's receipt.
 */
export function redactReportPath(fullPath: string, identity: RedactionIdentity): string {
  return createRedactor(identity).apply(fullPath);
}

export interface WrittenReport {
  path: string;
  fileName: string;
  directory: string;
  bytes: number;
}

/**
 * Writes one support file under a caller-chosen name (so both files share a
 * timestamp) and returns where it went.
 */
export function writeSupportFile(
  directory: string,
  fileName: string,
  text: string
): WrittenReport {
  // Covers the home-folder fallback and test paths.
  fs.mkdirSync(directory, { recursive: true });

  const target = path.join(directory, fileName);
  fs.writeFileSync(target, text, 'utf8');

  return {
    path: target,
    fileName,
    directory,
    bytes: Buffer.byteLength(text, 'utf8')
  };
}

/** Writes the report to the Desktop. */
export function writeReportToDesktop(
  directory: string,
  text: string,
  when: Date = new Date()
): WrittenReport {
  return writeSupportFile(directory, reportFileName(when), text);
}

/** Exported for the report section that explains what the receipt means. */
export { describePlaceholder };
