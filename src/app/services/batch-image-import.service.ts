 /**
  * Engine behind "point at a folder and attach the photos to my coins".
  *
  *   1. Plan  (cheap)     match filenames to coins; no file is read.
  *   2. Apply (expensive) read, shrink and save only the ticked files
  *                        (./image-import/attach-runner.ts).
  *
  * Matching uses only `file.name`: a File from `<input webkitdirectory>` is just
  * a handle, and reading thousands of multi-MB photos from a network share up
  * front would exhaust browser memory. The filename alone identifies the coin,
  * e.g. "1880-S $1 - MS64 - Obverse - Photo.jpg".
  */

import { Injectable, inject } from '@angular/core';
import {
  BatchImageRow,
  BatchImportSummary,
  CoinImageGroup,
  CoinRecord,
  ImageMatchResult,
  NearMatchGroup
} from '../types/coin.model';
import { ImageMatchingService } from './image-matching.service';
import {
  denominationLabelSnapshot,
  type LabelledDenomination
} from './image-matching/coin-signature';
import { ImageDownscaleService } from './image-import/image-downscaler';
import { DEFAULT_MAX_STORED_IMAGE_BYTES } from './image-import/image-storage-settings';
import { describePhoto, sideSortOrder } from './image-import/photo-variant';
import {
  AttachOptions,
  EncodedImage,
  runAttach,
  yieldToBrowser
} from './image-import/attach-runner';

/**
 * Filenames matched per chunk before yielding to the browser. `matchImages`
 * rebuilds coin signatures per call, so this balances repeated work against
 * UI freezes.
 */
export const MATCH_CHUNK_SIZE = 200;

export type { AttachOptions, EncodedImage };

@Injectable({ providedIn: 'root' })
export class BatchImageImportService {
  private readonly matcher = inject(ImageMatchingService);
  private readonly downscaler = inject(ImageDownscaleService);

  /**
   * Matches image files against the inventory and builds the review rows.
   *
   * @param files         already filtered to displayable images (see image-file-filter)
   * @param onChunk       progress callback: (matched so far, total)
   * @param denominations optional denominations lookup, so linked coins are
   *   identified by their `DenominationId`
   */
  async buildRows(
    files: readonly File[],
    inventory: readonly CoinRecord[],
    onChunk?: (done: number, total: number) => void,
    denominations: readonly LabelledDenomination[] = []
  ): Promise<BatchImageRow[]> {
    const rows: BatchImageRow[] = [];

     // Snapshot the lookup once, before the chunked loop, so a lookup response
     // arriving mid-import can't make chunks match under different rules.
    const denominationLabels = denominationLabelSnapshot(denominations);

    for (let start = 0; start < files.length; start += MATCH_CHUNK_SIZE) {
      const chunk = files.slice(start, start + MATCH_CHUNK_SIZE);

      // Only the name is passed to the matcher; no file bytes are read.
      const results = this.matcher.matchImages(
        chunk.map(f => f.name),
        inventory as CoinRecord[],
        denominationLabels
      );

      for (let i = 0; i < chunk.length; i++) {
        rows.push(this.toRow(chunk[i], results[i]));
      }

      onChunk?.(Math.min(start + chunk.length, files.length), files.length);

      // Let the browser paint the progress bar.
      if (start + MATCH_CHUNK_SIZE < files.length) await yieldToBrowser();
    }

    return rows;
  }

  /**
   * One matcher result -> one review row, starting state set by tier
   * (see image-matching/near-match.ts):
   *   'matched'      coin attached, ticked, decision 'auto'
   *   'near'         no coin, unticked, decision 'review' (waits on the user)
   *   'not-imported' no coin, unticked, decision 'skipped' (listed read-only
   *                  with its skipReason)
   */
  private toRow(file: File, result: ImageMatchResult): BatchImageRow {
    const isMatched = result.tier === 'matched' && !!result.matchedRecordId;
    const isAutoSkipped = result.tier === 'not-imported';

    return {
      fileName: file.name,
      // Object URLs are created lazily, only for groups the user expands.
      thumbnailUrl: '',
      result,
      selectedCoinId: isMatched ? result.matchedRecordId : null,
      // For skipped rows the short reason reads better than the full scoring sentence.
      selectionReason: isAutoSkipped ? (result.skipReason ?? result.reason) : result.reason,
      confidence: result.confidence,
      decision: isMatched ? 'auto' : isAutoSkipped ? 'skipped' : 'review',
      // Only matched images start selected.
      selected: isMatched,
      photo: describePhoto(file.name, result.parsed),
      sizeBytes: file.size
    };
  }

  /**
   * Groups near-match rows by suggested coin, so several photos of one coin are
   * one question. Groups with the most outstanding rows come first.
   */
  groupNearMatches(rows: readonly BatchImageRow[]): NearMatchGroup[] {
    const groups = new Map<string, BatchImageRow[]>();

    for (const row of rows) {
      const suggestion = row.result.nearMatch;
      if (row.result.tier !== 'near' || !suggestion) continue;
      const bucket = groups.get(suggestion.suggestedCoinId);
      if (bucket) bucket.push(row);
      else groups.set(suggestion.suggestedCoinId, [row]);
    }

    return [...groups.entries()]
      .map(([coinId, coinRows]) => {
        const ordered = [...coinRows].sort(
          (a, b) =>
            sideSortOrder(a.photo.side) - sideSortOrder(b.photo.side) ||
            (a.photo.takeNumber ?? 0) - (b.photo.takeNumber ?? 0) ||
            a.fileName.localeCompare(b.fileName)
        );
        return {
          coinId,
          coinLabel: ordered[0].result.nearMatch!.suggestedCoinLabel,
          rows: ordered,
          outstandingCount: ordered.filter(r => r.decision === 'review').length
        };
      })
      .sort((a, b) => b.outstandingCount - a.outstandingCount || a.coinLabel.localeCompare(b.coinLabel));
  }

  /**
   * Groups rows with a coin into per-coin groups for the review screen. Photos
   * are ordered Obverse, Reverse, Label, then the rest.
   */
  groupByCoin(
    rows: readonly BatchImageRow[],
    labelFor: (coinId: string) => string
  ): CoinImageGroup[] {
    const groups = new Map<string, BatchImageRow[]>();

    for (const row of rows) {
      if (!row.selectedCoinId || row.decision === 'skipped') continue;
      const bucket = groups.get(row.selectedCoinId);
      if (bucket) bucket.push(row);
      else groups.set(row.selectedCoinId, [row]);
    }

    return [...groups.entries()]
      .map(([coinId, coinRows]) => this.toGroup(coinId, coinRows, labelFor))
      // Weakest matches first: those are the most likely to be wrong.
      .sort((a, b) => a.topConfidence - b.topConfidence || a.coinLabel.localeCompare(b.coinLabel));
  }

  private toGroup(
    coinId: string,
    coinRows: readonly BatchImageRow[],
    labelFor: (coinId: string) => string
  ): CoinImageGroup {
    const ordered = [...coinRows].sort(
      (a, b) =>
        sideSortOrder(a.photo.side) - sideSortOrder(b.photo.side) ||
        (a.photo.takeNumber ?? 0) - (b.photo.takeNumber ?? 0) ||
        a.fileName.localeCompare(b.fileName)
    );
    return {
      coinId,
      coinLabel: labelFor(coinId),
      rows: ordered,
      selectedCount: ordered.filter(r => r.selected).length,
      topConfidence: ordered.reduce((max, r) => Math.max(max, r.confidence), 0)
    };
  }

  /**
   * Reads, shrinks and saves every ticked row (see attach-runner.ts).
   * `options.encode` defaults to the <canvas> downscaler; tests pass a stub.
   */
  attachSelected(
    rows: readonly BatchImageRow[],
    options: Omit<AttachOptions, 'encode'> & {
      encode?: AttachOptions['encode'];
      /**
       * Size budget for the stored copy, from Settings. Omitted means the default,
       * which is above anything the encoder produces. Ignored when `encode` is
       * supplied. See image-import/encode-budget.ts.
       */
      maxStoredImageBytes?: number;
    }
  ): Promise<BatchImportSummary> {
    const { maxStoredImageBytes, ...attachOptions } = options;

    return runAttach(rows, {
      ...attachOptions,
      encode: options.encode ?? (file => this.encodeWithDownscaler(file, maxStoredImageBytes))
    });
  }

  /** Production encoder: shrink to 1600 px / quality 0.85 via <canvas>. */
  private async encodeWithDownscaler(
    file: File,
    maxStoredImageBytes?: number
  ): Promise<EncodedImage> {
    const budget = maxStoredImageBytes ?? DEFAULT_MAX_STORED_IMAGE_BYTES;
    const { result } = await this.downscaler.downscaleWithin(file, budget);
    return {
      dataUrl: result.dataUrl,
      originalBytes: result.originalBytes,
      storedBytes: result.storedBytes
    };
  }
}
