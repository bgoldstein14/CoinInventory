/**
 * Shared write-path helpers for coins: inserting a coin's images, replacing
 * them on update (keeping recorded SourcePaths), and safe rollback.
 */

import { logError } from '../../logger';
import { DB_BINDINGS, DbRequest, DbTransaction } from '../../db';
import { normalizeImageEntries } from './image-payload';

/**
 * Rolls a transaction back without letting a rollback failure (e.g. "No
 * transaction is active" after the connection died) replace the original
 * error. Logs the rollback failure; the caller rethrows the original.
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
 * `images` is `body.imagePaths`, which may use the legacy bare-base64 string
 * form or the `{ imageData, sourcePath }` object form (see image-payload.ts).
 * SortOrder is the position in the normalized list, so it stays gap-free.
 */
export async function insertImages(
  transaction: DbTransaction,
  coinId: string,
  images: unknown,
  /**
   * Optional (ImageData -> SourcePath) map from readExistingSourcePaths(); an
   * entry with no sourcePath of its own inherits the one recorded here.
   */
  knownSourcePaths?: ReadonlyMap<string, string>
): Promise<void> {
  const normalized = normalizeImageEntries(images);

  for (let i = 0; i < normalized.length; i++) {
    const image = normalized[i];

    // A supplied path wins; otherwise inherit what the coin already had.
    const sourcePath = resolveSourcePath(image.imageData, image.sourcePath, knownSourcePaths);

    await new DbRequest(transaction)
      .input('coinId', DB_BINDINGS.coinId, coinId)
      .input('imageData', DB_BINDINGS.imageData, image.imageData)
      .input('sortOrder', DB_BINDINGS.sortOrder, i)
      // NULL means "original file location unknown".
      .input('sourcePath', DB_BINDINGS.imageSourcePath, sourcePath)
      .query(
        'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) VALUES (@coinId, @imageData, @sortOrder, @sourcePath)'
      );
  }
}

/*
 * SourcePath preservation when PUT /:id replaces a coin's images.
 *
 * PUT with `imagePaths` deletes all CoinImages rows and re-inserts the array,
 * and clients always send the full array. Bare base64 entries carry no path,
 * so without this, editing one photo would erase every other photo's
 * recorded original location.
 *
 * A supplied non-empty sourcePath wins. An explicit `null` means "unknown",
 * like an absent key, not "clear it": the Angular client switches the whole
 * array to object form once it knows one path and fills the rest with null.
 * So there is currently no way to clear a SourcePath through this endpoint;
 * that would need its own explicit token.
 *
 * Entries are matched to existing rows by ImageData (there is no image id in
 * the payload), via a Map. If the same image appears twice with different
 * paths, the lowest SortOrder wins.
 *
 * Rationale and costs: docs/rationale/server.md.
 */

/** Decides the SourcePath one image row is written with. Exported for tests. */
export function resolveSourcePath(
  imageData: string | null,
  suppliedSourcePath: string | null,
  knownSourcePaths?: ReadonlyMap<string, string>
): string | null {
  // A supplied path is authoritative.
  if (suppliedSourcePath !== null) return suppliedSourcePath;

  // A referenced image (no image data) has nothing to look up by; entries with
  // neither data nor path were already dropped by normalizeImageEntry.
  if (imageData === null) return null;

  // Fall back to what the coin already had for this image.
  return knownSourcePaths?.get(imageData) ?? null;
}

/**
 * Reads the (ImageData -> SourcePath) pairs a coin currently has. Must run on
 * the same transaction as, and before, the DELETE. Blank paths are filtered in
 * SQL and in code so "no path" has one representation.
 */
export async function readExistingSourcePaths(
  transaction: DbTransaction,
  coinId: string
): Promise<Map<string, string>> {
  const result = await new DbRequest(transaction)
    .input('coinId', DB_BINDINGS.coinId, coinId)
    // ORDER BY SortOrder makes "lowest SortOrder wins" true for duplicates.
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

    // First row wins (see above).
    if (known.has(imageData)) continue;
    known.set(imageData, trimmed);
  }

  return known;
}

/**
 * Replaces a coin's whole image set: read paths worth keeping, delete the old
 * rows, insert the new ones (all on one transaction, in that order). Used by
 * PUT /api/coins/:id. The read is skipped when every incoming entry already
 * has a path, avoiding a large blob read.
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

  // normalizeImageEntries is idempotent, so passing `normalized` back is safe.
  await insertImages(transaction, coinId, normalized, knownSourcePaths);
}
