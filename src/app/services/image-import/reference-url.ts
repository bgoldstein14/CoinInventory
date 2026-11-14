/*
 * reference-url.ts — the one string shape that means "this photo is a
 * REFERENCE to a file on disk, not a picture kept in the database".
 *
 * WHY A URL AND NOT A NEW FIELD
 *
 * `CoinRecord.imagePaths` is `string[]` and every `<img [src]>` in the app
 * binds straight to it (see types/coin-image.model.ts for why it was never
 * widened to objects). Referenced storage therefore needs a STRING that a
 * browser can render. The backend already serves originals off disk at
 * `GET /api/images/file?path=…`, so that URL is exactly such a string: it
 * displays, it can be put in an `href`, and it carries the path inside it.
 *
 * WHAT IS AND IS NOT STORED
 *
 * This URL is a TRANSPORT form. It is never written into the database:
 * `CoinImages.ImageData` is left NULL for a referenced photo and only
 * `SourcePath` is written (server/routes/coins/image-payload.ts turns the URL
 * back into "referenced" on the way in, and server/routes/coins/images.ts
 * builds it again on the way out). That is the whole point of the referenced
 * mode — the database does not carry the picture.
 *
 * THE ORIGIN IS DELIBERATELY NOT BAKED IN HERE
 *
 * Under `ng serve` the page is on :4200 and the API on :3000, so a relative
 * URL would 404 in development. Callers that can supply an absolute base
 * (ApiService.imageFileUrl) should; `referenceUrlForPath` produces the
 * relative form, which is correct in the packaged app where the page and the
 * API share an origin. Both forms are recognised by `isImageReferenceUrl`,
 * which matches on the ROUTE, not on the host.
 */

/** The route that serves an original file, as it appears inside a reference. */
export const IMAGE_REFERENCE_ROUTE = '/api/images/file?path=';

/**
 * The reference string for one original file, relative to the API origin.
 *
 * The path is URL-encoded for the same reasons as ApiService.imageFileUrl: it
 * is a Windows path full of backslashes and spaces, and an `&` or `#` in a
 * filename would otherwise truncate the query string.
 */
export function referenceUrlForPath(sourcePath: string): string {
  return `${IMAGE_REFERENCE_ROUTE}${encodeURIComponent(sourcePath)}`;
}

/**
 * Is this entry a reference rather than a picture?
 *
 * Matches with or without an origin in front (`http://localhost:3000/api/…`
 * and `/api/…` are both references), because the client builds the absolute
 * form and the packaged app can legitimately produce either.
 *
 * A `data:` URL — the stored mode — never contains this route, so the two
 * forms cannot be confused.
 */
export function isImageReferenceUrl(value: unknown): value is string {
  return typeof value === 'string' && value.includes(IMAGE_REFERENCE_ROUTE);
}

/**
 * The absolute file path a reference points at, or null if this is not a
 * reference (or carries an empty path).
 *
 * Decoding can throw on a malformed `%` sequence — a path the user typed by
 * hand and mangled, for instance — so it is caught: an unreadable reference
 * is "no path known", never an exception in the middle of a save.
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
