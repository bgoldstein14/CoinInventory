import { computed, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../api.service';
import { InventoryService } from '../inventory.service';
import { ImageMatchingService } from '../image-matching.service';
import { BatchImageImportService } from '../batch-image-import.service';
import { filterImageFiles } from './image-file-filter';
import { applyBulkAction, toggleRow } from './selection-rules';
import * as decisions from './row-decisions';
import { CoinLookup } from './coin-lookup';
import { ThumbnailCache } from './thumbnail-cache';
import { EncodedImage } from './attach-runner';
import { StorageService } from '../storage.service';
import { imageSourcePaths } from '../image-source-paths';
import { BaseFolderState } from './base-folder-state';
import {
  BatchImageRow,
  BatchImportProgress,
  BatchImportSummary,
  ImageFileFilterResult,
  RankedImageMatch,
  SelectionBulkAction
} from '../../types/coin.model';

/**
 * BatchImportSession — all the state for one run of the batch image import.
 *
 * WHY THIS FILE EXISTS
 * The import is a four-step flow with a fair amount of state: the filter
 * report, the review rows, per-row search boxes, which coin groups are open,
 * the lazily-created thumbnail URLs, live progress and the final summary.
 * Keeping it out of the component follows the same pattern as
 * `features/inventory/*.store.ts`: the component becomes markup plus a couple
 * of event handlers, and the interesting logic is unit-testable without a
 * browser.
 *
 * THE FLOW (and why it is in this order)
 *  1. FILTER   - drop everything a browser cannot draw (.dng, .CR2, .psd,
 *                Thumbs.db ...) and report the count with a reason, so the
 *                user can see nothing was quietly thrown away.
 *  2. MATCH    - on FILENAMES ONLY, in chunks, with a progress line. Not a
 *                single byte is read: the share is 4.2 GB and reading it all
 *                would hang the tab, while the matcher needs only the name.
 *  3. REVIEW   - grouped BY COIN, not as a flat 1,700-row list. Every matched
 *                photo starts ticked; the user unticks what he does not want,
 *                helped by bulk rules (keep only Obverse+Reverse, deselect
 *                retakes, deselect Label shots).
 *  4. CONFIRM  - and only now are the ticked files read, downscaled to
 *                1600px / quality 0.85 and saved, one at a time, with
 *                progress. A failure on one file is recorded and the rest of
 *                the batch carries on.
 *
 * Nothing whatsoever is written to the inventory before step 4.
 */
export class BatchImportSession {
  /** One row per accepted image file. */
  readonly imageReviews = signal<BatchImageRow[]>([]);

  /** What the extension filter kept and threw away. */
  readonly filterResult = signal<ImageFileFilterResult | null>(null);

  /** Coin ids whose thumbnails are currently rendered. */
  readonly expandedCoins = signal<Set<string>>(new Set());

  /** Live progress for both long stages. */
  readonly progress = signal<BatchImportProgress | null>(null);

  /** End-of-run report; null until the import has actually run. */
  readonly summary = signal<BatchImportSummary | null>(null);

  /** Lazily-created object URLs for thumbnails. */
  private readonly thumbnails = new ThumbnailCache();

  /**
   * The folder the picked photos actually live in, on the machine hosting the
   * app — the one thing a browser refuses to tell us, so the user confirms it
   * once and it is remembered. See base-folder-state.ts and source-path.ts.
   *
   * On a fresh install there is nothing remembered, so it starts from the app's
   * own folder as reported by the backend (`GET /api/app-info`). That is a
   * starting point to edit, not a guess at where the photos are.
   *
   * Set up in the constructor because it needs the StorageService, the
   * ApiService and a signal for the first selected file.
   */
  readonly folder: BaseFolderState;

  /**
   * Test seam. Left undefined in the app, in which case the batch service uses
   * the real <canvas> downscaler. There is no canvas in the unit-test
   * environment, so the specs install a stub here.
   */
  encoder: ((file: File) => Promise<EncodedImage>) | undefined = undefined;

  /**
   * Coin labels and the per-photo "find a different coin" search boxes.
   * Public because the template and the child components need it.
   */
  readonly coins: CoinLookup;

  constructor(
    private readonly inv: InventoryService,
    matching: ImageMatchingService,
    private readonly batch: BatchImageImportService,
    /**
     * Where the base folder is remembered between sessions. Optional so the
     * session can still be constructed in an injection context that does not
     * provide StorageService (which is how some unit tests build it); without
     * it the folder simply resets each time.
     */
    storage?: StorageService,
    /**
     * Used for ONE thing: asking the backend where the app is installed, so a
     * first-time user's base-folder box starts from a real path on the host
     * instead of blank. Optional for the same reason as `storage` — the unit
     * tests build this from a bare Injector — and the import works fine without
     * it, just with an empty box until the user types something.
     */
    api?: ApiService
  ) {
    this.coins = new CoinLookup(inv, matching);
    this.folder = new BaseFolderState(
      // The live example is built from the first file of the current selection.
      computed(() => this.filterResult()?.accepted?.[0]),
      storage,
      // Adapt the Observable API to the plain promise BaseFolderState wants.
      // `firstValueFrom` is safe here specifically because `getAppFolder()` is
      // built never to error and always to emit (it maps failures to ''), so
      // this can neither reject nor hang past its own 5s timeout.
      api ? () => firstValueFrom(api.getAppFolder()) : undefined
    );
    // Fire-and-forget: the box starts empty and is filled in a moment later
    // with the saved folder, or with the app's folder if nothing was saved.
    // Nothing can be imported in that window, so there is no race to worry
    // about — and if the restore fails outright, an empty box is a state the
    // screen already handles with a visible warning.
    void this.folder.restore();
  }

  /* ---------------------------------------------------------------------
   * Derived views
   * ------------------------------------------------------------------- */

  /** Matcher was confident. */
  readonly autoMatches = computed(() =>
    this.imageReviews().filter(r => r.result.status === 'auto')
  );

  /** Matcher had candidates but was not certain. */
  readonly reviewMatches = computed(() =>
    this.imageReviews().filter(r => r.result.status === 'review')
  );

  /** Matcher had nothing worth suggesting. */
  readonly unmatchedImages = computed(() =>
    this.imageReviews().filter(r => r.result.status === 'none')
  );

  /** Rows still waiting on the user. */
  readonly outstandingCount = computed(() =>
    this.imageReviews().filter(r => r.decision === 'review').length
  );

  /** The review screen's main content: one entry per matched coin. */
  readonly coinGroups = computed(() =>
    this.batch.groupByCoin(this.imageReviews(), id => this.coins.nameById(id))
  );

  /** Rows that will actually be written on confirm. */
  readonly readyToAttach = computed(() =>
    this.imageReviews().filter(r => r.selected && !!r.selectedCoinId && r.decision !== 'skipped')
  );

  readonly attachCount = computed(() => this.readyToAttach().length);

  /** True while a long stage is running, so the buttons can be disabled. */
  readonly busy = computed(() => {
    const phase = this.progress()?.phase;
    return phase === 'matching' || phase === 'attaching';
  });

  /** Thumbnail URLs, passed straight down to the child components. */
  readonly thumbnailUrls = computed(() => this.thumbnails.urls());

  /* ---------------------------------------------------------------------
   * 1 + 2. File selection, filtering and filename matching
   * ------------------------------------------------------------------- */

  async handleDirectorySelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';

    // FILTER FIRST. Everything downstream can then assume "this is an image
    // the browser can draw", and the user gets an honest skipped-file report.
    const filtered = filterImageFiles(files);
    if (filtered.accepted.length === 0) {
      // Still surface the report - "0 of 43 files were usable" is information.
      this.filterResult.set(filtered.totalSelected > 0 ? filtered : null);
      return;
    }

    this.reset();
    this.filterResult.set(filtered);
    this.thumbnails.register(filtered.accepted);

    // Matching is chunked so the progress line can repaint between chunks.
    this.setMatchProgress(0, filtered.accepted.length);
    const rows = await this.batch.buildRows(
      filtered.accepted,
      this.inv.inventory(),
      (done, total) => this.setMatchProgress(done, total)
    );

    this.imageReviews.set(rows);
    this.progress.set(null);
  }

  private setMatchProgress(processed: number, total: number): void {
    this.progress.set({
      total, processed, attached: 0, failed: 0, currentFile: '', phase: 'matching'
    });
  }

  /* ---------------------------------------------------------------------
   * 3. Review: tick boxes, bulk rules, per-file decisions
   * ------------------------------------------------------------------- */

  /** Flip one photo's tick box. */
  toggleImage(fileName: string): void {
    this.imageReviews.update(rows => toggleRow(rows, fileName));
  }

  /** Run a bulk rule over one coin's photos, or over the whole batch. */
  runBulkAction(action: SelectionBulkAction, coinId?: string): void {
    this.imageReviews.update(rows => applyBulkAction(rows, action, coinId));
  }

  /**
   * Show or hide one coin's thumbnails, creating the object URLs on the way in.
   *
   * This is the other half of staying responsive: URLs (and therefore image
   * decodes) only ever exist for groups the user has actually opened.
   */
  toggleCoinGroup(coinId: string): void {
    const open = new Set(this.expandedCoins());
    if (open.has(coinId)) {
      open.delete(coinId);
    } else {
      open.add(coinId);
      this.thumbnails.create(
        this.imageReviews().filter(r => r.selectedCoinId === coinId).map(r => r.fileName)
      );
    }
    this.expandedCoins.set(open);
  }

  isCoinGroupExpanded(coinId: string): boolean {
    return this.expandedCoins().has(coinId);
  }

  confirmImageMatch(fileName: string): void {
    this.imageReviews.update(rows => decisions.confirmMatch(rows, fileName));
  }

  rejectImageMatch(fileName: string): void {
    this.imageReviews.update(rows => decisions.rejectMatch(rows, fileName));
  }

  chooseCandidate(fileName: string, candidate: RankedImageMatch): void {
    this.imageReviews.update(rows => decisions.chooseCandidate(rows, fileName, candidate));
  }

  reassignImageMatch(fileName: string, coinId: string): void {
    const label = this.coins.nameById(coinId);
    this.imageReviews.update(rows => decisions.assignCoin(rows, fileName, coinId, label));
    this.coins.setTerm(fileName, '');
  }

  skipImage(fileName: string): void {
    this.imageReviews.update(rows => decisions.skipRow(rows, fileName));
  }

  resetDecision(fileName: string): void {
    this.imageReviews.update(rows => decisions.resetRow(rows, fileName));
  }

  thumbnailFor(fileName: string): string {
    return this.thumbnails.urls()[fileName] ?? '';
  }

  /* ---------------------------------------------------------------------
   * 4. Confirm - the only place files are read and the database is written
   * ------------------------------------------------------------------- */

  async applyConfirmedMatches(): Promise<void> {
    const result = await this.batch.attachSelected(this.imageReviews(), {
      files: this.thumbnails.files,
      inventory: this.inv.inventory(),
      // The front half of every absolute path. The runner pairs it with each
      // file's webkitRelativePath — see source-path.ts.
      baseFolder: this.folder.value(),
      // Append-only: the merged list is built by the runner from the coin's
      // existing imagePaths, and updateCoin patches that ONE field.
      attach: (coinId, imagePaths, newImages) => {
        // Record where each new original lives BEFORE the write, because
        // CoinEditor reads this registry on its way out and turns the plain
        // `imagePaths` strings into the `{ imageData, sourcePath }` form the
        // backend accepts. `imagePaths` itself stays strings, since that array
        // is what every <img [src]> in the app binds to.
        imageSourcePaths.recordAll(newImages);
        this.inv.updateCoin(coinId, { imagePaths });
      },
      onProgress: progress => this.progress.set(progress),
      encode: this.encoder
    });

    this.summary.set(result);
    this.progress.set(null);
  }

  /** Drop every trace of the run, revoking the blob URLs on the way out. */
  reset(): void {
    this.thumbnails.clear();
    this.coins.clear();
    this.imageReviews.set([]);
    this.expandedCoins.set(new Set());
    this.filterResult.set(null);
    this.progress.set(null);
    this.summary.set(null);
  }
}
