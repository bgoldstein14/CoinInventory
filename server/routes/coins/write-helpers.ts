/**
 * routes/coins/write-helpers.ts — the shared write-path plumbing for coins.
 *
 * Creating a coin and updating a coin both have to insert the coin's images
 * and tags, and both have to unwind their transaction correctly when something
 * goes wrong. Those three pieces live here so the CRUD handlers stay readable
 * and so the two paths can never drift apart.
 *
 * `safeRollback()` in particular is load-bearing: it is the reason a failed
 * save still reports the error that actually caused the failure.
 */

import sql from 'mssql';
import { logError } from '../../logger';
import { DB_BINDINGS } from '../../db';
import { normalizeImageEntries } from './image-payload';

/**
 * Rolls a transaction back without ever letting the rollback's own failure
 * replace the error that actually caused the problem.
 *
 * `rollback()` throws surprisingly often — if the connection already died, or
 * if SQL Server already aborted the transaction itself, rollback fails with
 * something like "No transaction is active". The old code did
 * `catch (e) { await transaction.rollback(); throw e; }`, so in exactly those
 * cases the real root-cause error was thrown away and replaced by a confusing
 * rollback error. We log the rollback failure and always rethrow the original.
 *
 * @param transaction - The transaction to unwind, or null if `begin()` never ran.
 * @param context     - Route label used in the log line.
 */
export async function safeRollback(transaction: sql.Transaction | null, context: string): Promise<void> {
  // Guard against rolling back a transaction that never began.
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
export async function insertImages(transaction: sql.Transaction, coinId: string, images: unknown): Promise<void> {
  const normalized = normalizeImageEntries(images);

  for (let i = 0; i < normalized.length; i++) {
    const image = normalized[i];
    await new sql.Request(transaction)
      .input('coinId', DB_BINDINGS.coinId, coinId)
      .input('imageData', DB_BINDINGS.imageData, image.imageData)
      .input('sortOrder', DB_BINDINGS.sortOrder, i)
      // A null here writes SQL NULL, which is exactly what "original file
      // location unknown" means. The column is nullable for that reason.
      .input('sourcePath', DB_BINDINGS.imageSourcePath, image.sourcePath)
      .query(
        'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) VALUES (@coinId, @imageData, @sortOrder, @sourcePath)'
      );
  }
}

/**
 * Inserts the tag rows for a coin. Shared by POST / and PUT /:id.
 */
export async function insertTags(transaction: sql.Transaction, coinId: string, tags: string[]): Promise<void> {
  for (const tag of tags) {
    await new sql.Request(transaction)
      .input('coinId', DB_BINDINGS.coinId, coinId)
      .input('tag', DB_BINDINGS.tag, tag)
      .query('INSERT INTO CoinTags (CoinId, Tag) VALUES (@coinId, @tag)');
  }
}
