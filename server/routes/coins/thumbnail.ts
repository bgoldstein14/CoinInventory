/**
 * routes/coins/thumbnail.ts — GET /api/coins/:id/thumbnail
 *
 * ONE coin's main photograph, as binary image bytes, for the Photo column of
 * the main grid.
 *
 * ONE BINARY RESPONSE PER COIN, deliberately NOT a batched JSON endpoint.
 * Putting N coins' base64 in one JSON array rebuilds the exact string that
 * exceeds V8's maximum string length (see routes/coins/list-query.ts), so
 * batching would move that outage rather than fix it. Batching is right for
 * short strings — see image-source-paths.ts — and wrong for blobs. One
 * response per coin also lets the grid's `loading="lazy"` skip rows below the
 * fold, costs nothing for coins the client already knows have no photos
 * (`imageCount` from the list), and caches per coin rather than invalidating
 * everything when one photograph changes.
 *
 * WHAT KEEPS IT SMALL
 * `SELECT TOP 1 ... ORDER BY SortOrder` — one row, and specifically the row
 * the rest of the app calls the main photo (array position 0 IS SortOrder 0;
 * see CoinImagesStore.setMainImage). A coin with twenty photographs costs the
 * same as a coin with one.
 *
 * The bytes are sent DECODED. ImageData is stored as base64 text (4 characters
 * per 3 bytes), so decoding before sending makes the response a third smaller
 * and is what `<img src>` needs anyway.
 *
 * There is no re-sizing step, and that is a limitation rather than a choice:
 * the stored copy is already downscaled (~1600px, ~250 KB) and the server has
 * no image library to shrink it further. If one is ever added, this is the
 * single place a real 160px thumbnail would be generated and cached.
 *
 * Every database call goes through `withDb()` and there is no resetPool()
 * call — see db/index.ts for why that matters.
 *
 * The alternatives weighed against one-response-per-coin are in
 * docs/rationale/server.md.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

/**
 * What we serve when the stored data URL does not say what it is.
 *
 * Rows written before the `data:` URL convention settled hold raw base64 with
 * no MIME type at all. Every photograph this app stores is produced by the
 * same downscaler and is a JPEG, so that is the honest guess — and browsers
 * sniff the magic bytes regardless, so being wrong costs nothing visible.
 */
const DEFAULT_IMAGE_MIME = 'image/jpeg';

/**
 * Only these MIME types are echoed back from the stored data URL.
 *
 * ImageData is written by this app's own importer, so in practice it is
 * always one of these. The allow-list is here because the value ends up in a
 * `Content-Type` header: letting an arbitrary string out of the database and
 * into a response header invites header injection and content-type confusion
 * for no benefit whatsoever. Anything unrecognised falls back to JPEG rather
 * than failing — the picture is still the picture.
 *
 * Deliberately narrower than routes/images/allowed-types.ts, which governs
 * ORIGINAL files picked off disk by the user. These are files WE wrote.
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
 * Turn a stored ImageData value into bytes we can put on the wire.
 *
 * Two accepted shapes, matching what routes/coins/image-payload.ts accepts on
 * the way in:
 *
 *   "data:image/jpeg;base64,/9j/4AAQ..."   the normal, current form
 *   "/9j/4AAQ..."                          legacy rows: bare base64
 *
 * Returns null for anything that does not decode to at least one byte. The
 * caller turns that into a 404, NOT a 500: an unreadable row is a gap in the
 * data, and a 500 would put a stack trace in the log for every paint of a
 * grid containing one bad coin.
 *
 * Exported for direct unit testing.
 */
export function decodeStoredImage(stored: unknown): DecodedImage | null {
  if (typeof stored !== 'string' || stored.trim().length === 0) return null;

  let payload = stored;
  let contentType = DEFAULT_IMAGE_MIME;

  // `data:<mime>[;charset=...][;base64],<payload>` — take the MIME type from
  // between the colon and the first semicolon or comma.
  const match = /^data:([^;,]*)[^,]*,/.exec(stored);
  if (match) {
    payload = stored.slice(match[0].length);
    const declared = (match[1] ?? '').trim().toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(declared)) contentType = declared;
  }

  // Buffer.from(..., 'base64') never throws: it stops at the first character
  // it cannot use and returns what it had. So "did this decode" has to be
  // answered by the length, not by a try/catch.
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return null;

  return { bytes, contentType };
}

// GET /api/coins/:id/thumbnail
//
// 200  the image bytes
// 404  the coin has no photographs, does not exist, or its first row holds
//      nothing decodable
// 500  the database itself failed
//
// "No photos" and "no such coin" deliberately share the 404 here, unlike
// GET /:id/images which separates them. That endpoint answers a question the
// UI acts on ("show the gallery empty state" vs "this coin is gone"); this one
// feeds an `<img>` tag with one failure behaviour either way, so the second
// query the distinction needs would be an extra round trip per grid row.
router.get('/:id/thumbnail', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    const image = await withDb(async (db) => {
      // TOP 1 + ORDER BY SortOrder: one row, and the one the gallery calls
      // the main photo. The id is BOUND, never interpolated — it arrives from
      // the URL and the spec sends a `'; DROP TABLE Coins; --` id to keep
      // that honest.
      const result = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT TOP 1 ImageData FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder');

      const row = result.recordset[0] as Record<string, unknown> | undefined;
      return row ? decodeStoredImage(row['ImageData']) : null;
    });

    if (!image) {
      // Logged at warn, not error, and without the id in a hot loop message:
      // a collection where half the coins have no photograph is a perfectly
      // normal collection, and this must not drown the log.
      logWarn(`No thumbnail available for coin ${id}`);
      res.status(404).json({ error: 'No image available for this coin.' });
      return;
    }

    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(image.bytes.length));
    // "Cache it, but ask me before you reuse it." Combined with the ETag
    // Express computes from the body, scrolling back up the grid costs a 304
    // with no body, while a photograph the user just replaced still appears
    // immediately. A max-age would make the grid show the old picture.
    res.setHeader('Cache-Control', 'no-cache');

    logInfo(`Served thumbnail for coin ${id} (${image.bytes.length} bytes)`);
    res.send(image.bytes);
  } catch (err) {
    sendDbError(res, 'GET /api/coins/:id/thumbnail', err, 'Failed to retrieve thumbnail');
  }
});

export default router;
