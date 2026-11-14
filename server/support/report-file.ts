/**
 * support/report-file.ts — writes the report the user attaches, as a plain
 * `.md` file on the Desktop.
 *
 * THERE IS NO ZIP, AND THAT IS THE POINT
 * This module used to build an archive. It does not any more. Zipping gains
 * nothing on a report that is already text and actively hides a JPG: GitHub
 * renders a dragged-in image inline in the issue, where the same image inside
 * a zip is invisible until somebody downloads and extracts it. A reporter with
 * a lot to send can zip it themselves; the app has no business doing it for
 * them.
 *
 * A FILE ON THE DESKTOP, NOT AN UPLOAD. GitHub has no official API for issue
 * attachments; the only way a file reaches an issue is a human dragging it
 * into the comment box. Uploading instead would mean shipping a credential in
 * a public desktop application, where any token that can file an issue can be
 * extracted from the binary — so nothing here authenticates to anything. The
 * Desktop is the destination because it is the one folder every Windows user
 * can find, and dragging into a browser is the next thing they must do.
 *
 * THERE ARE NO ATTACHMENTS HERE EITHER, AND NO SIZE CAPS
 * The in-app file picker was removed with the zip: with no archive there was
 * nowhere for a staged file to go, and collecting files only to drop them is
 * worse than not offering. The per-file and total caps went with it — they
 * existed to bound an archive this module no longer builds. GitHub enforces
 * its own 25 MB on what the user drags in, which is the only place a limit
 * can now be applied.
 *
 * WHAT IS LEFT IS REDACTION, AND IT IS UNTOUCHED
 * The text handed to this module arrives from the renderer, so it is input.
 * It is redacted again on the way to disk even though the builder already
 * redacted it: the pass is idempotent on clean text, and redacting at the
 * boundary where the artefact is created is the one place the rule cannot be
 * routed around.
 *
 * THERE MAY BE A SECOND FILE, AND IT IS STILL NOT AN ARCHIVE
 * When the reporter ticks "Include recent log", a plain `.txt` is written
 * beside the report — two draggable files, not a zip. It goes through
 * `prepareSupportFiles` with the report, sharing ONE `Redactor` instance, so
 * a path replaced in one reads identically in the other. That sharing is a
 * correctness requirement; see that function's comment for what breaks
 * without it.
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
 * Where "the Desktop" actually is.
 *
 * NOT just `path.join(os.homedir(), 'Desktop')`: OneDrive's Known Folder Move
 * is on by default on many consumer Windows installs and relocates the
 * Desktop to `%USERPROFILE%\OneDrive\Desktop`, leaving the profile Desktop
 * missing or an empty stub. Writing there and then saying "it is on your
 * Desktop" sends the user looking for a file that is not where they look.
 *
 * `exists` is injected so the tests can describe a machine without having one.
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

  // No Desktop at all (a server, a stripped profile, a non-Windows dev box).
  // The home folder is always somewhere the user can be directed to.
  return homedir;
}

/**
 * `2026-11-08-180405`, the stamp both support files are named from.
 *
 * SECONDS, not minutes. A user who reports a problem, is asked a question and
 * reports again straight away would otherwise silently overwrite the first
 * file with the second, under an identical name.
 *
 * SHARED, so the report and the optional log file carry the SAME stamp and
 * are obviously a pair on a Desktop that may hold several of each. Two
 * independent `new Date()` calls would differ by a second often enough to
 * matter and never often enough to notice in a test.
 */
export function supportFileTimestamp(when: Date): string {
  const iso = when.toISOString();
  const date = iso.slice(0, 10);
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${date}-${time}`;
}

/**
 * `coin-inventory-problem-report-2026-11-08-180405.md`.
 *
 * `.md` because that is what the file is. GitHub's attachment allow-list
 * accepts it, it opens in Notepad, and the user can read the thing they are
 * about to publish without extracting anything first.
 */
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
 * Redact everything that is about to be written, with ONE redactor.
 *
 * THE HOLE THIS CLOSES: this endpoint takes markdown from the renderer. The
 * builder redacts what it produces, but nothing stops a future caller — or a
 * bug — handing over something that never went through it. One pass here, at
 * the point the file is created, means no unredacted artefact can exist on
 * disk regardless of who called.
 *
 * THE SHARED INSTANCE IS LOAD-BEARING, NOT AN OPTIMISATION. `createRedactor`
 * allocates placeholders in first-seen order against its own table. Redacting
 * the report and the log separately would let the same folder become `<USER2>`
 * in one file and `<USER3>` in the other — and the pair would then actively
 * mislead a reader into thinking two different accounts were involved, which
 * is worse than either file alone. One instance, one table, one receipt
 * covering both files.
 *
 * ORDER MATTERS ONLY FOR READABILITY: the report is redacted first so that the
 * values a reader meets first in the report keep the low numbers.
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

/** The report on its own. A thin wrapper; the pair-aware form is above. */
export function prepareReportFile(
  markdown: string,
  identity: RedactionIdentity
): PreparedReport {
  const { reportText, receipt } = prepareSupportFiles(markdown, null, identity);
  return { text: reportText, receipt };
}

/**
 * The same path, with the user name and machine name replaced. Used for the
 * report file's path and, when one was written, the log file's.
 *
 * WHY THIS EXISTS. The full path goes into the issue body so the user can see
 * where their report file is while they are on the page that needs it — and
 * the issue body is PUBLIC. A raw `C:\Users\dave\Desktop\...` would re-publish
 * exactly the thing every other line of this feature removes. The redacted
 * form still tells the user everything they need: they know who they are, and
 * the file name is the part they have to recognise.
 *
 * A FRESH REDACTOR ON PURPOSE. The receipt shown to the user is a report of
 * what was taken out of the REPORT; folding the path's replacements into it
 * would inflate those counts with something that is not in the document.
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
 * Write one support file under a name the caller chose, and say exactly where
 * it went so the UI can quote it.
 *
 * The caller names the file because there are now two of them — the report and
 * the optional log — and they must share a timestamp. Deciding the name in
 * here would mean two `new Date()` calls and a pair that occasionally
 * disagrees by a second.
 */
export function writeSupportFile(
  directory: string,
  fileName: string,
  text: string
): WrittenReport {
  // The Desktop normally exists; this covers the fallback-to-homedir case and
  // the test that points at a path one level deeper.
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

/** Write the report. The name is derived; the generic writer is above. */
export function writeReportToDesktop(
  directory: string,
  text: string,
  when: Date = new Date()
): WrittenReport {
  return writeSupportFile(directory, reportFileName(when), text);
}

/** Exported for the report section that explains what the receipt means. */
export { describePlaceholder };
