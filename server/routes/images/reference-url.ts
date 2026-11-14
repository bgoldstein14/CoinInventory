/**
 * routes/images/reference-url.ts — the string that means "this photograph is
 * a REFERENCE to a file on disk, not a picture in the database".
 *
 * THE TWO STORAGE MODES (Settings > Photographs; design §4.4 and §4.9)
 *
 *   stored      CoinImages.ImageData holds a downscaled base64 copy, and
 *               SourcePath records where the original came from. The picture
 *               survives the original being moved or deleted.
 *   referenced  ImageData is NULL. SourcePath is all there is, and the file
 *               on disk is the only copy of the photograph.
 *
 * A referenced row still has to be DISPLAYABLE, and the client's whole image
 * pipeline is an array of strings bound to `<img [src]>`. So on the way out
 * (GET /api/coins/:id/images) a referenced row is rendered as the URL of this
 * server's own file-streaming route, and on the way in
 * (routes/coins/image-payload.ts) that URL is recognised and turned back into
 * "referenced, path only". The URL is a transport form and is NEVER stored:
 * if one ever appears in ImageData, the mode has leaked and the database is
 * carrying something it should not.
 *
 * ABSOLUTE, NOT RELATIVE, when we know the host. Under `ng serve` the page is
 * on :4200 while this API is on :3000, so a relative `/api/images/file?path=`
 * would be fetched from the dev server and 404. The origin is taken from the
 * request that asked, which is correct in both that case and the packaged
 * app, where page and API share an origin.
 *
 * The matching half is origin-INSENSITIVE on purpose: the client builds the
 * absolute form through ApiService.imageFileUrl, older payloads may carry the
 * relative form, and both must be understood as the same thing.
 */

/** The route that serves an original file, as it appears inside a reference. */
export const IMAGE_REFERENCE_ROUTE = '/api/images/file?path=';

/**
 * Build the reference for one original file.
 *
 * @param sourcePath absolute path of the original on the host machine
 * @param origin     e.g. `http://localhost:3000`. Empty (the default) yields
 *                   the relative form, which is all that can be built when
 *                   the request carried no Host header.
 */
export function referenceUrlFor(sourcePath: string, origin = ''): string {
  return `${origin}${IMAGE_REFERENCE_ROUTE}${encodeURIComponent(sourcePath)}`;
}

/** Is this value one of our reference URLs, with or without an origin? */
export function isImageReferenceUrl(value: unknown): value is string {
  return typeof value === 'string' && value.includes(IMAGE_REFERENCE_ROUTE);
}

/**
 * The absolute file path a reference points at, or null when it is not a
 * reference or carries no usable path.
 *
 * `decodeURIComponent` throws on a malformed `%` escape, so it is caught: a
 * mangled reference means "no path known", never a 500 in the middle of a
 * save.
 */
export function sourcePathFromReferenceUrl(value: unknown): string | null {
  if (!isImageReferenceUrl(value)) return null;

  const raw = value.slice(value.indexOf(IMAGE_REFERENCE_ROUTE) + IMAGE_REFERENCE_ROUTE.length);
  if (!raw) return null;

  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * `http://host:port` for the request we are answering, or '' if the client
 * sent no Host header (which http/1.1 forbids, but a hand-rolled test client
 * can still do).
 *
 * Typed structurally rather than as an Express `Request` so this module stays
 * importable by a unit test that has no Express request to hand.
 */
export function originFromRequest(req: {
  protocol?: string;
  get?: (name: string) => string | undefined;
}): string {
  const host = typeof req.get === 'function' ? req.get('host') : undefined;
  if (!host) return '';
  return `${req.protocol || 'http'}://${host}`;
}
