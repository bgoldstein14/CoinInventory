/**
 * routes/backup/index.ts — §16's HTTP surface. Mounted at /api.
 *
 * SIX ENDPOINTS, AND THE SPLIT BETWEEN THEM IS THE SAFETY MODEL
 *
 *   GET  /api/backup/suggestion       where to put it and what to call it.
 *                                     Reads nothing, writes nothing.
 *   GET  /api/backup/files            the *.db files in a named folder, so
 *                                     the user picks instead of typing.
 *   POST /api/backup/jobs             start a copy. Returns an ID at once.
 *   GET  /api/backup/jobs/:id         how far it has got.
 *   POST /api/backup/jobs/:id/cancel  stop it.
 *
 *   POST /api/restore/inspect         *** LOOK, CHANGE NOTHING. *** What is
 *                                     in this file, and may it be restored?
 *   POST /api/restore                 do it.
 *
 * *** WHY INSPECT AND RESTORE ARE TWO CALLS. *** It is the same split
 * routes/support uses between `preview` and `report`, and for a stronger
 * reason: this one is not reversible by closing a window. The user must be
 * able to see the coin count and the date the backup was taken — and the
 * warning about photographs that will not follow it to this machine —
 * BEFORE anything of theirs is moved. A single endpoint that validated and
 * swapped in one go would mean the first thing they learn about the file is
 * what it did to their collection.
 *
 * *** THE ROUTE DOES NOT GET TO DECIDE WHETHER A FILE IS ACCEPTABLE. *** It
 * calls inspect, and the restore validates again for itself. A client that
 * skipped the inspect call, or edited the path after it, changes nothing:
 * backup/restore.ts refuses on its own authority. Nothing in this file is
 * load-bearing for safety, which is how it should be — HTTP plumbing is
 * the wrong place for the rule that protects a collection.
 *
 * STATUS CODES. A refusal is a 400 with a sentence the dialog shows
 * verbatim. A fault is a 500. Those are genuinely different: the first
 * means "that file is wrong", the second means "this application is", and
 * a user who cannot tell them apart will either panic or keep clicking.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildDbConfig, IN_MEMORY_DATABASE } from '../../db';
import { logError, logInfo } from '../../logger';
import { resolveDesktopDirectory } from '../../support/report-file';
import { inspectBackupFile } from '../../backup/inspect';
import {
  cancelBackupJob,
  getBackupJob,
  startBackupJob,
} from '../../backup/jobs';
import { BackupDirectoryError, listBackupFiles } from '../../backup/list-db-files';
import { backupFileName } from '../../backup/names';
import { BackupRequestError } from '../../backup/run-backup';
import { performRestore, RestoreRefused } from '../../backup/restore';

const router = Router();

/** Pulls a required string out of a JSON body, or ''. */
function bodyString(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * GET /api/backup/suggestion
 *
 * The prefill. The same problem routes/app-info.ts solves for the image
 * import and the same answer: the browser will not tell JavaScript a real
 * path, so the server offers one it knows is real on THIS machine and the
 * user edits it.
 *
 * The Desktop, not the install folder — a backup is a file the user is
 * meant to find, copy to a USB stick and carry to another PC, and anything
 * under `%LOCALAPPDATA%` is somewhere they will never look. It is also the
 * folder routes/support already writes to, so the app is consistent about
 * where it puts things for people.
 *
 * `databaseSizeBytes` is here so the dialog can warn before, not after:
 * "this will write about 600 MB" is the difference between a user choosing
 * their Desktop and a user choosing a nearly full USB stick.
 */
router.get('/backup/suggestion', (_req: Request, res: Response) => {
  const config = buildDbConfig();
  const inMemory = config.file === IN_MEMORY_DATABASE;

  let databaseSizeBytes: number | null = null;
  if (!inMemory) {
    try {
      databaseSizeBytes = fs.statSync(config.file).size;
    } catch {
      // No file yet — a first run before anything has been saved. Null,
      // which the dialog shows as "unknown", rather than a misleading 0.
      databaseSizeBytes = null;
    }
  }

  res.json({
    directory: resolveDesktopDirectory(process.env, os.homedir()),
    fileName: backupFileName(new Date()),
    databasePath: inMemory ? null : config.file,
    databaseSizeBytes,
  });
});

/**
 * GET /api/backup/files?directory=<folder>
 *
 * *** THIS LISTS A DIRECTORY THE CLIENT NAMES. *** Read the header of
 * backup/list-db-files.ts before touching it: only `*.db` is ever named,
 * only the one folder is read, and nothing recurses or walks upward. The
 * rules live in that module so they are testable without HTTP; this
 * handler's whole job is the status codes and the log line.
 *
 * WHY IT EXISTS. The restore box used to be "type the exact path of the
 * file that is about to replace your entire collection". A browser cannot
 * do better — it will not tell a page where a file is — but the server
 * can simply look, so the user names a folder and picks from what is
 * really in it.
 *
 * GET, with the folder in the query string, because it reads nothing of
 * the user's and changes nothing at all: the same shape as
 * /backup/suggestion above and routes/images/file.ts.
 *
 * STATUS CODES. 400 for a blank box, 404 for a folder that is not there
 * or is not a folder, 500 for a genuine fault. A folder that exists and
 * holds no backups is a 200 with an empty list — a completely normal
 * answer that the dialog says plainly, and one that must not be
 * confusable with "there is no such folder".
 */
router.get('/backup/files', (req: Request, res: Response) => {
  // A query parameter can be repeated (?directory=a&directory=b) and
  // `?directory[0]=x` arrives as an OBJECT. Collapse to a single string
  // and treat anything else as absent, so `.trim()` downstream cannot
  // throw a TypeError in place of the 400 the caller deserves. Same
  // reasoning as routes/images/file.ts.
  const raw = req.query['directory'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const directory = typeof first === 'string' ? first : '';

  try {
    const listing = listBackupFiles(directory);
    // Logged with the resolved path and a count, for the same reason
    // images/file.ts logs every read: this reaches outside the app's own
    // folders, so there is a record of where it looked.
    logInfo(`Listed ${listing.files.length} backup file(s) in ${listing.directory}`);
    res.json(listing);
  } catch (err) {
    if (err instanceof BackupDirectoryError) {
      res.status(err.kind === 'empty' ? 400 : 404).json({ error: err.message });
      return;
    }
    logError(
      'GET /api/backup/files failed',
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({ error: 'That folder could not be read.' });
  }
});

/**
 * POST /api/backup/jobs  { directory, fileName? }
 *
 * 202, not 200: the backup has been ACCEPTED, not completed. The body is
 * the job's opening status, so the dialog can render a progress panel
 * before the first poll comes back.
 */
router.post('/backup/jobs', (req: Request, res: Response) => {
  const directory = bodyString(req.body, 'directory');
  const fileName = bodyString(req.body, 'fileName');

  try {
    const status = startBackupJob({
      directory,
      ...(fileName.length > 0 ? { fileName } : {}),
    });
    logInfo(`Backup job ${status.id} started for ${directory}`);
    res.status(202).json(status);
  } catch (err) {
    if (err instanceof BackupRequestError) {
      res.status(400).json({ error: err.message });
      return;
    }
    logError('POST /api/backup/jobs failed', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'The backup could not be started.' });
  }
});

/** GET /api/backup/jobs/:id — 404 for an id we have forgotten or never had. */
router.get('/backup/jobs/:id', (req: Request, res: Response) => {
  const status = getBackupJob(String(req.params['id']));
  if (!status) {
    res.status(404).json({ error: 'That backup is no longer being tracked.' });
    return;
  }
  res.json(status);
});

/**
 * POST /api/backup/jobs/:id/cancel
 *
 * `accepted`, not `cancelled`. The flag is read by the copy once per batch,
 * so the job stops a moment from now and the dialog keeps polling until the
 * state says so. Reporting it as already cancelled would be a lie with
 * pages still being written behind it.
 */
router.post('/backup/jobs/:id/cancel', (req: Request, res: Response) => {
  const id = String(req.params['id']);
  if (!cancelBackupJob(id)) {
    res.status(404).json({ error: 'That backup is no longer being tracked.' });
    return;
  }
  res.json({ accepted: true, id });
});

/**
 * POST /api/restore/inspect  { path }
 *
 * *** ALWAYS 200, EVEN FOR A FILE THAT WILL BE REFUSED. *** The inspection
 * SUCCEEDED; its answer is "no". A 400 here would make "you picked your
 * holiday photo" indistinguishable from "the endpoint is broken", and the
 * body — the verdict, the sentence, the counts — is exactly what the dialog
 * needs in order to explain the refusal. The only 400 is an empty path,
 * which is not a file to have an opinion about.
 */
router.post('/restore/inspect', (req: Request, res: Response) => {
  const candidate = bodyString(req.body, 'path');
  if (candidate.length === 0) {
    res.status(400).json({ error: 'Enter the full path of the backup file.' });
    return;
  }

  try {
    const inspection = inspectBackupFile(candidate);
    logInfo(`Inspected ${candidate}: ${inspection.decision.verdict}`);
    res.json(inspection);
  } catch (err) {
    // inspectBackupFile() turns every user-caused failure into a verdict,
    // so reaching here means something genuinely unexpected (a permissions
    // error on stat, a dead network share).
    logError(
      'POST /api/restore/inspect failed',
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({ error: 'That file could not be examined.' });
  }
});

/**
 * POST /api/restore  { path }
 *
 * The irreversible one. Everything that makes it survivable is in
 * backup/restore.ts; this just translates its two failure kinds into the
 * two status codes.
 */
router.post('/restore', async (req: Request, res: Response) => {
  const candidate = bodyString(req.body, 'path');

  try {
    const result = await performRestore(candidate);
    res.json(result);
  } catch (err) {
    if (err instanceof RestoreRefused) {
      res.status(400).json({ error: err.message, inspection: err.inspection });
      return;
    }
    // The rollback has already run: backup/restore.ts puts the previous
    // collection back before it rethrows, so the user is where they
    // started and the message says so.
    logError('POST /api/restore failed', err instanceof Error ? err.message : String(err));
    res.status(500).json({
      error:
        err instanceof Error
          ? err.message
          : 'The collection could not be restored, so nothing was changed.',
    });
  }
});

export default router;

/**
 * Exported for the specs, which need to know where the suggestion points
 * without re-implementing the Desktop rules.
 */
export function suggestedBackupPath(now: Date = new Date()): string {
  return path.join(
    resolveDesktopDirectory(process.env, os.homedir()),
    backupFileName(now)
  );
}
