/**
 * routes/coins/write-helpers.ts — the shared write-path plumbing for coins.
 *
 * Creating a coin and updating a coin both have to insert the coin's images,
 * and both have to unwind their transaction correctly when something goes
 * wrong. Those two pieces live here so the CRUD handlers stay readable and so
 * the two paths can never drift apart.
 *
 * Updating additionally has to REPLACE the image set without destroying what
 * the database already knew about those images — `replaceImages()` plus
 * `readExistingSourcePaths()` / `resolveSourcePath()`. Read the SourcePath
 * preservation notes below before touching those: they document a silent
 * data-loss bug, not a feature.
 */

import { logError } from '../../logger';
import { DB_BINDINGS, DbRequest, DbTransaction } from '../../db';
import { normalizeImageEntries } from './image-payload';

/**
 * Rolls a transaction back without ever letting the rollback's own failure
 * replace the error that actually caused the problem.
 *
 * `rollback()` throws surprisingly often — if the connection already died, or
 * if SQL Server already aborted the transaction itself, it fails with
 * something like "No transaction is active". A plain
 * `catch (e) { await transaction.rollback(); throw e; }` throws that confusing
 * rollback error away over the real root cause, in exactly the cases where the
 * root cause matters most. Log the rollback failure, always rethrow the
 * original.
 *
 * @param transaction - The transaction to unwind, or null if `begin()` never ran.
 * @param context     - Route label used in the log line.
 */
export async function safeRollback(transaction: DbTransaction | null, context: string): Promise<void> {
  if (!transaction) return;

  try {
    await transaction.rollback();
  } catch (rollbackErr) {
    logError(`${context} — rollback failed (original error is still being reported)`, rollbackErr);
  }
}

/**
 * Inserts the image rows for a coin. Shared by POST / and PUT /:id.
 *
 * `images` is whatever the caller put in `body.imagePaths` — it is deliberately
 * typed `unknown` and handed to normalizeImageEntries(), which accepts BOTH the
 * historical bare-base64-string form and the newer
 * `{ imageData, sourcePath }` object form. See image-payload.ts; the string
 * form is the compatibility path and must keep working.
 *
 * SortOrder is the array index, so the caller's array order is the display
 * order. Entries with no usable image data are dropped by the normalizer, which
 * means SortOrder stays gap-free (the index used is the position in the
 * NORMALIZED list, not in the raw request).
 */
export async function insertImages(
  transaction: DbTransaction,
  coinId: string,
  images: unknown,
  /**
   * Optional (ImageData -> SourcePath) rescue map, produced by
   * readExistingSourcePaths(). An entry that supplies no sourcePath of its own
   * inherits the one recorded here for the same image data. Omitted by the
   * create path, which has nothing to inherit from.
   */
  knownSourcePaths?: ReadonlyMap<string, string>
): Promise<void> {
  const normalized = normalizeImageEntries(images);

  for (let i = 0; i < normalized.length; i++) {
    const image = normalized[i];

    // See resolveSourcePath(): a supplied path always wins; a missing one falls
    // back to whatever the coin already had recorded for this same image.
    const sourcePath = resolveSourcePath(image.imageData, image.sourcePath, knownSourcePaths);

    await new DbRequest(transaction)
      .input('coinId', DB_BINDINGS.coinId, coinId)
      .input('imageData', DB_BINDINGS.imageData, image.imageData)
      .input('sortOrder', DB_BINDINGS.sortOrder, i)
      // A null here writes SQL NULL, which is exactly what "original file
      // location unknown" means. The column is nullable for that reason.
      .input('sourcePath', DB_BINDINGS.imageSourcePath, sourcePath)
      .query(
        'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) VALUES (@coinId, @imageData, @sortOrder, @sourcePath)'
      );
  }
}

/*
 * SourcePath preservation across the PUT /:id image replacement.
 *
 * `PUT /api/coins/:id` carrying an `imagePaths` key REPLACES the coin's whole
 * image set: DELETE every CoinImages row, then re-insert the array it was
 * given. A bare base64 entry carries no path, and every operation that touches
 * a coin's photos sends the FULL array — so without the rescue below, editing
 * one photo silently erases the recorded original-file location of every other
 * photo on that coin, with nothing failing and nothing logged.
 *
 * ABSENT vs EXPLICIT NULL. A supplied, non-empty sourcePath always wins; that
 * is how a moved or re-imported photo records its new location. An explicit
 * `sourcePath: null` is treated as "I do not know", exactly like an absent key
 * — NOT as "clear the stored path". The payload can express the difference
 * syntactically, but on this wire it does not MEAN it: the Angular client
 * (CoinEditor.withSourcePaths -> ImageSourcePathRegistry.enrich) switches the
 * whole array to the object form as soon as it knows a path for ONE image, and
 * fills every other entry with an explicit null. Honouring null as "clear it"
 * would wipe the other seven photos of a coin the instant the user attached an
 * eighth.
 *
 * The consequence: there is currently NO way to clear a recorded SourcePath
 * through this endpoint. A path that no longer resolves is handled by greying
 * the link out (routes/images/exists.ts), not by erasing it. A real "forget
 * where this came from" feature needs its own explicit token on the wire, and
 * the client updated in the same change — re-reading `null` as "clear" would
 * silently re-open this bug.
 *
 * MATCHING ON ImageData. There is no image id in the `imagePaths` array, so
 * the base64 blob is the only identity an incoming entry carries. Rows are
 * loaded into a Map keyed by that string, making reconciliation O(n) rather
 * than O(n^2) string comparisons over multi-hundred-kilobyte blobs.
 *
 * DUPLICATE ImageData ON ONE COIN. The same photo can legitimately be attached
 * twice, and the two rows can hold different SourcePaths (the same picture
 * imported from two folders). They are indistinguishable to an incoming bare
 * string, so there is no correct pairing: the LOWEST SortOrder wins and every
 * incoming copy inherits it. That is stable under re-ordering the gallery.
 *
 * Why the rescue is on the server rather than the client, and what the read
 * costs, are in docs/rationale/server.md.
 */

/**
 * Decides the SourcePath one image row will be written with.
 *
 * Exported for direct unit testing; the route path reaches it through
 * insertImages().
 */
export function resolveSourcePath(
  imageData: string | null,
  suppliedSourcePath: string | null,
  knownSourcePaths?: ReadonlyMap<string, string>
): string | null {
  // The caller told us where the file is. The caller is the authority.
  if (suppliedSourcePath !== null) return suppliedSourcePath;

  /* A REFERENCED image (imageData null) has nothing to look itself up by —
   * the rescue map is keyed on image data and there is none. It cannot reach
   * here with no path either: an entry with neither is dropped by
   * normalizeImageEntry rather than written as an empty row. */
  if (imageData === null) return null;

  // Nothing supplied: fall back to what the coin already had recorded for this
  // same image, if anything. `?? null` keeps "unknown" as a single value.
  return knownSourcePaths?.get(imageData) ?? null;
}

/**
 * Reads the (ImageData -> SourcePath) pairs a coin currently has recorded.
 *
 * MUST be called with a request on the SAME transaction that is about to run
 * the DELETE, and MUST be called before it: afterwards the rows are gone and
 * there is nothing left to read, and outside the transaction a concurrent write
 * could land in between.
 *
 * Rows with no usable path are filtered in SQL (`SourcePath IS NOT NULL`) and
 * again in code (whitespace-only is just as useless as NULL) — the same
 * two-sided filter routes/coins/image-source-paths.ts uses, and for the same
 * reason: "no path recorded" must have exactly one representation by the time
 * it reaches the rest of the code.
 */
export async function readExistingSourcePaths(
  transaction: DbTransaction,
  coinId: string
): Promise<Map<string, string>> {
  const result = await new DbRequest(transaction)
    .input('coinId', DB_BINDINGS.coinId, coinId)
    // ORDER BY SortOrder is load-bearing, not cosmetic: it is what makes
    // "lowest SortOrder wins" true for duplicated image data.
    .query(
      'SELECT ImageData, SourcePath FROM CoinImages ' +
        'WHERE CoinId = @coinId AND SourcePath IS NOT NULL ORDER BY SortOrder'
    );

  const known = new Map<string, string>();

  for (const row of (result.recordset ?? []) as Record<string, unknown>[]) {
    const imageData = row['ImageData'];
    const sourcePath = row['SourcePath'];

    if (typeof imageData !== 'string' || imageData.length === 0) continue;
    if (typeof sourcePath !== 'string') continue;

    const trimmed = sourcePath.trim();
    if (trimmed.length === 0) continue;

    // First row wins — see the duplicate-ImageData rule above.
    if (known.has(imageData)) continue;
    known.set(imageData, trimmed);
  }

  return known;
}

/**
 * Replaces a coin's entire image set: read the paths worth keeping, delete the
 * old rows, insert the new ones. Used by PUT /api/coins/:id.
 *
 * The three steps live in one function so the ordering invariant — read BEFORE
 * delete, all on the same transaction — cannot be broken by editing the route
 * handler.
 *
 * The preservation read is skipped when it cannot change the outcome: no
 * incoming images at all, or every incoming entry already carrying its own
 * path. That keeps a multi-megabyte blob read off the paths that do not need
 * it.
 */
export async function replaceImages(
  transaction: DbTransaction,
  coinId: string,
  images: unknown
): Promise<void> {
  const normalized = normalizeImageEntries(images);
  const needsRescue = normalized.some((image) => image.sourcePath === null);

  const knownSourcePaths = needsRescue
    ? await readExistingSourcePaths(transaction, coinId)
    : undefined;

  await new DbRequest(transaction)
    .input('coinId', DB_BINDINGS.coinId, coinId)
    .query('DELETE FROM CoinImages WHERE CoinId = @coinId');

  // Handing `normalized` back in is safe: normalizeImageEntries is idempotent
  // over NormalizedImage[].
  await insertImages(transaction, coinId, normalized, knownSourcePaths);
}
