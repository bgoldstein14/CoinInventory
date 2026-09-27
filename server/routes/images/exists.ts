/**
 * routes/images/exists.ts — POST /api/images/exists
 *
 * Answers "are these original image files still on disk?" for a whole batch of
 * paths in one round trip.
 *
 *   Request:  { "paths": ["C:\\pics\\a.jpg", "D:\\gone\\b.png"] }
 *   Response: { "results": { "C:\\pics\\a.jpg": true,
 *                            "D:\\gone\\b.png": false } }
 *
 * ------------------------------------------------------------------
 * Why a POST, and why a batch
 * ------------------------------------------------------------------
 * The UI needs this the moment a coin is opened: for each of that coin's photos
 * it decides whether the "open the original" link is clickable or is shown
 * greyed out in a muted colour because the underlying file is gone. A coin can
 * easily have eight photos, and firing eight HTTP requests to render one panel
 * is wasteful and makes the links pop in one at a time. One request in, one
 * object out, and the whole panel renders in a single pass.
 *
 * POST rather than GET because the payload is a list of long Windows paths.
 * Those contain backslashes, spaces, colons and non-ASCII characters, and
 * stuffing eight of them into a query string risks running into URL length
 * limits and a pile of encoding bugs. A JSON body has neither problem.
 *
 * ------------------------------------------------------------------
 * Two rules this handler must never break
 * ------------------------------------------------------------------
 *   1. It NEVER throws because of a path. A malformed path, a disconnected
 *      network drive, a permissions error — every one of those is simply
 *      `false`, because from the user's point of view they all mean the same
 *      thing: "we cannot open that file, so do not offer a link to it."
 *   2. It uses the ASYNC fs API. This runs on the request path, and
 *      fs.existsSync() blocks the single Node event loop for the duration of
 *      the disk call. Against a slow or disconnected drive that stall can be
 *      seconds long, during which the server answers NOTHING — not other
 *      requests, not the launcher's health probe.
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import { logInfo, logWarn } from '../../logger';

const router = Router();

/**
 * The most paths we will check in one request.
 *
 * A cap exists because each path costs a disk access, and an unbounded list
 * would let a single request occupy the filesystem thread pool for a long time.
 * 500 is far more than any real coin has photos (the whole library is a few
 * hundred images), so hitting this limit means the caller is doing something
 * unintended rather than something legitimate.
 */
export const MAX_PATHS_PER_REQUEST = 500;

/**
 * Checks one path, converting every possible failure into `false`.
 *
 * fs.promises.access with R_OK asks the question we actually care about — "can
 * this process read this file?" — rather than merely "does the name exist".
 * A file we cannot read is no more clickable than one that is missing.
 */
async function canReadFile(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    // Intentionally swallowing everything: ENOENT, EACCES, EPERM, EINVAL from
    // a malformed Windows path, an offline network share... all of it is just
    // "no". See rule 1 in the header.
    return false;
  }
}

router.post('/exists', async (req: Request, res: Response) => {
  const rawPaths = (req.body as { paths?: unknown } | undefined)?.paths;

  // ----- 400: the body is not the shape we documented ---------------------
  if (!Array.isArray(rawPaths)) {
    logWarn('POST /api/images/exists called without a "paths" array');
    res.status(400).json({ error: 'Body must be { "paths": string[] }.' });
    return;
  }

  // ----- 400: too many paths to check in one go --------------------------
  if (rawPaths.length > MAX_PATHS_PER_REQUEST) {
    logWarn(`POST /api/images/exists rejected ${rawPaths.length} paths (limit ${MAX_PATHS_PER_REQUEST})`);
    res.status(400).json({
      error: `Too many paths: ${rawPaths.length}. A maximum of ${MAX_PATHS_PER_REQUEST} paths may be checked per request.`,
    });
    return;
  }

  // Keep only strings, and de-duplicate. The same file can legitimately be the
  // source of more than one image row, and there is no reason to hit the disk
  // twice for it — the response is keyed by path, so one check serves both.
  //
  // Non-string entries are dropped rather than reported: there is no sensible
  // key to return them under. A caller that sends a number simply finds no
  // entry for it, and "no entry" means the same as false to the UI.
  const uniquePaths = [...new Set(rawPaths.filter((p): p is string => typeof p === 'string'))];

  // All the checks run concurrently. Every promise resolves (canReadFile never
  // rejects), so Promise.all here can never reject either — which is what makes
  // rule 1 in the header structurally true rather than merely intended.
  const flags = await Promise.all(uniquePaths.map((p) => canReadFile(p)));

  const results: Record<string, boolean> = {};
  uniquePaths.forEach((p, index) => {
    results[p] = flags[index];
  });

  const missing = flags.filter((exists) => !exists).length;
  logInfo(`Checked ${uniquePaths.length} original image path(s); ${missing} missing`);

  res.json({ results });
});

export default router;
