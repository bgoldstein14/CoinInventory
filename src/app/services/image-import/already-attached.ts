 /*
 * already-attached.ts — "has this coin already got this exact file?"
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * An append-only, blind attach takes the coin's existing photos, sticks the
 * new ones on the end, and has no way to notice that 290 of the 300 "new"
 * ones are the same files it stored last time. Re-importing a folder then
 * re-reads, re-decodes and re-saves everything in it, and the coin ends up
 * with each photo twice.
 *
 * WHY THE COMPARISON IS BY SOURCE PATH AND NOT BY ANYTHING ELSE
 *
 * There are three candidates and only one of them works:
 *
 *   FILENAME       — no. "Obverse.jpg" appears in nearly every subfolder of
 *                    this library. Comparing names would skip hundreds of
 *                    genuinely new photos, which is worse than the bug.
 *   IMAGE BYTES    — no. We would have to read and downscale the file to find
 *                    out whether we needed to read it, which is the entire
 *                    cost the skip is meant to avoid (46 MB JPEGs, over SMB),
 *                    and re-encoding is not byte-stable anyway.
 *   SOURCE PATH    — yes. `CoinImages.SourcePath` is the absolute path of the
 *                    ORIGINAL file, it is what uniquely identifies a source
 *                    file, and the import can compute the candidate's path
 *                    from the File handle alone (see source-path.ts) before
 *                    reading a single byte.
 *
 * WHERE THE EXISTING PATHS COME FROM, AND WHY THAT NEEDED A NEW ENDPOINT
 *
 * They are not available client-side. `CoinRecord.imagePaths` — the array the
 * whole front end works from — holds the downscaled `data:` URLs and nothing
 * else, deliberately (see services/image-source-paths.ts). The paths exist per
 * coin at GET /api/coins/:id/images, but a review screen covers ~112 coins and
 * 112 requests is not an option, so they are fetched in one shot from
 * POST /api/coins/image-source-paths. That response is exactly the input to
 * `buildAttachedPathIndex` below.
 *
 * THE DIRECTION THIS ERRS IN, STATED ONCE
 *
 * A missed match attaches a photo twice — annoying, visible, undoable, and
 * exactly what the user had before this existed. A false match silently drops
 * a photo he wanted and he may never notice. So every ambiguous case below
 * resolves to "NOT already attached": an unknown coin, an empty index, a
 * candidate with no path. The feature fails open, always.
 *
 * Pure functions over plain data, with no Angular and no HTTP, for the same
 * reason base-folder-check.ts is: the unit tests run under Node with no DOM.
  */

import { normalizeSourcePathForComparison } from './source-path';

/**
 * The body of POST /api/coins/image-source-paths, as the client sees it:
 * every requested coin id mapped to the source paths already recorded for it.
 * An empty array means "we asked, and nothing is attached"; a MISSING key
 * means "we never asked", and the two are not the same (see below).
 */
export type ExistingSourcePaths = Readonly<Record<string, readonly string[]>>;

/**
 * coinId -> the set of paths already on that coin, in comparison form.
 *
 * A Set per coin rather than one flat set of `coinId + path` strings: the
 * question is always asked about one coin at a time, and keeping the coins
 * separate is what stops the same photo attached to a DIFFERENT coin from
 * suppressing this one.
 */
export type AttachedPathIndex = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Turn the endpoint's answer into the index the attach run queries.
 *
 * Normalisation happens ONCE here rather than per comparison. A 300-file
 * import against 112 coins asks this question 300 times, and lower-casing the
 * stored side on every one of them would be 300 times the work for an answer
 * that cannot change.
 */
export function buildAttachedPathIndex(existing: ExistingSourcePaths): AttachedPathIndex {
  const index = new Map<string, Set<string>>();

  for (const [coinId, paths] of Object.entries(existing)) {
    const normalized = new Set<string>();
    for (const path of paths ?? []) {
      const key = normalizeSourcePathForComparison(path);
      // An empty normal form is "no path recorded" — which every image
      // imported before the SourcePath column existed has. Indexing it would
      // make every path-less candidate look already-attached.
      if (key.length > 0) normalized.add(key);
    }
    // The coin is registered even with no paths, so callers can tell "asked,
    // nothing attached" apart from "never asked".
    index.set(coinId, normalized);
  }

  return index;
}

/**
 * The most coins POST /api/coins/image-source-paths will answer about at once.
 *
 * Mirrors MAX_COIN_IDS_PER_REQUEST in server/routes/coins/image-source-paths.ts,
 * where the limit comes from SQL Server's 2,100-parameter ceiling. Duplicated
 * rather than shared because the browser bundle and the Express server have no
 * common module, and a client that does not know the limit discovers it as a
 * 400 — which, because the lookup fails open, would silently turn into "import
 * everything again", i.e. the original bug, on exactly the largest imports.
 */
export const MAX_COINS_PER_SOURCE_PATH_REQUEST = 500;

/**
 * Split a coin-id list into request-sized batches.
 *
 * The full photo share matches well over 500 coins, and the whole point of
 * this feature is to behave correctly on that share rather than on a tidy
 * sample of it.
 */
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
 * @param candidatePath the absolute path the import WOULD record for the file,
 *                      as built by `sourcePathForFile`. Null whenever there is
 *                      no base folder, which is a legitimate long-standing way
 *                      to import.
 */
export function isAlreadyAttached(
  index: AttachedPathIndex,
  coinId: string,
  candidatePath: string | null | undefined
): boolean {
  const key = normalizeSourcePathForComparison(candidatePath);
  // No path means we cannot identify the file, and "cannot identify" must mean
  // "attach it". Two path-less images are not evidence of being the same file.
  if (key.length === 0) return false;

  // No entry for this coin means the lookup never ran or never covered it.
  // Fail open — see the header.
  return index.get(coinId)?.has(key) ?? false;
}
