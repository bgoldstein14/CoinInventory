/**
 * GET /api/images/file?path=<absolute path>: streams an original image file
 * from the host's disk so the user can open the real photo in a new tab.
 *
 * Needed because Chrome and Edge silently refuse to navigate from an http page
 * to a file:// URL (typing it in the address bar works, which makes this
 * confusing to diagnose).
 *
 * Security: this reads any file on the host with an image extension; there is
 * no confining root, which is only acceptable for a single-user app on the
 * user's own PC. Mitigations: the extension allow-list (allowed-types.ts)
 * blocks .env, logs and source files, and every access is logged. If the app
 * is ever exposed beyond localhost, lock this down first (a configured root,
 * or serve by ImageId and look the path up in the database).
 *
 * Streamed rather than read into memory: originals can be ~46 MB, and
 * createReadStream keeps memory flat with backpressure.
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { logInfo, logWarn, logError } from '../../logger';
import { imageContentTypeFor, ALLOWED_IMAGE_EXTENSIONS } from './allowed-types';

const router = Router();

router.get('/file', async (req: Request, res: Response) => {
  // Already URL-decoded by Express. Repeated or bracketed params arrive as
  // arrays/objects; treat non-strings as absent so this stays a 400.
  const rawPath = req.query['path'];
  const firstPath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
  const requestedPath = typeof firstPath === 'string' ? firstPath.trim() : '';

  // 400: no path given.
  if (!requestedPath) {
    logWarn('GET /api/images/file called without a path parameter');
    res.status(400).json({ error: 'A "path" query parameter is required.' });
    return;
  }

  // 400: extension not allowed. Checked before touching the disk, since the
  // allow-list is the security boundary.
  const contentType = imageContentTypeFor(requestedPath);
  if (!contentType) {
    logWarn(`GET /api/images/file refused a non-image extension: ${requestedPath}`);
    res.status(400).json({
      error: `Only image files are served (${ALLOWED_IMAGE_EXTENSIONS.join(', ')}).`,
    });
    return;
  }

  try {
    // One call: existence and size for Content-Length.
    const stats = await fs.promises.stat(requestedPath);

    // 404: exists but isn't a file (streaming a directory fails with EISDIR).
    if (!stats.isFile()) {
      logWarn(`GET /api/images/file: not a regular file: ${requestedPath}`);
      res.status(404).json({ error: 'The original image file was not found.' });
      return;
    }

    // Every access is logged (see the security note above).
    logInfo(`Serving original image file (${stats.size} bytes): ${requestedPath}`);

    res.setHeader('Content-Type', contentType);
    // Lets the browser show progress for large files.
    res.setHeader('Content-Length', String(stats.size));
    // Display inline; the filename is the "Save as" suggestion.
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(requestedPath))}"`);

    const stream = fs.createReadStream(requestedPath);

    // After headers are sent a stream error can't become a 500: res.status()
    // would throw inside an I/O callback and crash the process. Log and
    // destroy the response instead.
    stream.on('error', (streamErr: Error) => {
      logError(`Error while streaming image file: ${requestedPath}`, streamErr);
      if (res.headersSent) {
        res.destroy(streamErr);
      } else {
        res.status(500).json({ error: 'Failed to read the original image file.' });
      }
    });

    // Stop reading from disk if the browser closes the tab.
    res.on('close', () => stream.destroy());

    stream.pipe(res);
  } catch (err) {
    // 404 for ENOENT/ENOTDIR: the file is gone; the UI greys out the link.
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      logWarn(`Original image file not found: ${requestedPath}`);
      res.status(404).json({ error: 'The original image file was not found.' });
      return;
    }

    // Anything else (EACCES, EPERM, invalid path) is a 500.
    logError(`GET /api/images/file failed for ${requestedPath}`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to read the original image file.' });
    }
  }
});

export default router;
