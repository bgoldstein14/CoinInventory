/**
 * routes/support/index.ts — "Help → Report a problem", server side.
 *
 * TWO ENDPOINTS, AND THE LINE BETWEEN THEM IS CONSENT
 *   POST /api/support/preview   builds the report and returns it. Touches
 *                               no disk. The user has agreed to nothing yet,
 *                               so nothing exists yet.
 *
 *   POST /api/support/bundle    takes the text the user APPROVED (and
 *                               possibly edited) plus the files they
 *                               explicitly chose, and writes one zip.
 *
 * Splitting them is the whole design: a single call that generated and wrote
 * in one step would mean the artefact exists before the user has seen it. The
 * rule is preview, with the ability to remove anything, and never upload
 * automatically.
 *
 * NOTHING HERE TALKS TO GITHUB
 * No token is shipped, no request is made. The frontend opens a pre-filled
 * issue URL in the user's own browser and the user drags the zip in. GitHub
 * has no API for issue attachments anyway, and a credential in a public
 * desktop application can be extracted and abused.
 *
 * ATTACHMENTS ARRIVE AS CONTENT, NEVER AS PATHS
 * `{ name, contentBase64 }`, and a request that supplies a path instead is
 * rejected outright. Accepting a path would make this an arbitrary-file
 * reader reachable from any local process — the same class of problem as
 * /api/images/file — and would let a bug attach a file the user never picked.
 * The browser already has the bytes from the file input.
 *
 * IT MUST WORK WHEN EVERYTHING ELSE DOES NOT
 * The collection counts come from the database, and the database being
 * unreachable is one of the likeliest reasons somebody is filing a report.
 * So the count query is best-effort: a failure becomes "could not be read"
 * in the report and changes nothing else. This router never returns an error
 * because the database is down.
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withDb } from '../../db';
import { listLogFiles, logError, logInfo, readRecentLogLines } from '../../logger';
import {
  ATTACHMENT_LIMITS,
  BUNDLE_LOG_LINES,
  ChosenFile,
  buildBundleZip,
  resolveDesktopDirectory,
  validateAttachments,
  writeBundleToDesktop
} from '../../support/bundle';
import { identityFromEnvironment } from '../../support/redaction';
import {
  ClientError,
  FileSummary,
  REPORT_LIMITS,
  SupportCounts,
  buildSupportReport
} from '../../support/report';

const router = Router();

/**
 * Overrides where the zip is written.
 *
 * Exists for the tests — no test may write to the developer's real Desktop —
 * and for the packaged build, which puts user-writable files under
 * %LOCALAPPDATA% and may want to be explicit about it.
 */
const OUTPUT_DIR_ENV_VAR = 'COIN_SUPPORT_OUTPUT_DIR';

/**
 * Where issues are filed. The default below is a PLACEHOLDER and the response
 * says so explicitly via `repositoryConfigured`, because the one thing worse
 * than no support button is one that opens a 404 and leaves the user
 * believing they have been heard.
 */
const REPO_URL_ENV_VAR = 'SUPPORT_REPO_URL';
const PLACEHOLDER_REPO_URL = 'https://github.com/OWNER/coin-inventory';

function repositoryUrl(): string {
  const configured = (process.env[REPO_URL_ENV_VAR] ?? '').trim();
  return configured.length > 0 ? configured : PLACEHOLDER_REPO_URL;
}

/** Where the zip goes: the override, else the real Desktop, else home. */
function outputDirectory(): string {
  const override = (process.env[OUTPUT_DIR_ENV_VAR] ?? '').trim();
  if (override.length > 0) return path.resolve(override);
  return resolveDesktopDirectory(process.env, os.homedir());
}

/**
 * Read a `version` out of a package.json, without letting a missing or
 * malformed file break the report.
 *
 * Resolved by walking up from this module rather than from `process.cwd()`,
 * for the tsx-vs-compiled-dist reason routes/app-info.ts documents: this file
 * runs from `server/routes/support` under tsx and `server/dist/routes/support`
 * when compiled.
 */
function readVersion(relativeFromServerRoot: string): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', relativeFromServerRoot),
    path.resolve(__dirname, '..', '..', '..', relativeFromServerRoot)
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Not there, or not JSON. Try the next layout.
    }
  }
  return 'unknown';
}

/**
 * How big the collection is. COUNTS ONLY — this is the only database access
 * the whole feature makes, and the query is written so that it CANNOT return
 * content even if someone later edits it carelessly: there is no column list
 * to accidentally widen.
 */
async function readCounts(): Promise<{ counts: SupportCounts | null; error?: string }> {
  try {
    const result = await withDb(async (db) =>
      db.request().query(
        `SELECT
           (SELECT COUNT(*) FROM Coins)        AS coins,
           (SELECT COUNT(*) FROM CoinImages)   AS photos,
           (SELECT COUNT(*) FROM Transactions) AS transactions`
      )
    );

    const row = (result as { recordset?: Array<Record<string, unknown>> }).recordset?.[0];
    if (!row) return { counts: null, error: 'the database returned no answer' };

    return {
      counts: {
        coins: Number(row['coins'] ?? 0),
        photos: Number(row['photos'] ?? 0),
        transactions: Number(row['transactions'] ?? 0)
      }
    };
  } catch (err) {
    // Deliberately NOT an error response. See the module header.
    return { counts: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The identity the redactor scrubs. Read per request, never cached. */
function currentIdentity() {
  return identityFromEnvironment(process.env, os.hostname(), os.homedir());
}

/** Defensive coercion — this body comes from the renderer, so it is input. */
function asClientErrors(value: unknown): ClientError[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map(entry => ({
      timestamp: String(entry['timestamp'] ?? ''),
      message: String(entry['message'] ?? ''),
      details: entry['details'] === undefined ? undefined : String(entry['details'])
    }))
    .filter(entry => entry.message.length > 0);
}

function asFileSummaries(value: unknown): FileSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map(entry => ({
      name: String(entry['name'] ?? 'file'),
      bytes: Number(entry['bytes'] ?? 0) || 0
    }));
}

// POST /api/support/preview

router.post('/support/preview', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { counts, error } = await readCounts();

    const { markdown, receipt } = buildSupportReport(
      {
        generatedAt: new Date().toISOString(),
        appVersion: readVersion('package.json'),
        serverVersion: readVersion(path.join('server', 'package.json')),
        nodeVersion: process.version,
        platform: process.platform,
        osRelease: os.release(),
        arch: process.arch,
        counts,
        countsError: error,
        clientErrors: asClientErrors(body['clientErrors']),
        logLines: readRecentLogLines(REPORT_LIMITS.maxLogLines),
        logFiles: listLogFiles(),
        attachments: asFileSummaries(body['attachments']),
        userDescription:
          typeof body['userDescription'] === 'string' ? body['userDescription'] : undefined
      },
      currentIdentity()
    );

    res.json({
      markdown,
      receipt,
      outputDirectory: outputDirectory(),
      repositoryUrl: repositoryUrl(),
      repositoryConfigured: repositoryUrl() !== PLACEHOLDER_REPO_URL,
      limits: {
        maxFiles: ATTACHMENT_LIMITS.maxFiles,
        maxFileBytes: ATTACHMENT_LIMITS.maxFileBytes,
        maxTotalBytes: ATTACHMENT_LIMITS.maxTotalBytes
      }
    });
  } catch (err) {
    // A failure here must not be silent: the user pressed a button and is
    // waiting. Log it and say so plainly rather than hanging the dialog.
    logError('Support preview failed', err);
    res.status(500).json({ error: 'Could not build the problem report.' });
  }
});

// POST /api/support/bundle

/**
 * Turn the request's attachment list into buffers, or explain why not.
 *
 * Rejecting a `path` property outright — rather than ignoring it — is
 * deliberate. Silently accepting the request minus the attachment would
 * leave a caller believing a file went in when it did not, and a loud 400 is
 * how a mistake in the renderer gets noticed during development instead of
 * in a user's published issue.
 */
function decodeAttachments(value: unknown): { files: ChosenFile[] } | { error: string } {
  if (value === undefined || value === null) return { files: [] };
  if (!Array.isArray(value)) return { error: 'attachments must be a list' };

  const files: ChosenFile[] = [];

  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return { error: 'each attachment must be an object' };
    const entry = raw as Record<string, unknown>;

    if ('path' in entry) {
      return {
        error:
          'attachments must be sent as content, not as a path — the server never reads files on its own'
      };
    }

    const name = typeof entry['name'] === 'string' && entry['name'].length > 0
      ? entry['name']
      : 'attachment';
    const encoded = entry['contentBase64'];
    if (typeof encoded !== 'string') return { error: `attachment "${name}" has no content` };

    files.push({ name, content: Buffer.from(encoded, 'base64') });
  }

  return { files };
}

router.post('/support/bundle', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const markdown = body['markdown'];
    if (typeof markdown !== 'string' || markdown.trim().length === 0) {
      res.status(400).json({ error: 'The report text is missing.' });
      return;
    }

    const decoded = decodeAttachments(body['attachments']);
    if ('error' in decoded) {
      res.status(400).json({ error: decoded.error });
      return;
    }

    const { accepted, rejected } = validateAttachments(decoded.files);

    const { zip, entries, receipt } = buildBundleZip({
      markdown,
      logTail: readRecentLogLines(BUNDLE_LOG_LINES),
      attachments: accepted,
      identity: currentIdentity()
    });

    const written = writeBundleToDesktop(outputDirectory(), zip);

    // Worth a log line: when a user says "I sent you a report" and no issue
    // exists, this is how to tell whether the file was ever made.
    logInfo(`Support bundle written: ${written.fileName} (${written.bytes} bytes)`);

    res.json({
      path: written.path,
      fileName: written.fileName,
      directory: written.directory,
      bytes: written.bytes,
      entries,
      receipt,
      rejected
    });
  } catch (err) {
    logError('Support bundle failed', err);
    res.status(500).json({ error: 'Could not write the problem report file.' });
  }
});

export default router;
