/*
 * reference-url.ts — the string form of a referenced photo (a file on disk,
 * not a picture kept in the database).
 *
 * `CoinRecord.imagePaths` is `string[]` bound directly to `<img [src]>`, so a
 * referenced photo is represented by the URL that serves the original,
 * `GET /api/images/file?path=…`. It is a transport form only: the database
 * stores just `SourcePath` (ImageData is NULL); the server converts between
 * the two in server/routes/coins/image-payload.ts and images.ts.
 *
 * `referenceUrlForPath` builds the relative form (correct when page and API
 * share an origin). Under `ng serve` they don't (:4200 vs :3000), so callers
 * that can should use ApiService.imageFileUrl. Both forms are recognised,
 * since matching is on the route, not the host.
 */

/** The route that serves an original file, as it appears inside a reference. */
export const IMAGE_REFERENCE_ROUTE = '/api/images/file?path=';

/**
 * The reference string for one original file, relative to the API origin.
 * The path is URL-encoded; an `&` or `#` would otherwise truncate the query.
 */
export function referenceUrlForPath(sourcePath: string): string {
  return `${IMAGE_REFERENCE_ROUTE}${encodeURIComponent(sourcePath)}`;
}

/**
 * Is this entry a reference rather than a picture? Matches with or without an
 * origin. A stored `data:` URL never contains the route.
 */
export function isImageReferenceUrl(value: unknown): value is string {
  return typeof value === 'string' && value.includes(IMAGE_REFERENCE_ROUTE);
}

/**
 * The absolute file path a reference points at, or null if this is not a
 * reference or carries no path. A malformed `%` escape also yields null
 * rather than throwing mid-save.
 */
export function sourcePathFromReferenceUrl(value: unknown): string | null {
  if (!isImageReferenceUrl(value)) return null;

  const start = value.indexOf(IMAGE_REFERENCE_ROUTE) + IMAGE_REFERENCE_ROUTE.length;
  const raw = value.slice(start);
  if (!raw) return null;

  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}
