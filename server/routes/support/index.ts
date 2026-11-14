/**
 * routes/support/index.ts — "Help → Report a problem", server side.
 *
 * THREE ENDPOINTS, AND THE LINE BETWEEN THEM IS CONSENT
 *   GET  /api/support/config    where issues are filed and where the report
 *                               will be written. Reads nothing, writes
 *                               nothing. The dialog needs this on the FIRST
 *                               screen so it can offer the repository as a
 *                               real clickable link before anything is built.
 *
 *   POST /api/support/preview   builds the report and returns it. Touches no
 *                               disk. The user has agreed to nothing yet, so
 *                               nothing exists yet.
 *
 *   POST /api/support/report    takes that text and writes a plain `.md`
 *                               file to the Desktop — plus, if the reporter
 *                               asked for it, a plain `.txt` of the recent
 *                               log beside it.
 *
 * Splitting preview from write is the whole design: a single call that
 * generated and wrote in one step would mean the artefact exists the moment
 * the dialog wants to display anything. The dialog builds the report to show
 * the user what is in it — in summary always, in full on request — and only
 * writes when they press the button.
 *
 * NO ZIP, AND NO ATTACHMENTS
 * The write endpoint produces plain files, not an archive. Zipping a report
 * that is already text gains nothing, and zipping a JPG actively hides it:
 * GitHub renders a dragged-in image inline, where the same image inside a zip
 * is invisible until someone extracts it. Two draggable files is still not an
 * archive; it is two draggable files.
 *
 * `includeLog` IS A SAFETY FEATURE, NOT A CONVENIENCE
 * Removing the zip removed the only REDACTED log a user could share, leaving
 * the raw `app.log` — account name, machine name, photo paths — as the only
 * thing to hand for a PUBLIC issue. Ticking the box writes a redacted 2,000
 * line `.txt` beside the report instead. Unticking it means NO LOG CONTENT AT
 * ALL: no second file, and no log tail in the report body either, because
 * leaving 150 lines behind would make the unticked state a half-truth.
 *
 * Both files go through ONE `Redactor` instance (`prepareSupportFiles`). Two
 * independent passes would assign different placeholders to the same path and
 * the pair would mislead a reader about how many accounts were involved.
 *
 * The in-app file picker went with the zip. The app cannot upload to GitHub —
 * there is no official attachment API, only undocumented routes that disagree
 * about whether a token even works — so with no archive there was nowhere for
 * a staged file to go. Collecting files and then dropping them is worse than
 * not offering. The user attaches their own files by dragging them into the
 * issue, and the dialog says so with a clickable link.
 *
 * Consequently there are NO SIZE CAPS here. They bounded an archive that is
 * no longer built; GitHub enforces its own 25 MB on what the user drags in.
 *
 * NOTHING HERE TALKS TO GITHUB
 * No token is shipped, no request is made. The frontend opens a pre-filled
 * issue URL in the user's own browser and the user presses Submit there.
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

/**
 * Overrides where the report is written.
 *
 * Exists for the tests — no test may write to the developer's real Desktop —
 * and for the packaged build, which puts user-writable files under
 * %LOCALAPPDATA% and may want to be explicit about it.
 */
const OUTPUT_DIR_ENV_VAR = 'COIN_SUPPORT_OUTPUT_DIR';

/**
 * Where issues are filed. The default below is a PLACEHOLDER and the response
 * says so explicitly via `repositoryConfigured`, because the one thing worse
 * than no support button is one that links to a 404 and leaves the user
 * believing they have been heard.
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
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        version?: unknown;
        buildNumber?: unknown;
      };
      if (typeof parsed.version !== 'string') continue;

      /*
       * Report the same four-part string the title bar shows.
       *
       * `buildNumber` is a separate field because `1.0.0.0` is not valid
       * semver and npm rejects it. Only the root package.json carries one;
       * the server's does not, and appends nothing — so a report reads
       * `1.0.0.0` for the app and `1.0.0` for the server, which is honest
       * about where each number came from.
       *
       * Until 2026-11-14 the root package.json still said `0.0.0`, so every
       * support report ever written claimed to come from version 0.0.0.
       * src/app/version.spec.ts is what stops that recurring.
       */
      return typeof parsed.buildNumber === 'number'
        ? `${parsed.version}.${parsed.buildNumber}`
        : parsed.version;
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
        // `soldCoins` replaced the old `transactions` count when the
        // Transactions table was dropped. It is still a pure COUNT(*) with
        // no column list, so it cannot leak content.
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
    // Deliberately NOT an error response. See the module header.
    return { counts: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The identity the redactor scrubs. Read per request, never cached. */
function currentIdentity() {
  return identityFromEnvironment(process.env, os.hostname(), os.homedir());
}

/**
 * Did the caller ask for the log?
 *
 * DEFAULTS TO TRUE, matching the checkbox's own default, because one named
 * field that means different things on two endpoints of the same feature is a
 * worse trap than either default. The dialog always sends the value
 * explicitly, so the unticked state can never be lost in transit — and the
 * write endpoint reports back what it ACTUALLY wrote, so even a caller that
 * got this wrong cannot leave the user misinformed about what is on their
 * Desktop.
 */
function wantsLog(body: Record<string, unknown>): boolean {
  return body['includeLog'] !== false;
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

// GET /api/support/config

/**
 * Everything the dialog needs before it has built anything.
 *
 * THE CLICKABLE LINK IS WHY THIS EXISTS. The repository URL has to be on the
 * FIRST screen — the user is told there that attaching is a GitHub-side
 * action, and telling them that without handing them the link is telling them
 * to go and find it. Getting the URL out of the preview response instead
 * would mean building the whole report (which reads the log and queries the
 * database) just to render a hyperlink.
 *
 * `repositoryConfigured` is load-bearing: while the URL is still the shipped
 * placeholder the dialog must say the repository is not configured rather
 * than render a link to a 404.
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
        // Not even READ when the box is unticked. The renderer would drop
        // them, but there is no reason to lift a user's unredacted log lines
        // into memory to decide not to use them.
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
    // A failure here must not be silent: the user pressed a button and is
    // waiting. Log it and say so plainly rather than hanging the dialog.
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

    // ONE instant for both files, so the pair is obviously a pair on a
    // Desktop that may already hold three of them.
    const when = new Date();
    const reportName = reportFileName(when);

    // Read the log HERE, not from the request. The 2,000 lines never go near
    // the renderer: they are raw and unredacted until the pass below, and
    // round-tripping them through the browser would create exactly the
    // unredacted artefact this feature exists to avoid.
    const rawLog = includeLog
      ? renderLogFile(readRecentLogLines(LOG_FILE_LIMITS.maxLines), {
          generatedAt: when,
          reportFileName: reportName
        })
      : null;

    // ONE redactor for both. See prepareSupportFiles: separate passes would
    // give the same path different placeholders in the two files.
    const prepared = prepareSupportFiles(markdown, rawLog, identity);

    const written = writeSupportFile(directory, reportName, prepared.reportText);
    const writtenLog =
      prepared.logText === null
        ? null
        : writeSupportFile(directory, logFileName(when), prepared.logText);

    // THE FULL PATH, not the bare file name. The server can be running on a
    // different machine from the person looking for the file, and "Support
    // report written: coin-inventory-problem-report-….md" cannot answer the
    // only question anybody asks of this line, which is where it went.
    logInfo(`Support report written: ${written.path} (${written.bytes} bytes)`);
    if (writtenLog) {
      logInfo(`Support log written: ${writtenLog.path} (${writtenLog.bytes} bytes)`);
    }

    res.json({
      path: written.path,
      // For the issue body, which is public. See redactReportPath.
      redactedPath: redactReportPath(written.path, identity),
      fileName: written.fileName,
      directory: written.directory,
      bytes: written.bytes,
      /**
       * null when no log was asked for. WHAT WAS ACTUALLY WRITTEN, never what
       * was requested: the dialog builds its "a log file was written and here
       * it is" note and the issue body from this, so the user is told the
       * truth about their own Desktop even if the flag were ever mishandled.
       */
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
