/**
 * The URL that marks a photo as referenced (a file on disk) rather than stored.
 *
 *   stored      ImageData holds a downscaled base64 copy; SourcePath records
 *               where the original came from.
 *   referenced  ImageData is NULL; the file at SourcePath is the only copy.
 *
 * The client displays images from an array of strings bound to <img src>, so a
 * referenced row is sent out as this server's file-streaming URL (GET
 * /api/coins/:id/images) and recognised again on save (image-payload.ts). The
 * URL is never stored in ImageData.
 *
 * Built absolute from the request's origin, since under `ng serve` the page
 * (:4200) and API (:3000) differ. Matching accepts both absolute and relative
 * forms.
 */

/** The route that serves an original file, as it appears inside a reference. */
export const IMAGE_REFERENCE_ROUTE = '/api/images/file?path=';

/**
 * Builds the reference URL for one original file.
 *
 * @param sourcePath absolute path of the original on the host
 * @param origin     e.g. `http://localhost:3000`; empty gives the relative form
 */
export function referenceUrlFor(sourcePath: string, origin = ''): string {
  return `${origin}${IMAGE_REFERENCE_ROUTE}${encodeURIComponent(sourcePath)}`;
}

/** Is this value one of our reference URLs, with or without an origin? */
export function isImageReferenceUrl(value: unknown): value is string {
  return typeof value === 'string' && value.includes(IMAGE_REFERENCE_ROUTE);
}

/**
 * The file path a reference points at, or null if it isn't one or has no
 * usable path (a malformed % escape is caught rather than failing the save).
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
 * `http://host:port` for the current request, or '' without a Host header.
 * Typed structurally so unit tests don't need an Express request.
 */
export function originFromRequest(req: {
  protocol?: string;
  get?: (name: string) => string | undefined;
}): string {
  const host = typeof req.get === 'function' ? req.get('host') : undefined;
  if (!host) return '';
  return `${req.protocol || 'http'}://${host}`;
}
