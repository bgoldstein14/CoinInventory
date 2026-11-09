/**
 * support/bundle.ts — assembles and writes the .zip the user attaches.
 *
 * A FILE ON THE DESKTOP, NOT AN UPLOAD. GitHub has no API for issue
 * attachments; the only way a file reaches an issue is a human dragging it
 * into the comment box. Uploading instead would mean shipping a credential in
 * a public desktop application, where any token that can file an issue can be
 * extracted from the binary — so nothing here authenticates to anything. The
 * Desktop is the destination because it is the one folder every Windows user
 * can find, and dragging into a browser is the next thing they must do.
 *
 * THE ASYMMETRY AT THE HEART OF THIS FILE. The report and the log tail are
 * REDACTED. The user's own attachments are NOT: a QIF with `<USER>`
 * substituted into it is a corrupt QIF, and the whole point of attaching it
 * is that it can be replayed. What protects the user there is not scrubbing
 * but CONSENT — nothing is attached unless they picked it, file by file,
 * after a blunt warning that the issue is public and that a QIF or
 * spreadsheet may contain their entire financial position.
 *
 * Attachment NAMES are redacted, and that is not inconsistent: a name is
 * metadata the user did not choose to publish, it is stored uncompressed in
 * the archive listing, and redacting it cannot corrupt anything.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  RedactionIdentity,
  RedactionReceiptEntry,
  createRedactor,
  describePlaceholder
} from './redaction';
import { ZipEntry, createZip, safeZipEntryName } from './zip';

/**
 * Attachment caps.
 *
 * Sized for what people actually attach: a QIF export of a large collection
 * is tens of kilobytes, a photographed spreadsheet a few megabytes. 10 MB
 * per file leaves enormous headroom while making it impossible to
 * accidentally bundle a 4 GB photo library, and 25 MB total keeps the zip
 * under GitHub's own 25 MB attachment limit so the user is never told to
 * drag in a file GitHub will refuse.
 */
export const ATTACHMENT_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024
} as const;

/** How much log goes in the zip — far more than the summary in the issue body. */
export const BUNDLE_LOG_LINES = 2000;

/** A file the user explicitly chose. */
export interface ChosenFile {
  name: string;
  content: Buffer;
}

export interface AttachmentDecision {
  accepted: ChosenFile[];
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Apply the caps, and say what was turned away and why.
 *
 * Returning reasons rather than silently dropping matters: a user who
 * attached their spreadsheet and does not see it in the zip will assume the
 * feature is broken. A support channel that silently drops things is worse
 * than none.
 */
export function validateAttachments(files: readonly ChosenFile[]): AttachmentDecision {
  const accepted: ChosenFile[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  let total = 0;

  for (const file of files) {
    if (accepted.length >= ATTACHMENT_LIMITS.maxFiles) {
      rejected.push({
        name: file.name,
        reason: `only ${ATTACHMENT_LIMITS.maxFiles} files can be attached to one report`
      });
      continue;
    }

    if (file.content.length > ATTACHMENT_LIMITS.maxFileBytes) {
      rejected.push({
        name: file.name,
        reason: `too large — the limit is ${ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024)} MB per file`
      });
      continue;
    }

    if (total + file.content.length > ATTACHMENT_LIMITS.maxTotalBytes) {
      rejected.push({
        name: file.name,
        reason: `would take the total over ${ATTACHMENT_LIMITS.maxTotalBytes / (1024 * 1024)} MB`
      });
      continue;
    }

    accepted.push(file);
    total += file.content.length;
  }

  return { accepted, rejected };
}

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
 * `coin-inventory-problem-report-2026-11-08-180405.zip`.
 *
 * SECONDS, not minutes. A user who reports a problem, is asked a question and
 * reports again straight away would otherwise silently overwrite the first
 * file with the second, under an identical name.
 */
export function bundleFileName(when: Date): string {
  const iso = when.toISOString();
  const date = iso.slice(0, 10);
  const time = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `coin-inventory-problem-report-${date}-${time}.zip`;
}

/**
 * Make a redacted string safe to use as a FILE name.
 *
 * `<` and `>` are illegal in Windows file names, so an entry literally named
 * `<USER>-holdings.qif` produces an archive Explorer refuses to extract.
 * Parentheses carry the same "this is a placeholder" signal and are legal
 * everywhere.
 */
function fileSafePlaceholders(name: string): string {
  return name.replace(/</g, '(').replace(/>/g, ')');
}

/** Plain-text version of the receipt, for people who open the zip directly. */
function renderReceiptText(receipt: readonly RedactionReceiptEntry[]): string {
  if (receipt.length === 0) {
    return 'Nothing in this report needed redacting.\n';
  }

  const lines = [
    'The following was replaced with placeholders before this report was written.',
    'The same real value always becomes the same placeholder.',
    'The real values are NOT recorded anywhere in this archive.',
    ''
  ];
  for (const entry of receipt) {
    lines.push(`${entry.placeholder}  ${entry.what}  (${entry.occurrences}x)`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface BundleInput {
  /** The report text the user approved — possibly edited by them. */
  markdown: string;
  /** Raw log lines for the zip's fuller copy. Redacted here. */
  logTail: readonly string[];
  /** Files the user explicitly chose. Content goes in untouched. */
  attachments: readonly ChosenFile[];
  identity: RedactionIdentity;
  when?: Date;
}

export interface BuiltBundle {
  zip: Buffer;
  entries: string[];
  receipt: RedactionReceiptEntry[];
}

/**
 * Build the archive.
 *
 * THE REPORT IS REDACTED AGAIN HERE even though the preview was already
 * redacted, because the user then EDITED it — that is the point of the
 * preview. "I was looking at C:\Users\dave\Pictures when it crashed" is a
 * natural thing to type into that box, and without a second pass it goes into
 * a public archive verbatim. The pass is idempotent on already-clean text
 * (placeholders contain no username and no machine name).
 */
export function buildBundleZip(input: BundleInput): BuiltBundle {
  const redactor = createRedactor(input.identity);

  const report = redactor.apply(input.markdown);
  const logText = input.logTail.map(line => redactor.apply(line)).join('\n');

  const entries: ZipEntry[] = [
    { name: 'report.md', data: report },
    { name: 'logs/recent.log', data: logText.length > 0 ? `${logText}\n` : '(no log lines)\n' }
  ];

  for (const file of input.attachments) {
    // Name redacted, content untouched. See the module header for why those
    // two are treated differently.
    const base = path.basename(safeZipEntryName(file.name));
    const safeName = fileSafePlaceholders(redactor.apply(base));
    entries.push({ name: `attachments/${safeName}`, data: file.content });
  }

  // The receipt is appended LAST because it can only be written once every
  // other pass has run — it is a report of what those passes did.
  const receipt = redactor.receipt();
  entries.push({ name: 'redaction-receipt.txt', data: renderReceiptText(receipt) });

  return {
    zip: createZip(entries, input.when ?? new Date()),
    entries: entries.map(e => safeZipEntryName(e.name)),
    receipt
  };
}

export interface WrittenBundle {
  path: string;
  fileName: string;
  directory: string;
  bytes: number;
}

/** Write the archive and say exactly where it went, so the UI can quote it. */
export function writeBundleToDesktop(
  directory: string,
  zip: Buffer,
  when: Date = new Date()
): WrittenBundle {
  // The Desktop normally exists; this covers the fallback-to-homedir case and
  // the test that points at a path one level deeper.
  fs.mkdirSync(directory, { recursive: true });

  const fileName = bundleFileName(when);
  const target = path.join(directory, fileName);
  fs.writeFileSync(target, zip);

  return { path: target, fileName, directory, bytes: zip.length };
}

/** Exported for the report section that explains what the receipt means. */
export { describePlaceholder };
