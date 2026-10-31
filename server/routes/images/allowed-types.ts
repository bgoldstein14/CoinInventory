/**
 * routes/images/allowed-types.ts — the image extension allowlist.
 *
 * One table, two jobs:
 *
 *   1. It decides WHICH files GET /api/images/file is willing to open. That
 *      route reads an arbitrary path off the query string, so the allowlist is
 *      the single narrowing rule standing between it and "serve any file on the
 *      machine" (see file.ts for the full note on that tradeoff).
 *   2. It supplies the Content-Type header, which is what makes the browser
 *      DISPLAY the photo in a new tab rather than download it.
 *
 * Kept in its own tiny module so the list is easy to find and extend, and so
 * both the route and its tests read from the same source of truth.
 */

import path from 'node:path';

/**
 * Lower-cased file extension -> MIME type.
 *
 * `.tif` / `.tiff` are included deliberately even though Chrome and Edge will
 * not render a TIFF inline (they offer to download it instead). The point of
 * the feature is to let the user REACH the original file; refusing to serve a
 * format the user actually has on disk would be worse than handing over a file
 * the browser chooses to download.
 */
export const ALLOWED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

/** The allowed extensions, for error messages and tests. */
export const ALLOWED_IMAGE_EXTENSIONS: readonly string[] = Object.keys(ALLOWED_IMAGE_TYPES);

/**
 * Returns the Content-Type for a path, or null when the extension is not on
 * the allowlist (which the caller must turn into a 400).
 *
 * Extension matching is case-insensitive because Windows filenames routinely
 * arrive as `IMG_0042.JPG`, and Windows itself does not care about the case.
 *
 * @param filePath - Any path or filename; only its extension is inspected.
 */
export function imageContentTypeFor(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  // A file with no extension at all yields '' here, which is not a key in the
  // table, so it correctly comes back as "not allowed".
  return ALLOWED_IMAGE_TYPES[extension] ?? null;
}
