/* ===========================================================================
 * attach-runner.ts
 * ---------------------------------------------------------------------------
 * STAGE 2 of the batch import: the only place in the whole feature that reads
 * bytes off the share or writes to the inventory. Nothing here runs until the
 * user has pressed the confirm button.
 *
 * ---------------------------------------------------------------------------
 * BATCHING STRATEGY: ONE FILE AT A TIME, WITH A YIELD AFTER EACH
 * ---------------------------------------------------------------------------
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
 * change-tracking for a single save. One call per coin, with the coin's
 * existing photos merged in - this is an APPEND, never a replace.
 * =========================================================================== */

import {
  BatchImageRow,
  BatchImportFailure,
  BatchImportProgress,
  BatchImportSummary,
  CoinRecord
} from '../../types/coin.model';
import { AttachedImage } from '../../types/coin-image.model';
import { sourcePathForFile } from './source-path';

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
   * The write. Called once per coin.
   *
   * @param coinId     the coin being written
   * @param imagePaths that coin's COMPLETE new image array, as `data:` URL
   *                   strings — existing photos first, then the new ones. This
   *                   is what goes into `updateCoin({ imagePaths })`, and it
   *                   stays plain strings because that array is bound directly
   *                   to `<img [src]>` all over the app.
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
  // A row is only written when it is ticked AND has a coin AND was not skipped.
  const toProcess = rows.filter(r => r.selected && r.selectedCoinId && r.decision !== 'skipped');
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

  for (const [coinId, coinRows] of byCoin) {
    const coin = options.inventory.find(c => c.id === coinId);
    const newPaths: string[] = [];
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
          sourcePath: options.baseFolder ? sourcePathForFile(options.baseFolder, file) : null
        });
        originalBytes += encoded.originalBytes;
        storedBytes += encoded.storedBytes;
        progress.attached += 1;
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
      // Set semantics: re-importing the same folder must not duplicate photos.
      const merged = [...new Set([...(coin?.imagePaths ?? []), ...newPaths])];
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
