/**
 * Normalizes client image entries into one shape, NormalizedImage, used by:
 *
 *   POST /api/coins/:id/images   body.images / body.image / body.imageData
 *   POST /api/coins              body.imagePaths
 *   PUT  /api/coins/:id          body.imagePaths
 *
 * An image has `imageData` (downscaled base64 for display) and `sourcePath`
 * (the original file on the host). The bare base64 string form must keep
 * working permanently (older clients and exported JSON inventories use it).
 * A referenced photo (picture stays on disk) arrives as this server's
 * `/api/images/file?path=…` URL or with a sourcePath and no imageData, and
 * normalizes to `imageData: null` (see routes/images/reference-url.ts).
 */

import { isImageReferenceUrl, sourcePathFromReferenceUrl } from '../images/reference-url';

/** One image, after normalisation — the only shape the insert code sees. */
export interface NormalizedImage {
  /**
   * Base64 data URL for CoinImages.ImageData, or null for a referenced photo
   * (the user chose in Settings to store only the location). Entries with
   * neither picture nor path are dropped.
   */
  imageData: string | null;
  /** CoinImages.SourcePath, or null when unknown (normal for older images). */
  sourcePath: string | null;
}

/**
 * Max length of CoinImages.SourcePath. Not enforced here: db/bind-values.ts
 * rejects over-long values with a 400 rather than truncating. Exported for
 * callers that want to pre-validate.
 */
export const SOURCE_PATH_MAX_LENGTH = 400;

/**
 * Turns one client image entry into a NormalizedImage, or null if there is
 * nothing to insert (the caller skips it).
 *
 *   "data:image/jpeg;base64,..."                     bare string (sourcePath null)
 *   { imageData: "data:image/jpeg;base64,...",
 *     sourcePath: "C:\Coin Pictures\1921-morgan-obverse.jpg" }
 *
 * `sourcePath: null` means "unknown", whether absent or explicit; on PUT that
 * keeps the recorded path (see replaceImages() in write-helpers.ts).
 */
export function normalizeImageEntry(entry: unknown): NormalizedImage | null {
  // Bare base64 string.
  if (typeof entry === 'string') {
    if (entry.length === 0) return null;

    // A reference URL is the referenced mode: path only, no picture.
    const referenced = sourcePathFromReferenceUrl(entry);
    if (referenced) return { imageData: null, sourcePath: referenced };
    if (isImageReferenceUrl(entry)) return null;

    return { imageData: entry, sourcePath: null };
  }

  // Object form: { imageData, sourcePath }.
  if (entry !== null && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;

    // Accept `image` and `data` as aliases for `imageData`.
    const rawData = record['imageData'] ?? record['image'] ?? record['data'];
    const suppliedPath = normalizeSourcePath(record['sourcePath']);

    /*
     * Referenced photos, sent either as
     *
     *   { imageData: "http://host/api/images/file?path=C%3A%5C…",
     *     sourcePath: "C:\pics\a.jpg" }   (what the app's <img src> uses)
     *   { imageData: null, sourcePath: "C:\pics\a.jpg" }
     *
     * ImageData is stored NULL with only SourcePath. The path inside the URL
     * is used if the entry has none. With no path anywhere, the entry is
     * dropped rather than stored empty.
     */
    if (isImageReferenceUrl(rawData)) {
      const sourcePath = suppliedPath ?? sourcePathFromReferenceUrl(rawData);
      return sourcePath ? { imageData: null, sourcePath } : null;
    }

    if (typeof rawData !== 'string' || rawData.length === 0) {
      // A path alone is a valid referenced photo.
      return suppliedPath ? { imageData: null, sourcePath: suppliedPath } : null;
    }

    return { imageData: rawData, sourcePath: suppliedPath };
  }

  // Anything else is not an image.
  return null;
}

/**
 * Normalizes a sourcePath: trimmed, and '' or non-strings become null so
 * "unknown" has one representation.
 */
export function normalizeSourcePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes an array of image entries, dropping unusable ones. A non-array
 * (e.g. an omitted `body.imagePaths`) yields [].
 */
export function normalizeImageEntries(entries: unknown): NormalizedImage[] {
  if (!Array.isArray(entries)) return [];

  const normalized: NormalizedImage[] = [];
  for (const entry of entries) {
    const image = normalizeImageEntry(entry);
    if (image) normalized.push(image);
  }
  return normalized;
}
