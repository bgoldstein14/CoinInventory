 /*
 * Stage 2 of the batch import: the only code that reads file bytes or writes
 * to the inventory. Runs only after the user confirms.
 *
 * Files are processed one at a time with a yield after each, so the progress
 * bar repaints. Not parallel: decoding a large JPEG onto a canvas needs its
 * full uncompressed size in memory (an 8000x6000 photo is ~190 MB RGBA), and
 * the network share is the bottleneck anyway. Each file has its own try/catch,
 * so one bad file is recorded and the run continues.
 *
 * Writes are grouped per coin: one `attach` call per coin.
 *
 * Coins that already have photos are handled before any file is read:
 *   - `existingPhotoMode`: 'leave' (default), 'replace' or 'add'
 *     (see existing-photo-mode.ts).
 *   - Under 'add', a file whose original path is already recorded on the coin
 *     is skipped (see already-attached.ts).
  */

import {
  BatchImageRow,
  BatchImportFailure,
  BatchImportProgress,
  BatchImportSummary,
  CoinRecord
} from '../../types/coin.model';
import { AttachedImage } from '../../types/coin-image.model';
import { coinImagesInMemory, coinPhotoCount } from '../coin-photos';
import { sourcePathForFile } from './source-path';
import {
  buildAttachedPathIndex,
  isAlreadyAttached,
  type AttachedPathIndex,
  type ExistingSourcePaths
} from './already-attached';
import {
  DEFAULT_EXISTING_PHOTO_MODE,
  rowsWrittenUnderMode,
  type ExistingPhotoMode
} from './existing-photo-mode';

/** Hands control back to the browser so it can paint. */
export function yieldToBrowser(): Promise<void> {
  // setTimeout, not a microtask: a resolved promise would not allow a repaint.
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/** What one file turns into once it has been read and shrunk. */
export interface EncodedImage {
  dataUrl: string;
  originalBytes: number;
  storedBytes: number;
}

/** Everything the runner needs from its caller. */
export interface AttachOptions {
  /** The File handles, keyed by filename, so we can read the ticked ones. */
  files: ReadonlyMap<string, File>;
  /** Current inventory, used to append to a coin's existing imagePaths. */
  inventory: readonly CoinRecord[];
  /**
   * The base folder the user confirmed, used to rebuild each file's absolute
   * path from `webkitRelativePath` (see source-path.ts). Without it images are
   * attached with `sourcePath: null`.
   */
  baseFolder?: string;

  /**
   * What happens to coins that already have photos. Defaults to 'leave' here
   * as well as in the UI, so a caller that omits it can't duplicate everything.
   */
  existingPhotoMode?: ExistingPhotoMode;

  /**
   * Original files already attached to each coin, from
   * POST /api/coins/image-source-paths, keyed by coin id. Fails open: when
   * absent, nothing is treated as already attached (a duplicate is visible
   * and undoable; a dropped photo is not).
   */
  existingSourcePaths?: ExistingSourcePaths;

  /**
   * Fetch one coin's existing photos for 'add' mode when they aren't in memory
   * (normally `InventoryService.loadCoinImages`). See `resolveKeptImages`.
   * Fails closed: with no loader, or a rejection, the coin is skipped and its
   * files reported as failures, because guessing would delete photos.
   */
  loadExistingImages?: (coinId: string) => Promise<string[]>;

  /**
   * The write, called once per coin. Injected so the runner stays pure.
   *
   * @param imagePaths the coin's complete new image array as data URLs: existing
   *                   plus new under 'add', new only under 'replace' (the PUT
   *                   replaces all CoinImages rows, which is how the delete happens).
   * @param newImages  just this run's images, each with its original's absolute
   *                   path (or null), so the request can carry
   *                   `{ imageData, sourcePath }`. See services/image-source-paths.ts.
   */
  attach: (coinId: string, imagePaths: string[], newImages: AttachedImage[]) => void;
  /** Called after every file so the UI can show progress. */
  onProgress?: (progress: BatchImportProgress) => void;
  /** Reads + downscales one file. Stubbed in tests (there is no canvas there). */
  encode: (file: File) => Promise<EncodedImage>;
}

/**
 * Read, shrink and save every TICKED row.
 *
 * @returns the end-of-run report: attached, skipped, and every failure with
 *          its reason.
 */
export async function runAttach(
  rows: readonly BatchImageRow[],
  options: AttachOptions
): Promise<BatchImportSummary> {
  /*
   * Decide what will be read before any bytes move, cheapest filter first:
   *   1. Ticked, with a coin, not skipped.
   *   2. The existing-photo mode ('leave' drops coins that already have photos).
   *   3. Already attached (original path already recorded on that coin).
   * `toProcess` is the progress bar's denominator.
   */
  const mode = options.existingPhotoMode ?? DEFAULT_EXISTING_PHOTO_MODE;
  const selected = rowsWrittenUnderMode(rows, options.inventory, mode);

  /* Under 'replace' existing images are about to be deleted, so the
   * already-attached index is empty; skipping would leave no copy at all. */
  const attached: AttachedPathIndex =
    mode === 'replace'
      ? new Map()
      : buildAttachedPathIndex(options.existingSourcePaths ?? {});

  const toProcess = selected.filter(
    row => !isAlreadyAttached(attached, row.selectedCoinId!, candidateSourcePath(row, options))
  );
  const byCoin = groupRowsByCoin(toProcess);

  const progress: BatchImportProgress = {
    total: toProcess.length,
    processed: 0,
    attached: 0,
    failed: 0,
    currentFile: '',
    phase: 'attaching'
  };
  const failures: BatchImportFailure[] = [];
  let originalBytes = 0;
  let storedBytes = 0;
  let coinsTouched = 0;

  // Announce the run before reading the first (possibly huge) file, so the
  // progress bar shows and `busy()` disables Save. The yield lets it paint.
  options.onProgress?.({ ...progress });
  await yieldToBrowser();

  for (const [coinId, coinRows] of byCoin) {
    const coin = options.inventory.find(c => c.id === coinId);
    const newPaths: string[] = [];
    /** Rows that produced an image, so counters can be reverted if the coin is abandoned. */
    const encodedRows: BatchImageRow[] = [];
    /** The new images paired with where their originals live. */
    const newImages: AttachedImage[] = [];

    for (const row of coinRows) {
      progress.currentFile = row.fileName;
      try {
        const file = options.files.get(row.fileName);
        if (!file) throw new Error('File handle was lost - re-select the folder');

        const encoded = await options.encode(file);
        newPaths.push(encoded.dataUrl);
        // Build the original's absolute path while we still hold the File handle.
        newImages.push({
          imageData: encoded.dataUrl,
          sourcePath: candidateSourcePath(row, options)
        });
        originalBytes += encoded.originalBytes;
        storedBytes += encoded.storedBytes;
        progress.attached += 1;
        encodedRows.push(row);
      } catch (error) {
        // One bad file must never abort the batch.
        progress.failed += 1;
        failures.push({ fileName: row.fileName, reason: describeError(error) });
      }
      progress.processed += 1;
      options.onProgress?.({ ...progress });
      await yieldToBrowser();
    }

    if (newPaths.length > 0) {
      /* 'replace' is an empty keep list: the PUT replaces the coin's images, so
       * leaving the old ones out is the delete. */
      const keep = mode === 'replace' ? [] : await resolveKeptImages(coin, coinId, options);

      if (keep === null) {
        /* Unknown existing photos: writing would delete them, so skip the coin
         * and report each file as a failure. */
        for (const row of encodedRows) {
          failures.push({
            fileName: row.fileName,
            reason: 'Could not read this coin\'s existing photos, so nothing was changed. Try again once the server is reachable.'
          });
          progress.failed += 1;
          // Un-count it: it was read, but it was not attached to anything.
          progress.attached -= 1;
        }
        options.onProgress?.({ ...progress });
        continue;
      }

      /* The Set removes byte-identical duplicates within one run only. Re-import
       * duplicates are prevented by the source-path skip above. */
      const merged = [...new Set([...keep, ...newPaths])];
      options.attach(coinId, merged, newImages);
      coinsTouched += 1;
    }
  }

  progress.phase = 'done';
  progress.currentFile = '';
  options.onProgress?.({ ...progress });

  return {
    attached: progress.attached,
    // Unticked, skipped, already attached or unresolved rows.
    skipped: rows.length - toProcess.length,
    failures,
    coinsTouched,
    originalBytes,
    storedBytes
  };
}

/**
 * The photos to keep under 'add', or null meaning "don't write this coin".
 *
 * 'add' PUTs the complete array and the server replaces every CoinImages row,
 * so anything missing from this list is deleted. Never use
 * `coin?.imagePaths ?? []`: the list endpoint doesn't inline photos, so an
 * unloaded coin would look empty and lose all its photos.
 *
 * In order of cost:
 *   1. Already in memory (also the most current).
 *   2. `imageCount` is zero: empty is a fact.
 *   3. Fetch via `loadExistingImages`.
 * No loader, or a failed fetch, returns null and the coin is skipped.
 */
async function resolveKeptImages(
  coin: CoinRecord | undefined,
  coinId: string,
  options: AttachOptions
): Promise<string[] | null> {
  // 1. Loaded already, including a genuine empty array.
  const inMemory = coinImagesInMemory(coin);
  if (inMemory) return inMemory;

  // 2. The server says there are no photos. An unknown coin is not the same
  //    as "no photos", hence the `coin &&` guard.
  if (coin && coinPhotoCount(coin) === 0) return [];

  // 3. Ask. The loader rejects rather than returning `[]` on failure.
  if (!options.loadExistingImages) return null;
  try {
    return await options.loadExistingImages(coinId);
  } catch {
    return null;
  }
}

/**
 * The absolute path this row's file would be recorded at, or null without a
 * base folder. Used both for the already-attached check and for recording the
 * new image, so the two always agree.
 */
function candidateSourcePath(row: BatchImageRow, options: AttachOptions): string | null {
  if (!options.baseFolder) return null;
  const file = options.files.get(row.fileName);
  if (!file) return null;
  return sourcePathForFile(options.baseFolder, file);
}

/** filename-keyed rows bucketed by their target coin, preserving order. */
function groupRowsByCoin(rows: readonly BatchImageRow[]): Map<string, BatchImageRow[]> {
  const byCoin = new Map<string, BatchImageRow[]>();
  for (const row of rows) {
    const coinId = row.selectedCoinId!;
    const bucket = byCoin.get(coinId);
    if (bucket) bucket.push(row);
    else byCoin.set(coinId, [row]);
  }
  return byCoin;
}

/** Turn whatever was thrown into a sentence we can show the user. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error while reading the file';
}
