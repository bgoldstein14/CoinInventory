/**
 * GET /api/coins/:id/thumbnail: one coin's main photo (SortOrder 0) as binary
 * image bytes, for the grid's Photo column.
 *
 * One binary response per coin rather than a batched JSON endpoint: many
 * coins' base64 in one JSON string can exceed V8's maximum string length
 * (see routes/coins/list-query.ts). Per-coin responses also work with lazy
 * loading and cache per coin.
 *
 * Stored photos are decoded from base64 before sending (a third smaller).
 * Referenced photos (ImageData NULL, SourcePath set) stream the original file
 * instead (see routes/images/reference-url.ts). There is no resizing; the
 * stored copy is already downscaled (~1600 px).
 *
 * Alternatives considered are in docs/rationale/server.md.
 */

import { Router, Request, Response } from 'express';
import fs from 'node:fs';
import { logInfo, logWarn, logError } from '../../logger';
import { imageContentTypeFor } from '../images/allowed-types';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

/**
 * Served when a stored value has no MIME type (older rows hold bare base64).
 * All stored photos are JPEGs from the same downscaler, and browsers sniff anyway.
 */
const DEFAULT_IMAGE_MIME = 'image/jpeg';

/**
 * MIME types echoed back from a stored data URL. An allow-list because the
 * value goes into a Content-Type header; anything else falls back to JPEG.
 * Narrower than routes/images/allowed-types.ts, which covers user files on disk.
 */
const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

/** The image bytes plus the type to serve them as. */
interface DecodedImage {
  bytes: Buffer;
  contentType: string;
}

/**
 * Turns a stored ImageData value into bytes, accepting the same shapes as
 * routes/coins/image-payload.ts:
 *
 *   "data:image/jpeg;base64,/9j/4AAQ..."   current form
 *   "/9j/4AAQ..."                          legacy bare base64
 *
 * Returns null if nothing decodes; the caller answers 404, not 500, so one
 * bad row doesn't log a stack trace on every grid paint. Exported for tests.
 */
export function decodeStoredImage(stored: unknown): DecodedImage | null {
  if (typeof stored !== 'string' || stored.trim().length === 0) return null;

  let payload = stored;
  let contentType = DEFAULT_IMAGE_MIME;

  // `data:<mime>[;charset=...][;base64],<payload>`: MIME is before the first ; or ,.
  const match = /^data:([^;,]*)[^,]*,/.exec(stored);
  if (match) {
    payload = stored.slice(match[0].length);
    const declared = (match[1] ?? '').trim().toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(declared)) contentType = declared;
  }

  // Buffer.from(..., 'base64') never throws; check the decoded length instead.
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return null;

  return { bytes, contentType };
}

/**
 * Serves a referenced photo's thumbnail by streaming the original file, with
 * the same rules as routes/images/file.ts: extension allow-list, streaming
 * (originals can be ~46 MB), and destroying the response on a late stream
 * error rather than setting a status. Never throws; a missing file is a 404,
 * as for a coin with no photo.
 */
async function streamOriginalThumbnail(
  res: Response,
  sourcePath: string,
  coinId: string
): Promise<void> {
  const contentType = imageContentTypeFor(sourcePath);
  if (!contentType) {
    logWarn(`Referenced thumbnail for coin ${coinId} is not a servable image type`);
    res.status(404).json({ error: 'No image available for this coin.' });
    return;
  }

  try {
    const stats = await fs.promises.stat(sourcePath);
    if (!stats.isFile()) {
      logWarn(`Referenced thumbnail for coin ${coinId} is not a regular file`);
      res.status(404).json({ error: 'No image available for this coin.' });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(stats.size));
    // Revalidate so a replaced file shows immediately.
    res.setHeader('Cache-Control', 'no-cache');

    const stream = fs.createReadStream(sourcePath);

    stream.on('error', (streamErr: Error) => {
      logError(`Error streaming referenced thumbnail for coin ${coinId}`, streamErr);
      if (res.headersSent) res.destroy(streamErr);
      else res.status(500).json({ error: 'Failed to read the original image file.' });
    });

    // The browser scrolled the row away: stop pulling bytes off the disk.
    res.on('close', () => stream.destroy());

    logInfo(`Served referenced thumbnail for coin ${coinId} (${stats.size} bytes)`);
    stream.pipe(res);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // The original was moved or deleted; referenced mode has no stored copy.
      logWarn(`Referenced thumbnail missing on disk for coin ${coinId}`);
      res.status(404).json({ error: 'No image available for this coin.' });
      return;
    }

    logError(`Referenced thumbnail failed for coin ${coinId}`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to read the original image file.' });
    }
  }
}

// GET /api/coins/:id/thumbnail
//
// 200  the image bytes
// 404  no photos, no such coin, or nothing decodable
// 500  the database failed
//
// "No photos" and "no such coin" share the 404 (unlike GET /:id/images): an
// <img> behaves the same either way, and telling them apart costs a query per row.
router.get('/:id/thumbnail', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    const row = await withDb(async (db) => {
      // The main photo only. The id is bound (the spec tries an injection string).
      const result = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query(
          'SELECT ImageData, SourcePath FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder LIMIT 1'
        );

      return result.recordset[0] as Record<string, unknown> | undefined;
    });

    const image = row ? decodeStoredImage(row['ImageData']) : null;

    // Referenced photo: nothing stored to decode, so stream the original.
    // Stored photos never touch the disk.
    if (!image && typeof row?.['SourcePath'] === 'string' && row['SourcePath'].trim()) {
      await streamOriginalThumbnail(res, row['SourcePath'].trim(), id);
      return;
    }

    if (!image) {
      // Warn, not error: coins without photos are normal.
      logWarn(`No thumbnail available for coin ${id}`);
      res.status(404).json({ error: 'No image available for this coin.' });
      return;
    }

    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(image.bytes.length));
    // Cache but revalidate: with Express's ETag, scrolling back is a 304, and
    // a replaced photo still shows immediately.
    res.setHeader('Cache-Control', 'no-cache');

    logInfo(`Served thumbnail for coin ${id} (${image.bytes.length} bytes)`);
    res.send(image.bytes);
  } catch (err) {
    sendDbError(res, 'GET /api/coins/:id/thumbnail', err, 'Failed to retrieve thumbnail');
  }
});

export default router;
