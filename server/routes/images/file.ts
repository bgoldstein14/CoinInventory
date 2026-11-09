/**
 * routes/images/file.ts — GET /api/images/file?path=<absolute path>
 *
 * Streams the ORIGINAL full-resolution image file straight off the host
 * machine's disk, so the user can click the filename shown next to a coin photo
 * and see the real photo in a new browser tab.
 *
 * WHY THE BACKEND HAS TO SERVE THIS AT ALL — do not "simplify" this route away
 * by linking straight to `file:///C:/Coin Pictures/a.jpg`. Chrome and Edge
 * REFUSE to navigate from an http(s) page to a file:// URL. It is a deliberate
 * security rule, not a bug or a setting, and the click is dropped SILENTLY:
 * no error, no tab, nothing. Typing the same file:// URL into the address bar
 * by hand works fine, which makes the failure very confusing to diagnose.
 *
 * So the file has to arrive over http from an origin the page may link to. The
 * Express server already runs on that machine and can read the disk, so the
 * page links to `/api/images/file?path=...` and gets an ordinary http response.
 *
 * THE SECURITY TRADEOFF — read this before reusing this code
 * This endpoint is "read any file on the host machine whose name ends in an
 * image extension". There is no root directory it is confined to, and on a
 * public server that would be a serious vulnerability. It is acceptable only
 * because this is a single-user inventory run on the user's own PC, serving
 * photos from arbitrary folders on that same PC — a confined root would defeat
 * the feature.
 *
 * What we still do, because it is cheap:
 *   - restrict to the image extension allowlist in allowed-types.ts, so this
 *     cannot be used to read .env, app.log, or a source file;
 *   - log every single access with the resolved path, so there is a record in
 *     app.log of what was read.
 *
 * If this app is ever exposed beyond localhost, THIS ROUTE IS THE FIRST THING
 * TO LOCK DOWN: confine it to a configured pictures root, or serve by ImageId
 * and look the path up in the database instead of accepting it from the client.
 *
 * WHY IT STREAMS
 * The originals are camera files, up to about 46 MB each. fs.readFile() would
 * pull the whole thing into the Node heap before sending a single byte: slow to
 * first byte, and several concurrent clicks could push the process into a heap
 * out-of-memory kill. fs.createReadStream().pipe(res) hands the data over in
 * 64 KB chunks with a near-constant memory footprint, and Node applies
 * backpressure automatically if the browser reads slower than the disk.
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { logInfo, logWarn, logError } from '../../logger';
import { imageContentTypeFor, ALLOWED_IMAGE_EXTENSIONS } from './allowed-types';

const router = Router();

router.get('/file', async (req: Request, res: Response) => {
  // Express has already URL-decoded the query string, so this is the real path
  // including spaces and backslashes — e.g. `C:\Coin Pictures\1921 morgan.jpg`.
  //
  // A query parameter may be repeated (?path=a&path=b), and `?path[0]=x` hands
  // back an OBJECT. Collapse to a single value and treat a non-string as
  // absent: .trim() on an object throws a TypeError inside the handler instead
  // of returning the 400 the caller deserves.
  const rawPath = req.query['path'];
  const firstPath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
  const requestedPath = typeof firstPath === 'string' ? firstPath.trim() : '';

  // ----- 400: no path given ---------------------------------------------
  if (!requestedPath) {
    logWarn('GET /api/images/file called without a path parameter');
    res.status(400).json({ error: 'A "path" query parameter is required.' });
    return;
  }

  // ----- 400: not a file type we are willing to serve --------------------
  // Checked BEFORE touching the disk: the allowlist is the security boundary
  // (see the header), so nothing outside it should even be stat'ed.
  const contentType = imageContentTypeFor(requestedPath);
  if (!contentType) {
    logWarn(`GET /api/images/file refused a non-image extension: ${requestedPath}`);
    res.status(400).json({
      error: `Only image files are served (${ALLOWED_IMAGE_EXTENSIONS.join(', ')}).`,
    });
    return;
  }

  try {
    // stat() gives us both halves of what we need in one system call: proof the
    // file is really there, and its size for Content-Length.
    const stats = await fs.promises.stat(requestedPath);

    // ----- 404: the name exists but is not a file ------------------------
    // A directory called `pictures.jpg` is unusual but not impossible, and
    // streaming a directory handle would produce an EISDIR error mid-response.
    if (!stats.isFile()) {
      logWarn(`GET /api/images/file: not a regular file: ${requestedPath}`);
      res.status(404).json({ error: 'The original image file was not found.' });
      return;
    }

    // Every access is logged, deliberately — see the security note above.
    logInfo(`Serving original image file (${stats.size} bytes): ${requestedPath}`);

    res.setHeader('Content-Type', contentType);
    // Content-Length lets the browser draw a real progress bar instead of
    // spinning indefinitely, which matters a lot for a 46 MB photo.
    res.setHeader('Content-Length', String(stats.size));
    // `inline` asks the browser to display the image rather than download it;
    // the filename is what a "Save as..." dialog will suggest.
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(requestedPath))}"`);

    const stream = fs.createReadStream(requestedPath);

    // A stream failure AFTER the headers went out cannot become a 500: the
    // status is already on the wire, res.status() would throw "Cannot set
    // headers after they are sent", and since this fires on an internal I/O
    // callback that throw becomes an uncaught exception and kills the process
    // (same class of bug as a missing pool 'error' listener; see db/index.ts).
    // Log it and destroy the response, so the browser sees a truncated
    // download.
    stream.on('error', (streamErr: Error) => {
      logError(`Error while streaming image file: ${requestedPath}`, streamErr);
      if (res.headersSent) {
        res.destroy(streamErr);
      } else {
        res.status(500).json({ error: 'Failed to read the original image file.' });
      }
    });

    // If the browser closes the tab mid-download, Express destroys the
    // response; without this the read stream would keep pulling from disk.
    res.on('close', () => stream.destroy());

    stream.pipe(res);
  } catch (err) {
    // 404: the usual case. ENOENT (no such file) and ENOTDIR (a parent folder
    // in the path is not a directory) both mean "it is not there any more",
    // which the UI shows as a greyed-out, non-clickable filename.
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      logWarn(`Original image file not found: ${requestedPath}`);
      res.status(404).json({ error: 'The original image file was not found.' });
      return;
    }

    // Anything else (EACCES, EPERM, an invalid path on Windows, ...) is a real
    // server-side problem worth a 500 and a full log entry.
    logError(`GET /api/images/file failed for ${requestedPath}`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to read the original image file.' });
    }
  }
});

export default router;
