/**
 * Backup and restore endpoints, mounted at /api:
 *
 *   GET  /api/backup/suggestion       suggested folder and file name
 *   GET  /api/backup/files            the *.db files in a named folder
 *   POST /api/backup/jobs             start a backup; returns a job id at once
 *   GET  /api/backup/jobs/:id         job status
 *   POST /api/backup/jobs/:id/cancel  ask a job to stop
 *   POST /api/restore/inspect         what is in this file, and may it be
 *                                     restored? Changes nothing.
 *   POST /api/restore                 restore it
 *
 * Inspect and restore are separate so the user sees coin count, date and any
 * photo warnings before anything moves. backup/restore.ts re-validates on its
 * own, so the safety rules don't depend on this file. Refusals are 400 with a
 * sentence the dialog shows; faults are 500.
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
 * GET /api/backup/suggestion: a prefill path on this machine (the browser
 * can't supply real paths). Suggests the Desktop, where the user can find and
 * copy the file (and where support reports go too). Includes
 * `databaseSizeBytes` so the dialog can warn about space beforehand.
 */
router.get('/backup/suggestion', (_req: Request, res: Response) => {
  const config = buildDbConfig();
  const inMemory = config.file === IN_MEMORY_DATABASE;

  let databaseSizeBytes: number | null = null;
  if (!inMemory) {
    try {
      databaseSizeBytes = fs.statSync(config.file).size;
    } catch {
      // No file yet: null ("unknown") rather than a misleading 0.
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
 * GET /api/backup/files?directory=<folder>: lists backup candidates so the
 * user picks rather than types a path. The rules (only *.db, one folder, no
 * recursion) are in backup/list-db-files.ts; this handles status codes and
 * logging. 400 for a blank folder, 404 if missing or not a folder, 500 for a
 * fault; an empty folder is 200 with an empty list.
 */
router.get('/backup/files', (req: Request, res: Response) => {
  // Repeated or bracketed params arrive as arrays/objects; treat non-strings
  // as absent so this stays a 400.
  const raw = req.query['directory'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const directory = typeof first === 'string' ? first : '';

  try {
    const listing = listBackupFiles(directory);
    // Logged, since this reads outside the app's own folders.
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
 * 202: accepted, not completed. The body is the job's initial status.
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
 * POST /api/backup/jobs/:id/cancel. Returns `accepted`: the job stops at its
 * next batch, so the dialog keeps polling.
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
 * Always 200, even for a file that will be refused: the inspection succeeded
 * and the body explains the verdict. Only an empty path is a 400.
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
    // User-caused failures are verdicts, so this is unexpected (permissions, dead share).
    logError(
      'POST /api/restore/inspect failed',
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({ error: 'That file could not be examined.' });
  }
});

/**
 * POST /api/restore  { path }. The safety logic is in backup/restore.ts; this
 * maps its refusals to 400 and failures to 500.
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
    // backup/restore.ts has already rolled back, so the user is where they started.
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

/** Where the suggestion points. Exported for tests. */
export function suggestedBackupPath(now: Date = new Date()): string {
  return path.join(
    resolveDesktopDirectory(process.env, os.homedir()),
    backupFileName(now)
  );
}
