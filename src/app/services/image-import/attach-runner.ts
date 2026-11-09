 /*
 * attach-runner.ts
 *
 * STAGE 2 of the batch import: the only place in the whole feature that reads
 * bytes off the share or writes to the inventory. Nothing here runs until the
 * user has pressed the confirm button.
 *
 * BATCHING STRATEGY: ONE FILE AT A TIME, WITH A YIELD AFTER EACH
 *
 * JavaScript is single-threaded. A long synchronous run means no repaints, no
 * scrolling and no responsive Cancel button - a hung app. So each file is
 * followed by `await yieldToBrowser()`, which hands control back to the event
 * loop long enough for Angular to repaint the progress bar.
 *
 * Why strictly sequential rather than, say, eight in parallel:
 *
 *   - Decoding a 46 MB JPEG onto a canvas needs its full uncompressed size in
 *     memory (a 8000x6000 photo is ~190 MB of RGBA). Eight of those at once is
 *     an out-of-memory crash, not a speed-up.
 *   - The files are on a network share; the transfer, not the CPU, is the
 *     bottleneck, and parallel reads off one SMB mount do not help much.
 *   - Sequential gives an honest, monotonic progress bar.
 *
 * Every file is wrapped in its own try/catch, so a corrupt JPEG is recorded as
 * one failure and the run continues to the end.
 *
 * WRITES ARE GROUPED PER COIN. Inventory saves are debounced per coin, so
 * calling updateCoin eight times for one coin would mean eight rounds of
 * change-tracking for a single save. One call per coin.
 *
 * COINS THAT ALREADY HAVE PHOTOS
 *
 * An unconditionally APPEND-ONLY, blind write -- existing photos, then every
 * ticked file, with no idea which of those files were already stored last
 * time -- means re-picking a folder tries to import every image again even
 * though most of the coins already have them.
 *
 * Two things prevent that, and both are here:
 *
 *   1. A CHOICE, because the program cannot guess the intent. `existingPhotoMode`
 *      is 'leave' (don't touch coins that have photos — the default, and the
 *      only option that can neither delete nor duplicate), 'replace' (their
 *      current photos go first) or 'add' (keep both). See existing-photo-mode.ts
 *      for why the default is what it is.
 *
 *   2. A SKIP, because even under 'add' a file that is already on the coin must
 *      not be attached twice. The comparison is on the ORIGINAL file's absolute
 *      path, supplied by the caller in `existingSourcePaths`; see
 *      already-attached.ts for why path and not filename or bytes.
 *
 * Both are evaluated BEFORE the file is read, which is the point: the cost this
 * removes is the read + JPEG decode + canvas downscale of a file that can be
 * 46 MB, pulled over an SMB share, for a photo we already have.
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
  // setTimeout(0) rather than a microtask: a resolved promise would be drained
  // within the same task and would NOT let a repaint through.
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
   * The base folder the user confirmed on the import screen, used to rebuild
   * each file's ABSOLUTE path.
   *
   * A browser never reveals where a file really lives — it only gives us
   * `File.webkitRelativePath`, the path relative to the folder that was picked.
   * The base folder is the missing front half. See source-path.ts for the full
   * explanation and the joining rules.
   *
   * Optional: with no base folder every image is attached with
   * `sourcePath: null`, which is exactly how the import behaved before this
   * feature existed.
   */
  baseFolder?: string;

  /**
   * What happens to coins that ALREADY have photos.
   *
   * Defaults to 'leave' when omitted, and that default is deliberately in the
   * runner as well as in the UI: a caller that forgets this option must not
   * fall back to the duplicate-everything behaviour the feature exists to
   * remove. See existing-photo-mode.ts.
   */
  existingPhotoMode?: ExistingPhotoMode;

  /**
   * Which ORIGINAL files are already attached to each coin — the response of
   * POST /api/coins/image-source-paths, keyed by coin id.
   *
   * These paths are not derivable in the browser: `CoinRecord.imagePaths`
   * holds only the downscaled `data:` URLs (see services/image-source-paths.ts
   * for why it was not widened), so they have to come from the backend.
   *
   * OPTIONAL, AND ABSENCE FAILS OPEN. With nothing here, nothing is recognised
   * as already attached and every ticked file is imported — exactly the
   * behaviour this import had before the feature existed. That is the right
   * way round: attaching a photo twice is visible and undoable, silently
   * dropping one the user wanted is not.
   */
  existingSourcePaths?: ExistingSourcePaths;

  /**
   * Fetch ONE coin's existing photographs, for the 'add' mode.
   *
   * WHY THIS IS NEEDED, AND WHAT HAPPENS WITHOUT IT
   *
   * 'add' means "keep both", and it is expressed by SENDING THE WHOLE
   * ARRAY: the coin's existing photographs followed by the new ones.
   * `PUT /api/coins/:id` then deletes every CoinImages row and re-inserts
   * exactly that. So the existing half has to be RIGHT.
   *
     * DO NOT read this off `coin.imagePaths`. That worked only while
     * `GET /api/coins` inlined every photograph; it no longer does, and the
     * key is ABSENT on a freshly loaded coin (see CoinRecord.imagePaths and
     * server/routes/coins/list-query.ts). A `?? []` fallback turns "not
     * loaded" into "none", making "keep both" send only the new photographs
     * and silently DELETE every photograph already on the coin.
     *
     * So: when the array is not in memory and `imageCount` says the coin has
     * some, this is called. Normally `InventoryService.loadCoinImages`, which
     * also hydrates the record.
   *
   * OPTIONAL, AND ABSENCE FAILS CLOSED. With no loader (and with a loader
   * that rejects) the coin is SKIPPED and its files are reported as
   * failures. That is the opposite of how `existingSourcePaths` above
   * degrades, and deliberately so: that one risks attaching a photo twice,
   * which is visible and undoable, while this one risks deleting
   * photographs that exist nowhere else.
   */
  loadExistingImages?: (coinId: string) => Promise<string[]>;

  /**
   * The write. Called once per coin.
   *
   * @param coinId     the coin being written
   * @param imagePaths that coin's COMPLETE new image array, as `data:` URL
   *                   strings. What is in it depends on `existingPhotoMode`:
   *                   under 'add' it is the existing photos followed by the
   *                   new ones, under 'replace' it is the new ones ALONE —
   *                   which is how the delete happens, because
   *                   `PUT /api/coins/:id` with an `imagePaths` key drops the
   *                   coin's CoinImages rows and re-inserts exactly what it is
   *                   given (see server/routes/coins/writes.ts). It stays
   *                   plain strings because that array is bound directly to
   *                   `<img [src]>` all over the app.
   * @param newImages  just the images added by THIS run, each paired with the
   *                   absolute path of its original file (or null when there is
   *                   no base folder to anchor it to). The caller records these
   *                   so the outgoing request can carry
   *                   `{ imageData, sourcePath }` — see
   *                   services/image-source-paths.ts.
   *
   * Injected rather than calling InventoryService directly, so the runner stays
   * a pure function of its inputs and the modal keeps control of the write.
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
   * WHAT WILL ACTUALLY BE READ — decided here, before a single byte moves.
   *
   * Three filters, in this order, and the order matters because each one is
   * cheaper than the one after it:
   *
   *   1. TICKED. A row is only ever written when it is ticked AND has a coin
   *      AND was not skipped. (Unchanged; this has always been the rule.)
   *   2. THE MODE. Under 'leave' — the default — a coin that already has
   *      photos drops out entirely. No read, no write, nothing.
   *   3. ALREADY ATTACHED. Of what survives, any file whose original path is
   *      already recorded against that coin drops out too. This is what turns
   *      "re-import a folder of 300 where 290 are already there" into ten
   *      files instead of three hundred.
   *
   * `toProcess` is then the honest denominator for the progress bar. Counting
   * every ticked row instead would crawl to 1/300 with most of them skipped
   * and then jump to done -- indistinguishable from a hang.
    */
  const mode = options.existingPhotoMode ?? DEFAULT_EXISTING_PHOTO_MODE;
  const selected = rowsWrittenUnderMode(rows, options.inventory, mode);

  /* Under 'replace' the coin's existing images are about to be deleted, so
   * "already attached" is about to stop being true. Skipping on it would leave
   * the coin with NO copy of that photo — the one way this feature could
   * destroy something outright — so the index is deliberately empty there. */
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

   /*
   * ANNOUNCE THE RUN BEFORE TOUCHING A SINGLE FILE.
   *
   * Reporting progress only AFTER a file has been read leaves the whole of
   * the first file with:
   *
   *   - no progress bar, because `progress` is still null; and
   *   - no disabled Save button, because `busy()` is derived from `progress`
   *     -- so a second click starts the entire import again.
   *
   * The first file is the worst possible one to be silent through: a full
   * read + JPEG decode + canvas downscale of something that can be 46 MB,
   * pulled over an SMB share.
   *
   * The yield is not optional garnish. A signal write only becomes pixels
   * when the current task ends; without it the emit above and the first
   * `encode()` below run in one unbroken task and the user sees neither.
    */
  options.onProgress?.({ ...progress });
  await yieldToBrowser();

  for (const [coinId, coinRows] of byCoin) {
    const coin = options.inventory.find(c => c.id === coinId);
    const newPaths: string[] = [];
    /**
     * The rows that actually produced an image. Needed because a coin can
     * still be abandoned AFTER its files have been read (see the `keep ===
     * null` branch below), and the progress counters then have to be put
     * back for exactly those rows and no others.
     */
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
        // Rebuild the original's absolute path while we still hold the File
        // handle: `webkitRelativePath` is only available here, and the
        // downscaled data URL we store carries no trace of where it came from.
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
      /* 'replace' is expressed HERE, as an empty "keep" list, and nowhere
       * else. `PUT /api/coins/:id` with an `imagePaths` key deletes the coin's
       * CoinImages rows and re-inserts exactly what it is handed (see
       * server/routes/coins/writes.ts), so leaving the old entries out IS the
       * delete. There is no separate delete call to get wrong.
       *
       * Which also means the 'add' branch has to be exactly right, because
       * anything missing from `keep` is deleted just as surely. See
       * resolveKeptImages() for the three ways it can know, and the one case
       * where it refuses to guess. */
      const keep = mode === 'replace' ? [] : await resolveKeptImages(coin, coinId, options);

      if (keep === null) {
        /* We do not know what this coin already has, and appending to an
         * unknown set means deleting it. SKIP THE COIN — a user who has to
         * re-run an import has lost a few minutes; a user whose photographs
         * were deleted has lost them for good. Every file for this coin is
         * reported so the failure is visible rather than silent. */
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

      /* The Set is here for the within-run case: two picked files that
       * downscale to byte-identical data URLs. It is NOT what prevents
       * re-importing a folder from duplicating photos -- a second import
       * produces freshly encoded strings, so the old entries and the new ones
       * are different strings for the same photograph and the Set sees
       * nothing wrong. The source-path skip above is what does that; do not
       * mistake one for the other. */
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
    // Everything in the plan that was not written: unticked photos, skipped
    // files, and rows the user never resolved.
    skipped: rows.length - toProcess.length,
    failures,
    coinsTouched,
    originalBytes,
    storedBytes
  };
}

 /*
 * "What does this coin already have?" — the append-mode question.
 *
 * THE DATA LOSS THIS PREVENTS
 *
 * 'add' ("keep both") is expressed by PUTting the coin's COMPLETE image
 * array: the existing photographs followed by the new ones. The server
 * deletes every CoinImages row and re-inserts exactly what it is handed. So
 * anything missing from the "keep" half is not merely omitted — it is
 * DELETED.
 *
 * DO NOT write `coin?.imagePaths ?? []` here. That is correct only while
 * `GET /api/coins` inlines every photograph; it no longer does, and the key
 * is absent on a freshly loaded coin. The `?? []` turns "I have not loaded
 * them" into "there are none", and "keep both" then wipes every photograph
 * on every coin it touches.
  */

/**
 * The photographs to keep, or NULL meaning "refuse to write this coin".
 *
 * Three ways to know, in increasing cost:
 *
 *   1. ALREADY IN MEMORY — the coin has been opened, or photos were attached
 *      to it earlier in this very run. This array is also the most current.
 *   2. `imageCount` IS ZERO — the server already said there is nothing here.
 *      An empty keep list is then a FACT, not a guess, and costs no request.
 *   3. FETCH IT — one round trip for one coin, via `loadExistingImages`.
 *
 * And one way not to know: no loader supplied, or the fetch failed. That
 * returns null, and the caller skips the coin entirely. Refusing to write is
 * the only safe answer, because the alternative — assuming empty — is
 * indistinguishable from "delete everything".
 */
async function resolveKeptImages(
  coin: CoinRecord | undefined,
  coinId: string,
  options: AttachOptions
): Promise<string[] | null> {
  // 1. Loaded already, including a genuine empty array.
  const inMemory = coinImagesInMemory(coin);
  if (inMemory) return inMemory;

  // 2. The server said this coin has no photographs. Nothing to preserve.
  //    Guarded on `coin` being present: an unknown id means "no information
  //    about this coin", which is not the same as "it has no photographs".
  if (coin && coinPhotoCount(coin) === 0) return [];

  // 3. Ask. A rejection is the loader doing its job — see its contract in
  //    services/coin-photos.ts: it must never turn a failure into `[]`.
  if (!options.loadExistingImages) return null;
  try {
    return await options.loadExistingImages(coinId);
  } catch {
    return null;
  }
}

/**
 * The absolute path this row's file WOULD be recorded at, or null.
 *
 * Used twice and it must give the same answer both times: once up front to
 * decide whether the file is already on the coin, and once after the encode to
 * record where the new image came from. Computing it in two places invites the
 * two from drifting, and a drift would mean a file skipped as a duplicate on
 * one rule and stored under a different path on the other.
 *
 * Null when there is no base folder, which is a legitimate long-standing way
 * to import — it just means nothing can be identified, so nothing is skipped.
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
