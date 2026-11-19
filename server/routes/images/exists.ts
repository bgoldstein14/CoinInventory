/**
 * POST /api/images/exists: which original image files are still readable,
 * for a batch of paths in one request.
 *
 *   Request:  { "paths": ["C:\pics\a.jpg", "D:\gone\b.png"] }
 *   Response: { "results": { "C:\pics\a.jpg": true,
 *                            "D:\gone\b.png": false } }
 *
 * The UI uses it when a coin is opened to grey out links to missing files. A
 * batch so a coin's photos resolve in one pass; POST because long Windows paths
 * don't fit well in a query string.
 *
 *   1. Never throws because of a path: any failure is just `false`.
 *   2. Uses async fs, so a slow or disconnected drive doesn't block the event
 *      loop (and the health probe).
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import { logInfo, logWarn } from '../../logger';

const router = Router();

/** Max paths per request; each costs a disk access. */
export const MAX_PATHS_PER_REQUEST = 500;

/** Checks one path; any failure is `false`. Uses R_OK: an unreadable file is as unusable as a missing one. */
async function canReadFile(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    // Every error (ENOENT, EACCES, invalid path, offline share) means "no".
    return false;
  }
}

router.post('/exists', async (req: Request, res: Response) => {
  const rawPaths = (req.body as { paths?: unknown } | undefined)?.paths;

  // 400: wrong body shape.
  if (!Array.isArray(rawPaths)) {
    logWarn('POST /api/images/exists called without a "paths" array');
    res.status(400).json({ error: 'Body must be { "paths": string[] }.' });
    return;
  }

  // 400: too many paths.
  if (rawPaths.length > MAX_PATHS_PER_REQUEST) {
    logWarn(`POST /api/images/exists rejected ${rawPaths.length} paths (limit ${MAX_PATHS_PER_REQUEST})`);
    res.status(400).json({
      error: `Too many paths: ${rawPaths.length}. A maximum of ${MAX_PATHS_PER_REQUEST} paths may be checked per request.`,
    });
    return;
  }

  // Strings only, de-duplicated (one file can back several image rows).
  // Non-strings are dropped; no entry means false to the UI.
  const uniquePaths = [...new Set(rawPaths.filter((p): p is string => typeof p === 'string'))];

  // canReadFile never rejects, so Promise.all can't either.
  const flags = await Promise.all(uniquePaths.map((p) => canReadFile(p)));

  const results: Record<string, boolean> = {};
  uniquePaths.forEach((p, index) => {
    results[p] = flags[index];
  });

  // Log which paths are missing (the path distinguishes a renamed folder from
  // a dropped share), at WARN, capped so 500 missing paths can't flood the log.
  // The count is always exact.
  const missingPaths = uniquePaths.filter((_, index) => !flags[index]);

  if (missingPaths.length > 0) {
    const MAX_LOGGED = 25;
    const shown = missingPaths.slice(0, MAX_LOGGED);
    const overflow = missingPaths.length - shown.length;

    logWarn(
      `${missingPaths.length} original image path(s) could not be read:\n` +
        shown.map((p) => `  - ${p}`).join('\n') +
        (overflow > 0 ? `\n  ...and ${overflow} more` : '')
    );
  }

  logInfo(`Checked ${uniquePaths.length} original image path(s); ${missingPaths.length} missing`);

  res.json({ results });
});

export default router;
