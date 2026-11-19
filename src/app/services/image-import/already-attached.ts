 /*
 * already-attached.ts — "has this coin already got this exact file?"
 *
 * Lets a re-import skip files that are already attached to the coin, so
 * photos aren't stored twice. Files are compared by source path
 * (`CoinImages.SourcePath`): filenames like "Obverse.jpg" repeat across
 * folders, and comparing bytes would mean reading the file the skip is meant
 * to avoid. The candidate path is computed from the File handle alone (see
 * source-path.ts).
 *
 * Existing paths are not on `CoinRecord.imagePaths` (which holds data URLs),
 * so they are fetched in bulk from POST /api/coins/image-source-paths.
 *
 * Every ambiguous case (unknown coin, empty index, no candidate path) answers
 * "not attached": a duplicate is visible and undoable, a wrongly skipped photo
 * is silent.
  */

import { normalizeSourcePathForComparison } from './source-path';

/**
 * The body of POST /api/coins/image-source-paths: coin id -> recorded source
 * paths. An empty array means "asked, nothing attached"; a missing key means
 * "never asked".
 */
export type ExistingSourcePaths = Readonly<Record<string, readonly string[]>>;

/**
 * coinId -> paths already on that coin, in comparison form. Kept per coin so
 * the same photo on a different coin doesn't suppress this one.
 */
export type AttachedPathIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** Turn the endpoint's answer into the index, normalizing each path once. */
export function buildAttachedPathIndex(existing: ExistingSourcePaths): AttachedPathIndex {
  const index = new Map<string, Set<string>>();

  for (const [coinId, paths] of Object.entries(existing)) {
    const normalized = new Set<string>();
    for (const path of paths ?? []) {
      const key = normalizeSourcePathForComparison(path);
      // Images imported before the SourcePath column have no path; indexing
      // "" would make every path-less candidate look already attached.
      if (key.length > 0) normalized.add(key);
    }
    // Registered even with no paths, so "asked, nothing attached" is
    // distinguishable from "never asked".
    index.set(coinId, normalized);
  }

  return index;
}

/**
 * The most coins POST /api/coins/image-source-paths will answer about at once.
 * Mirrors MAX_COIN_IDS_PER_REQUEST in server/routes/coins/image-source-paths.ts
 * (SQL Server's 2,100-parameter limit); duplicated because client and server
 * share no module. Exceeding it returns a 400, which would fail open and
 * re-import everything.
 */
export const MAX_COINS_PER_SOURCE_PATH_REQUEST = 500;

/** Split a coin-id list into request-sized batches. */
export function chunkCoinIds(
  ids: readonly string[],
  size: number = MAX_COINS_PER_SOURCE_PATH_REQUEST
): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}

/**
 * Is this file already one of that coin's photos?
 *
 * @param candidatePath the absolute path the import would record for the file
 *                      (from `sourcePathForFile`). Null when there is no base
 *                      folder.
 */
export function isAlreadyAttached(
  index: AttachedPathIndex,
  coinId: string,
  candidatePath: string | null | undefined
): boolean {
  const key = normalizeSourcePathForComparison(candidatePath);
  // No path means the file can't be identified, so attach it.
  if (key.length === 0) return false;

  // No entry for this coin means the lookup didn't cover it; fail open.
  return index.get(coinId)?.has(key) ?? false;
}
