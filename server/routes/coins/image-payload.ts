/**
 * routes/coins/image-payload.ts — normalising whatever the client sent us for
 * "an image" into one predictable shape.
 *
 * ------------------------------------------------------------------
 * The problem this solves
 * ------------------------------------------------------------------
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
 */

/** One image, after normalisation — the only shape the insert code sees. */
export interface NormalizedImage {
  /** The base64 data URL that gets stored in CoinImages.ImageData. */
  imageData: string;
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
 * Anything else (null, a number, an object with no usable imageData) returns
 * null and is skipped by the caller. Skipping rather than throwing matches the
 * previous behaviour of the insert loops, which did `if (!imageData) continue;`.
 */
export function normalizeImageEntry(entry: unknown): NormalizedImage | null {
  // ----- The compatibility path: a bare base64 string --------------------
  if (typeof entry === 'string') {
    return entry.length > 0 ? { imageData: entry, sourcePath: null } : null;
  }

  // ----- The object form: { imageData, sourcePath } ----------------------
  if (entry !== null && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;

    // `imagePaths` historically held base64 strings, so a client migrating
    // gradually might reasonably send `image` or `data` instead of `imageData`.
    // Accepting the aliases costs nothing and avoids a confusing silent skip.
    const rawData = record['imageData'] ?? record['image'] ?? record['data'];
    if (typeof rawData !== 'string' || rawData.length === 0) return null;

    return { imageData: rawData, sourcePath: normalizeSourcePath(record['sourcePath']) };
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
