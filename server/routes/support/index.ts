/**
 * "Help -> Report a problem", server side:
 *
 *   GET  /api/support/config    repository URL and output folder, for the
 *                               dialog's first screen. Reads and writes nothing.
 *   POST /api/support/preview   builds the report and returns it. Writes nothing.
 *   POST /api/support/report    writes the report as a `.md` on the Desktop,
 *                               plus an optional redacted `.txt` log.
 *
 * Preview and write are separate so nothing exists on disk until the user has
 * seen the report and pressed the button. No zip and no in-app attachments:
 * the user drags the files into the GitHub issue themselves. Nothing here
 * talks to GitHub; the frontend opens a pre-filled issue URL in the browser.
 *
 * `includeLog` off means no log content at all (no file, no tail in the body).
 * Both files share one Redactor (see prepareSupportFiles).
 *
 * Must work when the database doesn't: the collection counts are
 * best-effort, and a failure only shows as "could not be read".
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withDb } from '../../db';
import { listLogFiles, logError, logInfo, readRecentLogLines } from '../../logger';
import {
  prepareSupportFiles,
  redactReportPath,
  reportFileName,
  resolveDesktopDirectory,
  writeSupportFile
} from '../../support/report-file';
import { LOG_FILE_LIMITS, logFileName, renderLogFile } from '../../support/log-file';
import { identityFromEnvironment } from '../../support/redaction';
import {
  ClientError,
  REPORT_LIMITS,
  SupportCounts,
  buildSupportReport
} from '../../support/report';

const router = Router();

/** Overrides where the report is written (tests; the packaged build). */
const OUTPUT_DIR_ENV_VAR = 'COIN_SUPPORT_OUTPUT_DIR';

/**
 * Where issues are filed. The default is a placeholder, flagged by
 * `repositoryConfigured` so the dialog doesn't link to a 404.
 */
const REPO_URL_ENV_VAR = 'SUPPORT_REPO_URL';
const PLACEHOLDER_REPO_URL = 'https://github.com/OWNER/coin-inventory';

function repositoryUrl(): string {
  const configured = (process.env[REPO_URL_ENV_VAR] ?? '').trim();
  return configured.length > 0 ? configured : PLACEHOLDER_REPO_URL;
}

/** Where the file goes: the override, else the real Desktop, else home. */
function outputDirectory(): string {
  const override = (process.env[OUTPUT_DIR_ENV_VAR] ?? '').trim();
  if (override.length > 0) return path.resolve(override);
  return resolveDesktopDirectory(process.env, os.homedir());
}

/**
 * Reads `version` from a package.json without failing the report. Found by
 * walking up from this module, since the depth differs under tsx and dist.
 */
function readVersion(relativeFromServerRoot: string): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', relativeFromServerRoot),
    path.resolve(__dirname, '..', '..', '..', relativeFromServerRoot)
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        version?: unknown;
        buildNumber?: unknown;
      };
      if (typeof parsed.version !== 'string') continue;

      // The four-part version the title bar shows. `buildNumber` is separate
      // because `1.0.0.0` isn't valid semver; only the root package.json has
      // one, so the server reads as `1.0.0`.
      return typeof parsed.buildNumber === 'number'
        ? `${parsed.version}.${parsed.buildNumber}`
        : parsed.version;
    } catch {
      // Missing or not JSON: try the next layout.
    }
  }
  return 'unknown';
}

/**
 * Collection size, counts only. The only database access in this feature;
 * the query has no column list that could be widened to return content.
 */
async function readCounts(): Promise<{ counts: SupportCounts | null; error?: string }> {
  try {
    const result = await withDb(async (db) =>
      db.request().query(
        // Pure COUNT(*)s, so no content can leak.
        `SELECT
           (SELECT COUNT(*) FROM Coins)        AS coins,
           (SELECT COUNT(*) FROM CoinImages)   AS photos,
           (SELECT COUNT(*) FROM Coins WHERE SoldDate IS NOT NULL
                                          OR SoldPrice IS NOT NULL) AS soldCoins`
      )
    );

    const row = (result as { recordset?: Array<Record<string, unknown>> }).recordset?.[0];
    if (!row) return { counts: null, error: 'the database returned no answer' };

    return {
      counts: {
        coins: Number(row['coins'] ?? 0),
        photos: Number(row['photos'] ?? 0),
        soldCoins: Number(row['soldCoins'] ?? 0)
      }
    };
  } catch (err) {
    // Not an error response (see the module header).
    return { counts: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The identity the redactor scrubs. Read per request, never cached. */
function currentIdentity() {
  return identityFromEnvironment(process.env, os.hostname(), os.homedir());
}

/**
 * Did the caller ask for the log? Defaults to true, like the checkbox. The
 * write response reports what was actually written.
 */
function wantsLog(body: Record<string, unknown>): boolean {
  return body['includeLog'] !== false;
}

/** Defensive coercion; this body comes from the renderer. */
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

// GET /api/support/config

/**
 * Everything the dialog needs before building anything, chiefly the
 * repository link for the first screen. `repositoryConfigured` is false while
 * the URL is still the placeholder.
 */
router.get('/support/config', (_req: Request, res: Response) => {
  res.json({
    repositoryUrl: repositoryUrl(),
    repositoryConfigured: repositoryUrl() !== PLACEHOLDER_REPO_URL,
    outputDirectory: outputDirectory()
  });
});

// POST /api/support/preview

router.post('/support/preview', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { counts, error } = await readCounts();
    const includeLog = wantsLog(body);

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
        // Not even read when unticked.
        logLines: includeLog ? readRecentLogLines(REPORT_LIMITS.maxLogLines) : [],
        logFiles: listLogFiles(),
        includeLog,
        userDescription:
          typeof body['userDescription'] === 'string' ? body['userDescription'] : undefined
      },
      currentIdentity()
    );

    res.json({ markdown, receipt });
  } catch (err) {
    // Log and report the failure rather than leaving the dialog hanging.
    logError('Support preview failed', err);
    res.status(500).json({ error: 'Could not build the problem report.' });
  }
});

// POST /api/support/report

router.post('/support/report', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const markdown = body['markdown'];
    if (typeof markdown !== 'string' || markdown.trim().length === 0) {
      res.status(400).json({ error: 'The report text is missing.' });
      return;
    }

    const identity = currentIdentity();
    const directory = outputDirectory();
    const includeLog = wantsLog(body);

    // One timestamp for both files.
    const when = new Date();
    const reportName = reportFileName(when);

    // Read the log here, not from the request, so unredacted lines never
    // round-trip through the browser.
    const rawLog = includeLog
      ? renderLogFile(readRecentLogLines(LOG_FILE_LIMITS.maxLines), {
          generatedAt: when,
          reportFileName: reportName
        })
      : null;

    // One redactor for both files.
    const prepared = prepareSupportFiles(markdown, rawLog, identity);

    const written = writeSupportFile(directory, reportName, prepared.reportText);
    const writtenLog =
      prepared.logText === null
        ? null
        : writeSupportFile(directory, logFileName(when), prepared.logText);

    // The full path, since the server may be on a different machine from the user.
    logInfo(`Support report written: ${written.path} (${written.bytes} bytes)`);
    if (writtenLog) {
      logInfo(`Support log written: ${writtenLog.path} (${writtenLog.bytes} bytes)`);
    }

    res.json({
      path: written.path,
      // For the public issue body (see redactReportPath).
      redactedPath: redactReportPath(written.path, identity),
      fileName: written.fileName,
      directory: written.directory,
      bytes: written.bytes,
      /** What was actually written (null if no log); the dialog and issue body use this. */
      log: writtenLog
        ? {
            path: writtenLog.path,
            redactedPath: redactReportPath(writtenLog.path, identity),
            fileName: writtenLog.fileName,
            bytes: writtenLog.bytes
          }
        : null,
      receipt: prepared.receipt
    });
  } catch (err) {
    logError('Support report write failed', err);
    res.status(500).json({ error: 'Could not write the problem report file.' });
  }
});

export default router;
