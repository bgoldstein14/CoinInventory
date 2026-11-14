/**
 * routes/coins/image-payload.ts — normalising whatever the client sent us for
 * "an image" into one predictable shape.
 *
 * The problem this solves
 * An image now has TWO pieces of information attached to it:
 *
 *   imageData  — a downscaled base64 data URL, which is what gets displayed
 *   sourcePath — the absolute path of the ORIGINAL full-resolution file on the
 *                machine hosting the app, so the UI can link to the real photo
 *                (see routes/images/) and can document where it came from
 *
 * The Angular client now sends the object form: `CoinEditor` enriches each
 * entry with its recorded source path on the way out. But the bare-string form
 * must keep working unchanged, and not only for old clients — a JSON inventory
 * exported before this feature existed contains plain base64 strings, and
 * re-importing one has to keep working. Treat the string form as permanent.
 *
 * Rather than scatter `typeof entry === 'string' ? ... : ...` across three
 * route handlers, every write path funnels its input through the two functions
 * below and then only ever deals with `NormalizedImage`. Adding a third field
 * to an image later means editing this file and nothing else.
 *
 * Applies to:
 *   POST /api/coins/:id/images   -> body.images / body.image / body.imageData
 *   POST /api/coins              -> body.imagePaths
 *   PUT  /api/coins/:id          -> body.imagePaths
 *
 * SINCE THE TWO STORAGE MODES there is a third thing an entry can be: a
 * REFERENCE, meaning "the picture stays on disk, record only where it is".
 * It arrives as this server's own `/api/images/file?path=…` URL (that string
 * is what the client's `<img src>` is bound to) or as an entry with a
 * sourcePath and no imageData, and it normalises to `imageData: null`. See
 * routes/images/reference-url.ts.
 */

import { isImageReferenceUrl, sourcePathFromReferenceUrl } from '../images/reference-url';

/** One image, after normalisation — the only shape the insert code sees. */
export interface NormalizedImage {
  /**
   * The base64 data URL that gets stored in CoinImages.ImageData, or NULL for
   * a REFERENCED photograph.
   *
   * *** NULL IS NOT "MISSING". IT IS THE REFERENCED STORAGE MODE. ***
   * Settings lets the user choose whether an imported photograph puts the
   * picture in the database ('stored') or only its location ('referenced').
   * A referenced row writes SourcePath and leaves ImageData NULL — the
   * database deliberately does not carry the picture. An entry with neither
   * a picture nor a path is still nothing at all and is still dropped; see
   * normalizeImageEntry.
   */
  imageData: string | null;
  /**
   * CoinImages.SourcePath, or null when the caller did not tell us where the
   * original lives. Null is a completely normal value: every image imported
   * before this feature existed has no known path.
   */
  sourcePath: string | null;
}

/**
 * The maximum length of CoinImages.SourcePath (see DB_BINDINGS.imageSourcePath
 * and setup-database.sql). Not enforced here on purpose — see the note in
 * bindings.ts: an over-long value is reported to the caller as a 400 rather
 * than silently truncated, because a half-written path is worse than none.
 * Exported so a caller that wants to pre-validate has the number.
 */
export const SOURCE_PATH_MAX_LENGTH = 400;

/**
 * Turns one entry from a client-supplied image array into a NormalizedImage,
 * or returns null if there is nothing worth inserting.
 *
 * Accepted forms:
 *
 *   "data:image/jpeg;base64,..."                              <- COMPATIBILITY PATH
 *   { imageData: "data:image/jpeg;base64,...",
 *     sourcePath: "C:\\Coin Pictures\\1921-morgan-obverse.jpg" }
 *
 * *** THE BARE-STRING FORM IS THE COMPATIBILITY PATH. ***
 * It is what the current Angular client sends and it must not stop working.
 * A bare string simply means "I have no idea where the original file is", so it
 * normalises to sourcePath: null — exactly the state of every pre-existing row.
 *
 * NOTE that `sourcePath: null` coming out of here does NOT mean "write SQL
 * NULL" on the update path. It means "unknown", and PUT /api/coins/:id treats
 * unknown as "keep whatever the database already recorded for this image" —
 * see replaceImages() in write-helpers.ts, and the data-loss bug it prevents.
 * An explicit `sourcePath: null` in the request body is indistinguishable from
 * an absent one here, on purpose: the shipped client sends an explicit null to
 * mean "unknown", so reading it as "clear it" would re-open that bug.
 *
 * Anything else (null, a number, an object with no usable imageData) returns
 * null and is skipped by the caller rather than throwing.
 */
export function normalizeImageEntry(entry: unknown): NormalizedImage | null {
  // ----- The compatibility path: a bare base64 string --------------------
  if (typeof entry === 'string') {
    if (entry.length === 0) return null;

    // A reference URL is not image data even though it arrives as a string:
    // it is the referenced storage mode, which stores the path and no
    // picture. See the REFERENCED PHOTOGRAPHS block below.
    const referenced = sourcePathFromReferenceUrl(entry);
    if (referenced) return { imageData: null, sourcePath: referenced };
    if (isImageReferenceUrl(entry)) return null;

    return { imageData: entry, sourcePath: null };
  }

  // ----- The object form: { imageData, sourcePath } ----------------------
  if (entry !== null && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;

    // `imagePaths` historically held base64 strings, so a client migrating
    // gradually might reasonably send `image` or `data` instead of `imageData`.
    // Accepting the aliases costs nothing and avoids a confusing silent skip.
    const rawData = record['imageData'] ?? record['image'] ?? record['data'];
    const suppliedPath = normalizeSourcePath(record['sourcePath']);

     /*
     * ----- REFERENCED PHOTOGRAPHS -------------------------------------
     *
     * Two ways the client says "store the path, not the picture":
     *
     *   { imageData: "http://host/api/images/file?path=C%3A%5C…",
     *     sourcePath: "C:\\pics\\a.jpg" }   <- what the app sends, because
     *                                          that string is also what its
     *                                          <img src> is bound to
     *   { imageData: null, sourcePath: "C:\\pics\\a.jpg" }
     *
     * Either way ImageData is left NULL and only SourcePath is written. The
     * path inside the URL is used when the entry carries none of its own, so
     * a round trip through a client that lost its path registry still writes
     * the right row instead of a row pointing nowhere.
     *
     * A reference with no path anywhere is NOT stored as an empty row: it
     * would be a photograph with neither a picture nor a location, which is
     * a photograph thrown away. It returns null and the caller skips it,
     * exactly as it does for every other unusable entry.
      */
    if (isImageReferenceUrl(rawData)) {
      const sourcePath = suppliedPath ?? sourcePathFromReferenceUrl(rawData);
      return sourcePath ? { imageData: null, sourcePath } : null;
    }

    if (typeof rawData !== 'string' || rawData.length === 0) {
      // No picture. A path on its own is a legitimate referenced photograph;
      // nothing at all is still nothing.
      return suppliedPath ? { imageData: null, sourcePath: suppliedPath } : null;
    }

    return { imageData: rawData, sourcePath: suppliedPath };
  }

  // ----- Anything else is not an image ----------------------------------
  return null;
}

/**
 * Normalises the sourcePath field on its own.
 *
 * Whitespace is trimmed because a path pasted from Explorer often arrives with
 * a trailing space, and an empty string is converted to null so the database
 * holds "unknown" in exactly one way instead of two ('' and NULL). Anything
 * that is not a string — a number, an object, undefined — is also just unknown.
 */
export function normalizeSourcePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalises a whole array of client-supplied image entries, dropping the ones
 * that carry no usable image data.
 *
 * A non-array argument (including undefined, which is what `body.imagePaths`
 * is when the caller omitted it) yields an empty array, so callers can write
 * `normalizeImageEntries(body.imagePaths)` without a guard of their own.
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
