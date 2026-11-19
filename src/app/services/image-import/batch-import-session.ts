import { computed, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../api.service';
import { InventoryService } from '../inventory.service';
import { ImageMatchingService } from '../image-matching.service';
import { BatchImageImportService } from '../batch-image-import.service';
import { filterImageFiles } from './image-file-filter';
import { applyBulkAction, toggleRow } from './selection-rules';
import * as decisions from './row-decisions';
import { groupPhotoSets } from './photo-sets';
import { CoinLookup } from './coin-lookup';
import { ThumbnailCache } from './thumbnail-cache';
import { EncodedImage, yieldToBrowser } from './attach-runner';
import {
  buildingProgress,
  isBusy,
  isIndeterminate,
  matchingProgress,
  progressDetail,
  progressLabel,
  progressPercent,
  saveButtonLabel,
  scanningProgress,
  startingAttachProgress
} from './import-progress';
import { StorageService } from '../storage.service';
import { imageSourcePaths } from '../image-source-paths';
import { BaseFolderState } from './base-folder-state';
import { verifyBaseFolder, verdictMessage } from './base-folder-check';
import {
  DEFAULT_IMAGE_STORAGE_SETTINGS,
  loadImageStorageSettings,
  type ImageStorageSettings
} from './image-storage-settings';
import { makeReferencedEncoder, NO_BASE_FOLDER_MESSAGE } from './referenced-encoder';
import { referenceUrlForPath } from './reference-url';
import { chunkCoinIds, type ExistingSourcePaths } from './already-attached';
import {
  DEFAULT_EXISTING_PHOTO_MODE,
  coinIdsWithExistingPhotos,
  countExistingPhotos,
  replaceConfirmationMessage,
  rowsWrittenUnderMode,
  type ExistingPhotoMode
} from './existing-photo-mode';
import { confirmAction } from '../../features/confirm-action';
import {
  BatchImageRow,
  BatchImportProgress,
  BatchImportSummary,
  ImageFileFilterResult,
  RankedImageMatch,
  SelectionBulkAction
} from '../../types/coin.model';

/**
 * "This row will be written when Save is pressed." The same filter
 * `attach-runner.runAttach` applies, so on-screen counts match the run. Keys
 * off the decision, not the tier, so rescued tier-3 rows attach the same way.
 */
const willAttach = (row: BatchImageRow): boolean =>
  row.selected && !!row.selectedCoinId && row.decision !== 'skipped';

/**
 * All state for one run of the batch image import, kept out of the component
 * so the logic is unit-testable. Background: docs/rationale/image-and-denominations.md.
 *
 * Flow:
 *  1. Filter  - drop files a browser can't draw and report them.
 *  2. Match   - on filenames only, in chunks, with progress. No file bytes are read.
 *  3. Review  - grouped by coin, with bulk selection rules.
 *  4. Confirm - only now are ticked files read, downscaled and saved one at a
 *               time; a failure on one file doesn't stop the batch.
 *
 * Nothing is written to the inventory before step 4.
 */
export class BatchImportSession {
  /** One row per accepted image file. */
  readonly imageReviews = signal<BatchImageRow[]>([]);

  /** What the extension filter kept and threw away. */
  readonly filterResult = signal<ImageFileFilterResult | null>(null);

  /**
   * Why the last import attempt was refused (the base-folder guard), or null.
   * Cleared at the start of every attempt.
   */
  readonly blockedReason = signal<string | null>(null);

  /**
   * What happens to matched coins that already have photos. Defaults to
   * 'leave', the only option that neither deletes nor duplicates. See
   * existing-photo-mode.ts.
   */
  readonly existingPhotoMode = signal<ExistingPhotoMode>(DEFAULT_EXISTING_PHOTO_MODE);

  /** Coin ids whose thumbnails are currently rendered (tier 1). */
  readonly expandedCoins = signal<Set<string>>(new Set());

  /** Near-match group ids whose thumbnails are currently rendered (tier 2). */
  readonly nearPhotoGroups = signal<Set<string>>(new Set());

  /**
   * Tier 3 rows whose "Attach anyway" panel is open. Empty unless the user
   * clicks, so tier 3 stays a read-only list.
   */
  readonly rescueOpen = signal<Set<string>>(new Set());

  /** Live progress for both long stages. */
  readonly progress = signal<BatchImportProgress | null>(null);

  /** End-of-run report; null until the import has actually run. */
  readonly summary = signal<BatchImportSummary | null>(null);

  /** Lazily-created object URLs for thumbnails. */
  private readonly thumbnails = new ThumbnailCache();

  /**
   * Photo storage settings from Settings, shown on the review screen so the
   * user knows whether pictures or only paths will be stored. Re-read at
   * confirm time. See image-storage-settings.ts.
   */
  readonly storageSettings = signal<ImageStorageSettings>({
    ...DEFAULT_IMAGE_STORAGE_SETTINGS
  });

  /**
   * The folder the picked photos live in on the host machine, which a browser
   * won't reveal; the user confirms it once and it is remembered. Starts empty
   * on a fresh install. See base-folder-state.ts and source-path.ts.
   */
  readonly folder: BaseFolderState;

  /** Test seam: a stub encoder for specs (no <canvas> in tests). Undefined in the app. */
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
    /** Remembers the base folder and photo-storage settings. Optional (some tests omit it). */
    private readonly storage?: StorageService,
    /**
     * Used to check that recorded paths resolve on disk before writing (see
     * base-folder-check.ts). Optional; without it the import proceeds unchecked.
     */
    private readonly api?: ApiService
  ) {
    this.coins = new CoinLookup(inv, matching);
    this.folder = new BaseFolderState(
      // The live example is built from the first file of the current selection.
      computed(() => this.filterResult()?.accepted?.[0]),
      storage,
      api ? async () => firstValueFrom(api.getDocumentsFolder()) : undefined
    );
    // Fire-and-forget restores. Nothing can be imported before they finish,
    // and the defaults are safe if they fail. Settings are re-read at confirm.
    void this.folder.restore();
    void loadImageStorageSettings(storage).then(settings =>
      this.storageSettings.set(settings)
    );
  }

  /*
   * Review tiers, taken from `result.tier` (decided in near-match.ts); the
   * screen does no classifying of its own.
   *   Tier 1 matchedImages  attached automatically; the user may untick/skip.
   *   Tier 2 nearMatches    one yes/no each, usually grouped per coin.
   *   Tier 3 notImported    skipped automatically, listed read-only.
   */

  /** TIER 1. Matcher cleared all three auto gates. */
  readonly matchedImages = computed(() =>
    this.imageReviews().filter(r => r.result.tier === 'matched')
  );

  /**
   * Tier 1 by `status` rather than tier. Identical to `matchedImages`; kept so a
   * test can assert the two agree.
   */
  readonly autoMatches = computed(() =>
    this.imageReviews().filter(r => r.result.status === 'auto')
  );

  /** TIER 2. Same coin on all four attributes, something else off. */
  readonly nearMatches = computed(() =>
    this.imageReviews().filter(r => r.result.tier === 'near')
  );

  /** Tier 2 grouped by suggested coin, so five photos of one coin are one question. */
  readonly nearMatchGroups = computed(() =>
    this.batch.groupNearMatches(this.imageReviews())
  );

  /** TIER 3. No apparent match, so skipped automatically and shown read-only. */
  readonly notImported = computed(() =>
    this.imageReviews().filter(r => r.result.tier === 'not-imported')
  );

  /** Tier 3 grouped by photo set (see photo-sets.ts); one action covers a set. */
  readonly notImportedSets = computed(() => groupPhotoSets(this.notImported()));

  /**
   * Tier 3 rows rescued with "Attach anyway". They keep tier 'not-imported'
   * so they stay in place in the read-only list; only their decision changes.
   */
  readonly rescuedFromSkipped = computed(() =>
    this.notImported().filter(willAttach)
  );

  /** Rows still waiting on the user (the unanswered tier-2 rows). */
  readonly outstandingCount = computed(() =>
    this.imageReviews().filter(r => r.decision === 'review').length
  );

  /** Counts for the one-line summary at the top of the review screen. */
  readonly tierSummary = computed(() => {
    const rows = this.imageReviews();
    const notImported = this.notImported();
    // Rescued tier-3 rows count as "will be attached", not "skipped".
    const rescued = notImported.filter(willAttach);
    const stillSkipped = notImported.filter(r => !willAttach(r));
    return {
      total: rows.length,
      /** Tier 1 + accepted tier 2 + rescued tier 3, minus rows held back by the existing-photo answer. Matches the Save button. */
      willAttach: this.readyToAttach().length,
      /**
       * Ticked photos the existing-photo answer is holding back — i.e. what
       * "Leave them alone" is leaving alone. Zero in every other mode.
       */
      heldBack: this.heldBackByMode(),
      /** Tier 2 rows still unanswered. */
      needsAttention: this.outstandingCount(),
      /** Tier 2 rows in total, answered or not. */
      nearTotal: this.nearMatches().length,
      /** Tier 3 rows that really will be left out. */
      skipped: stillSkipped.length,
      /** Tier 3 rows pulled back in by hand. Already inside `willAttach`. */
      rescued: rescued.length,
      /** Tier 3 in total, rescued or not -- the length of the read-only list. */
      notImportedTotal: notImported.length,
      /** Of the ones still skipped, how many are group shots / non-coins. */
      skippedNotACoin: stillSkipped.filter(r => r.result.parsed.isNonCoin).length,
      /** ...and how many are real single-coin photos that missed the bar. */
      skippedNoMatch: stillSkipped.filter(r => !r.result.parsed.isNonCoin).length
    };
  });

  /** The review screen's main content: one entry per matched coin. */
  readonly coinGroups = computed(() =>
    this.batch.groupByCoin(this.imageReviews(), id => this.coins.nameById(id))
  );

  /**
   * Rows ticked for import, before the existing-photo answer is applied. The
   * existing-photo counts are built from this set so choosing "Leave them
   * alone" doesn't change the numbers in the question itself.
   */
  private readonly ticketedRows = computed(() => this.imageReviews().filter(willAttach));

  /**
   * Rows that will actually be written on confirm: ticked and permitted by the
   * existing-photo answer. This is what the Save button counts.
   */
  readonly readyToAttach = computed(() =>
    rowsWrittenUnderMode(this.imageReviews(), this.inv.inventory(), this.existingPhotoMode())
  );

  readonly attachCount = computed(() => this.readyToAttach().length);

  /**
   * Counts for the existing-photo question: coins touched, with and without
   * photos, and how many photos they hold. Live and exact.
   */
  readonly existingPhotoCounts = computed(() =>
    countExistingPhotos(this.ticketedRows(), this.inv.inventory())
  );

  /** Show the existing-photo question only when a matched coin has photos. */
  readonly existingPhotoChoiceVisible = computed(() =>
    this.existingPhotoCounts().coinsWithPhotos > 0
  );

  /**
   * Ticked photos the current existing-photo answer will not write, shown so
   * the gap between the ticked count and the Save count is explained.
   */
  readonly heldBackByMode = computed(() =>
    this.ticketedRows().length - this.readyToAttach().length
  );

  /** True while a long stage is running, so buttons can be disabled. */
  readonly busy = computed(() => isBusy(this.progress()));

  /**
   * Progress text and bar width as computeds, not template method calls, which
   * would re-run on every change-detection pass (one per file during import).
   */
  readonly progressLabel = computed(() => progressLabel(this.progress()));
  readonly progressDetail = computed(() => progressDetail(this.progress()));
  readonly progressPercent = computed(() => progressPercent(this.progress()));
  readonly progressIndeterminate = computed(() => isIndeterminate(this.progress()));

  /**
   * The Save button's text, with a live count while saving. The button needs
   * its own indicator because the progress bar may be scrolled out of view.
   */
  readonly saveButtonLabel = computed(() =>
    saveButtonLabel(this.progress(), this.attachCount())
  );

  /** Thumbnail URLs, passed straight down to the child components. */
  readonly thumbnailUrls = computed(() => this.thumbnails.urls());

  /* --- 1 + 2. File selection, filtering and filename matching --- */

  /*
   * Each stage follows: set progress, `await yieldToBrowser()`, then do the
   * slow work. The yield is required: setting a signal only schedules a
   * render, so without it the indicator never paints and the screen looks
   * frozen. See import-progress.ts.
   */

  async handleDirectorySelection(event: Event): Promise<void> {
    // Ignore a second folder pick while one is still being processed.
    if (this.busy()) return;

    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';

    // Show progress before filtering, which is itself slow for thousands of files.
    this.progress.set(scanningProgress(files.length));
    await yieldToBrowser();

    // Filter first, so everything downstream can assume a drawable image.
    const filtered = filterImageFiles(files);
    if (filtered.accepted.length === 0) {
      // Still show the report ("0 of 43 files were usable").
      this.progress.set(null);
      this.filterResult.set(filtered.totalSelected > 0 ? filtered : null);
      return;
    }

    this.reset();
    this.filterResult.set(filtered);
    this.thumbnails.register(filtered.accepted);

    // `reset()` cleared progress; restore it with no await in between to avoid
    // a blink. Matching is chunked so progress can repaint.
    this.setMatchProgress(0, filtered.accepted.length);
    await yieldToBrowser();
    const rows = await this.batch.buildRows(
      filtered.accepted,
      this.inv.inventory(),
      (done, total) => this.setMatchProgress(done, total),
      // Denominations lookup, so coins match on their linked denomination.
      // `buildRows` snapshots it once; an empty list means text-only matching.
      this.inv.denominations()
    );

    // Setting the rows triggers every computed and builds the review DOM, the
    // longest wait in the flow. Keep the indicator up across it: set, yield,
    // set rows, yield, then clear.
    this.progress.set(buildingProgress(rows.length));
    await yieldToBrowser();
    this.imageReviews.set(rows);
    await yieldToBrowser();
    this.progress.set(null);
  }

  private setMatchProgress(processed: number, total: number): void {
    this.progress.set(matchingProgress(processed, total));
  }

  /* --- 3. Review: tick boxes, bulk rules, per-file decisions --- */

  /** Flip one photo's tick box. */
  toggleImage(fileName: string): void {
    this.imageReviews.update(rows => toggleRow(rows, fileName));
  }

  /** Run a bulk rule over one coin's photos, or over the whole batch. */
  runBulkAction(action: SelectionBulkAction, coinId?: string): void {
    this.imageReviews.update(rows => applyBulkAction(rows, action, coinId));
  }

  /**
   * Show or hide one coin's thumbnails. Object URLs (and image decodes) only
   * exist for groups the user has opened.
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

  /* --- Tier 2 answers: accept, choose another near candidate, or skip --- */

  /**
   * "Yes, that is the coin." Waiting members of the same photo set follow
   * (see `followPhotoSet`).
   */
  acceptNearMatch(fileName: string): void {
    this.imageReviews.update(rows => this.followSet(decisions.acceptNearMatch(rows, fileName), fileName));
  }

  /** "No, it is this other one" — the dropdown. The set follows here too. */
  chooseNearCandidate(fileName: string, coinId: string): void {
    this.imageReviews.update(rows =>
      this.followSet(decisions.chooseNearCandidate(rows, fileName, coinId), fileName)
    );
  }

  /** Carry `fileName`'s coin to the untouched members of its photo set. */
  private followSet(rows: BatchImageRow[], fileName: string): BatchImageRow[] {
    const coinId = rows.find(r => r.fileName === fileName)?.selectedCoinId;
    if (!coinId) return rows;
    return decisions.followPhotoSet(rows, fileName, this.coins.nameById(coinId));
  }

  /**
   * "Yes" for every unanswered photo in one coin's group. Touches only rows
   * still waiting, so it never overrides an earlier choice.
   */
  acceptNearMatchGroup(coinId: string): void {
    const pending = this.nearMatchGroups()
      .find(group => group.coinId === coinId)
      ?.rows.filter(row => row.decision === 'review') ?? [];

    for (const row of pending) this.acceptNearMatch(row.fileName);
  }

  /** "Skip" for every unanswered photo in one coin's group. */
  skipNearMatchGroup(coinId: string): void {
    const pending = this.nearMatchGroups()
      .find(group => group.coinId === coinId)
      ?.rows.filter(row => row.decision === 'review') ?? [];

    for (const row of pending) this.skipImage(row.fileName);
  }

  /**
   * Show or hide one near-match group's thumbnails. Opt-in because each URL
   * decodes a large JPEG; tier 2 should usually be answerable from the chips.
   */
  toggleNearMatchPhotos(coinId: string): void {
    const open = new Set(this.nearPhotoGroups());
    if (open.has(coinId)) {
      open.delete(coinId);
    } else {
      open.add(coinId);
      const group = this.nearMatchGroups().find(g => g.coinId === coinId);
      this.thumbnails.create((group?.rows ?? []).map(row => row.fileName));
    }
    this.nearPhotoGroups.set(open);
  }

  areNearMatchPhotosShown(coinId: string): boolean {
    return this.nearPhotoGroups().has(coinId);
  }

  reassignImageMatch(fileName: string, coinId: string): void {
    const label = this.coins.nameById(coinId);
    this.imageReviews.update(rows => decisions.assignCoin(rows, fileName, coinId, label));
    this.coins.setTerm(fileName, '');
  }

  /*
   * Tier 3 "Attach anyway". Strictly opt-in: nothing expands or asks until the
   * user opens a row, so tier 3 stays a read-only report. It lets the user
   * attach a photo the matcher couldn't place, without lowering the near-match
   * bar (see row-decisions.ts).
   */

  /**
   * Whether "Attach anyway" is offered on this row. False for photos excluded
   * from automated import (multi-coin shots); those stay listed
   * and can still be attached manually from the coin's gallery.
   */
  canRescue(fileName: string): boolean {
    const row = this.imageReviews().find(r => r.fileName === fileName);
    return !!row && row.result.parsed.excludedFromAutoImport !== true;
  }

  /** Open the "Attach anyway" panel on one tier-3 row. */
  openRescue(fileName: string): void {
    // The template also hides the link for these rows.
    if (!this.canRescue(fileName)) return;
    const open = new Set(this.rescueOpen());
    open.add(fileName);
    this.rescueOpen.set(open);
  }

  /** Close it again without deciding anything. */
  closeRescue(fileName: string): void {
    const open = new Set(this.rescueOpen());
    open.delete(fileName);
    this.rescueOpen.set(open);
    // Drop the half-typed search with it, so re-opening starts clean.
    this.coins.setTerm(fileName, '');
  }

  isRescueOpen(fileName: string): boolean {
    return this.rescueOpen().has(fileName);
  }

  /** Rescue using one of the matcher's ranked candidates. */
  rescueWithCandidate(fileName: string, coinId: string): void {
    // Checked once for the whole set so a multi-coin row can't be rescued via a sibling.
    if (!this.canRescue(fileName)) return;
    const row = this.imageReviews().find(r => r.fileName === fileName);
    if (!row?.result.candidates.some(c => c.coinId === coinId)) return;
    const label = this.coins.nameById(coinId);
    this.imageReviews.update(rows => decisions.rescueSet(rows, this.setMembers(fileName), coinId, label));
    this.closeRescue(fileName);
  }

  /** Rescue using free-text search (`CoinLookup`), for rows with no candidates. */
  rescueWithSearch(fileName: string, coinId: string): void {
    if (!this.canRescue(fileName)) return;
    const label = this.coins.nameById(coinId);
    this.imageReviews.update(rows => decisions.rescueSet(rows, this.setMembers(fileName), coinId, label));
    this.closeRescue(fileName);
  }

  /** Undo for a whole tier-3 set: every member goes back to skipped. */
  resetPhotoSet(fileName: string): void {
    const members = this.setMembers(fileName);
    this.imageReviews.update(rows => members.reduce((next, f) => decisions.resetRow(next, f), rows));
  }

  /** Every tier-3 file in the same photo set as `fileName` (itself included). */
  private setMembers(fileName: string): string[] {
    const set = this.notImportedSets().find(s => s.rows.some(r => r.fileName === fileName));
    return set ? set.rows.map(r => r.fileName) : [fileName];
  }

  skipImage(fileName: string): void {
    this.imageReviews.update(rows => decisions.skipRow(rows, fileName));
  }

  /**
   * Tier 1's Skip: marks all the coin's photos skipped, which removes the group
   * from `coinGroups()`. Unlike the "None" bulk button, which only unticks.
   */
  skipCoinGroup(coinId: string): void {
    const fileNames = this.imageReviews()
      .filter(row => row.selectedCoinId === coinId && row.decision !== 'skipped')
      .map(row => row.fileName);

    for (const fileName of fileNames) this.skipImage(fileName);
  }

  resetDecision(fileName: string): void {
    this.imageReviews.update(rows => decisions.resetRow(rows, fileName));
  }

  thumbnailFor(fileName: string): string {
    return this.thumbnails.urls()[fileName] ?? '';
  }

  /* --- 4. Confirm: the only place files are read and the database is written --- */

  async applyConfirmedMatches(): Promise<void> {
    /* Set progress synchronously on the click's tick so `busy()` disables Save
     * at once; otherwise a second click during the first slow file read would
     * import everything twice. Keep this above any `await`. */
    if (this.busy()) return;
    this.progress.set(startingAttachProgress(this.attachCount()));

    /* The base-folder guard refuses an import that would record paths that
     * don't exist (see base-folder-check.ts). Skipped without an ApiService. */
    this.blockedReason.set(null);

    // Re-read the storage mode: Settings may have changed since construction.
    const storageSettings = await loadImageStorageSettings(this.storage);
    this.storageSettings.set(storageSettings);

    // Referenced mode stores only a path, which needs a base folder. Refuse the
    // whole run up front rather than failing every file.
    if (storageSettings.mode === 'referenced' && !this.folder.value().trim()) {
      this.progress.set(null);
      this.blockedReason.set(NO_BASE_FOLDER_MESSAGE);
      return;
    }

    if (this.api) {
      const api = this.api;
      const verdict = await verifyBaseFolder(
        this.folder.value(),
        this.filterResult()?.accepted ?? [],
        paths => firstValueFrom(api.checkImagesExist(paths)).then(response => response.results)
      );

      if (!verdict.ok) {
        this.progress.set(null);
        this.blockedReason.set(verdictMessage(verdict));
        return;
      }
    }

    /* Confirm before 'replace' deletes existing photos (the originals may no
     * longer exist). Asked only after the base-folder checks, so the user is
     * never asked about an import that will be refused, and only when some
     * photos would actually be deleted. Declining writes nothing at all. */
    const mode = this.existingPhotoMode();
    const counts = this.existingPhotoCounts();
    if (mode === 'replace' && counts.coinsWithPhotos > 0) {
      if (!confirmAction(replaceConfirmationMessage(counts))) {
        this.progress.set(null);
        return;
      }
    }

    const result = await this.batch.attachSelected(this.imageReviews(), {
      files: this.thumbnails.files,
      inventory: this.inv.inventory(),
      // Front half of every absolute path; see source-path.ts.
      baseFolder: this.folder.value(),
      // Existing-photo handling and already-recorded originals; see attach-runner.ts.
      existingPhotoMode: mode,
      existingSourcePaths: await this.fetchExistingSourcePaths(mode),
      /* What a coin already has, under 'add'. Don't read `coin.imagePaths`
       * from the inventory: the list endpoint no longer inlines photos. 'add'
       * sends the complete array and the server replaces the set, so a short
       * array would delete photos. If loading fails the runner skips the coin. */
      loadExistingImages: (coinId) => this.inv.loadCoinImages(coinId),
      attach: (coinId, imagePaths, newImages) => {
        // Record each new original's source path before the write; CoinEditor
        // reads this registry to build the `{ imageData, sourcePath }` payload.
        imageSourcePaths.recordAll(newImages);
        this.inv.updateCoin(coinId, { imagePaths });
      },
      onProgress: progress => this.progress.set(progress),
      /* What one photo turns into:
       *   referenced : no file is read; the database gets the path only.
       *   stored     : the file is read and downscaled to the size budget.
       * `this.encoder` (the specs' stub) wins over both. The URL builder is
       * the API's so the reference is absolute (the dev server and API are on
       * different ports). */
      encode:
        this.encoder ??
        (storageSettings.mode === 'referenced'
          ? makeReferencedEncoder(this.folder.value(), path =>
              this.api ? this.api.imageFileUrl(path) : referenceUrlForPath(path)
            )
          : undefined),
      maxStoredImageBytes: storageSettings.maxStoredImageBytes
    });

    this.summary.set(result);
    this.progress.set(null);
  }

  /**
   * Which original files are already attached to the coins this import would
   * append to. `imagePaths` holds only data URLs, so SourcePath must come from
   * the server; without it "Keep both" would re-attach every file.
   *
   * Skipped (returns undefined) unless mode is 'add', there are coins with
   * photos, and an ApiService exists. Fails open on error: undefined means
   * "nothing known to be attached", so everything is imported rather than
   * silently dropped.
   */
  private async fetchExistingSourcePaths(
    mode: ExistingPhotoMode
  ): Promise<ExistingSourcePaths | undefined> {
    if (mode !== 'add' || !this.api) return undefined;

    const coinIds = coinIdsWithExistingPhotos(this.imageReviews(), this.inv.inventory());
    if (coinIds.length === 0) return undefined;

    const api = this.api;
    const merged: Record<string, string[]> = {};

    try {
      // Batched: the endpoint answers at most 500 coins per request.
      for (const chunk of chunkCoinIds(coinIds)) {
        const response = await firstValueFrom(api.getCoinImageSourcePaths(chunk));
        Object.assign(merged, response.results ?? {});
      }
    } catch {
      // Fail open: see above.
      return undefined;
    }

    return merged;
  }

  /** Drop every trace of the run, revoking the blob URLs on the way out. */
  reset(): void {
    this.thumbnails.clear();
    this.coins.clear();
    this.imageReviews.set([]);
    this.expandedCoins.set(new Set());
    this.nearPhotoGroups.set(new Set());
    this.rescueOpen.set(new Set());
    this.filterResult.set(null);
    this.progress.set(null);
    this.summary.set(null);
    // Back to the safe default so "Replace" never carries into the next folder.
    this.existingPhotoMode.set(DEFAULT_EXISTING_PHOTO_MODE);
    this.blockedReason.set(null);
  }
}
