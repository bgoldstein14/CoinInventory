/**
 * The image extension allow-list. It limits which files GET /api/images/file
 * may open (see file.ts for the security note) and supplies the Content-Type
 * so the browser displays rather than downloads the photo.
 */

import path from 'node:path';

/**
 * Lower-cased extension -> MIME type. TIFF is included even though browsers
 * download rather than display it: reaching the original matters more.
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
 * The Content-Type for a path, or null if its extension isn't allowed (the
 * caller returns 400). Case-insensitive (e.g. `IMG_0042.JPG`).
 *
 * @param filePath - Any path or filename; only its extension is inspected.
 */
export function imageContentTypeFor(filePath: string): string | null {
  const extension = path.extname(filePath).toLowerCase();
  // No extension gives '', which isn't in the table.
  return ALLOWED_IMAGE_TYPES[extension] ?? null;
}
