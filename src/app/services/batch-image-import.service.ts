/* ===========================================================================
 * BatchImageImportService
 * ---------------------------------------------------------------------------
 * The engine behind "point at a folder and attach the photos to my coins".
 *
 * It owns two jobs, and the whole design of the feature comes out of the order
 * they run in:
 *
 *   1. PLAN  (cheap)      - match FILENAMES to coins. No file is opened.
 *   2. APPLY (expensive)  - read + shrink + save ONLY the files the user
 *                           ticked. Lives in ./image-import/attach-runner.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY FILENAME-ONLY MATCHING HAPPENS BEFORE ANY FILE IS READ
 * ---------------------------------------------------------------------------
 * The share is 4.2 GB across ~2,140 files (average 2.5 MB, largest 46 MB).
 * `<input webkitdirectory>` hands us File handles instantly - that part is
 * free, because a File is only a pointer to something on disk. The expensive
 * part is `file.arrayBuffer()` / decoding, which pulls the bytes over the
 * network share and into browser memory.
 *
 * Read everything up front and you ask the browser to hold gigabytes of pixel
 * data. It will not: the tab dies, or the user stares at a frozen window for
 * several minutes.
 *
 * And it would be pointless work, because the matcher needs NOTHING but the
 * name: "1880-S $1 - MS64 - Obverse - Photo.jpg" identifies the coin
 * completely. So stage 1 touches only `file.name`, which makes the review
 * screen appear in well under a second even for the full share. Bytes are
 * only ever read for the files the user actually confirms - typically a few
 * hundred, not 1,700, and with a progress bar in front of them.
 * =========================================================================== */

import { Injectable, inject } from '@angular/core';
import {
  BatchImageRow,
  BatchImportSummary,
  CoinImageGroup,
  CoinRecord,
  ImageMatchResult
} from '../types/coin.model';
import { ImageMatchingService } from './image-matching.service';
import { ImageDownscaleService } from './image-import/image-downscaler';
import { describePhoto, sideSortOrder } from './image-import/photo-variant';
import {
  AttachOptions,
  EncodedImage,
  runAttach,
  yieldToBrowser
} from './image-import/attach-runner';

/**
 * How many filenames we match before yielding to the browser.
 *
 * The trade-off: `matchImages` re-derives the coin signatures on every call,
 * so smaller chunks mean more repeated work, while larger chunks mean longer
 * freezes. 200 keeps each chunk in the low tens of milliseconds (comfortably
 * inside one animation frame) and costs ~9 signature rebuilds for the full
 * share, which is nothing next to a single file read.
 */
export const MATCH_CHUNK_SIZE = 200;

/** Re-exported so callers only need to import this service. */
export type { AttachOptions, EncodedImage };

@Injectable({ providedIn: 'root' })
export class BatchImageImportService {
  private readonly matcher = inject(ImageMatchingService);
  private readonly downscaler = inject(ImageDownscaleService);

  /* =========================================================================
   * STAGE 1 - PLAN (filenames only, nothing is read)
   * ======================================================================= */

  /**
   * Match a filtered list of image files against the inventory and build the
   * review rows.
   *
   * @param files     already filtered to displayable images (see image-file-filter)
   * @param inventory the coins to match against
   * @param onChunk   progress callback: (matched so far, total)
   */
  async buildRows(
    files: readonly File[],
    inventory: readonly CoinRecord[],
    onChunk?: (done: number, total: number) => void
  ): Promise<BatchImageRow[]> {
    const rows: BatchImageRow[] = [];

    for (let start = 0; start < files.length; start += MATCH_CHUNK_SIZE) {
      const chunk = files.slice(start, start + MATCH_CHUNK_SIZE);

      // The ONLY thing handed to the matcher is the name. No file.arrayBuffer().
      const results = this.matcher.matchImages(
        chunk.map(f => f.name),
        inventory as CoinRecord[]
      );

      for (let i = 0; i < chunk.length; i++) {
        rows.push(this.toRow(chunk[i], results[i]));
      }

      onChunk?.(Math.min(start + chunk.length, files.length), files.length);

      // Let the browser paint the progress bar before the next chunk.
      if (start + MATCH_CHUNK_SIZE < files.length) await yieldToBrowser();
    }

    return rows;
  }

  /** One matcher result -> one review row. */
  private toRow(file: File, result: ImageMatchResult): BatchImageRow {
    // Only a confident ('auto') match gets a coin and starts ticked. 'review'
    // and 'none' rows start with no coin at all, so an unattended import can
    // never mis-file a photo. Once the user resolves them they tick too.
    const isAuto = result.status === 'auto' && !!result.matchedRecordId;

    return {
      fileName: file.name,
      // Deliberately empty: object URLs are created lazily, only for the coin
      // groups the user actually expands. 1,700 <img> tags each decoding a
      // 2.5 MB JPEG would be just as fatal as reading the files up front.
      thumbnailUrl: '',
      result,
      selectedCoinId: isAuto ? result.matchedRecordId : null,
      selectionReason: result.reason,
      confidence: result.confidence,
      decision: isAuto ? 'auto' : 'review',
      // "All matched images start selected."
      selected: isAuto,
      photo: describePhoto(file.name, result.parsed),
      sizeBytes: file.size
    };
  }

  /* =========================================================================
   * GROUPING - one row per COIN, not one row per file
   * ======================================================================= */

  /**
   * Collapse rows into per-coin groups for the review screen.
   *
   * A flat list of 1,700 files is unreviewable; "here are the 8 photos I think
   * belong to your 1880-S Morgan, are they right?" is a question a human can
   * actually answer. Rows with no coin yet are not grouped - they live in the
   * needs-a-choice / no-match buckets instead.
   *
   * Within a group, photos are ordered Obverse, Reverse, Label, then the rest,
   * so the two shots that matter are always the first two thumbnails.
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
      // Weakest matches first: the groups most likely to be wrong are the ones
      // the user should look at, and they would otherwise be buried.
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

  /* =========================================================================
   * STAGE 2 - APPLY (delegated to attach-runner.ts)
   * ======================================================================= */

  /**
   * Read, shrink and save every ticked row. See attach-runner.ts for the
   * sequential-with-yield strategy and the per-file error isolation.
   *
   * `options.encode` is optional: leave it out and the real <canvas>
   * downscaler is used. Tests pass a stub, because there is no canvas in the
   * unit-test environment.
   */
  attachSelected(
    rows: readonly BatchImageRow[],
    options: Omit<AttachOptions, 'encode'> & { encode?: AttachOptions['encode'] }
  ): Promise<BatchImportSummary> {
    return runAttach(rows, {
      ...options,
      encode: options.encode ?? (file => this.encodeWithDownscaler(file))
    });
  }

  /** The production encoder: shrink to 1600 px / quality 0.85 via <canvas>. */
  private async encodeWithDownscaler(file: File): Promise<EncodedImage> {
    const result = await this.downscaler.downscale(file);
    return {
      dataUrl: result.dataUrl,
      originalBytes: result.originalBytes,
      storedBytes: result.storedBytes
    };
  }
}
