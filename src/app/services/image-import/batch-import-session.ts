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
import { EncodedImage, yieldToBrowser } from './attach-runner';
import {
  buildingProgress,
  isBusy,
  isIndeterminate,
  matchingProgress,
  progressDetail,
  progressLabel,
  progressPercent,
  scanningProgress,
  startingAttachProgress
} from './import-progress';
import { StorageService } from '../storage.service';
import { imageSourcePaths } from '../image-source-paths';
import { BaseFolderState } from './base-folder-state';
import { verifyBaseFolder, verdictMessage } from './base-folder-check';
import {
  BatchImageRow,
  BatchImportProgress,
  BatchImportSummary,
  ImageFileFilterResult,
  RankedImageMatch,
  SelectionBulkAction
} from '../../types/coin.model';

/**
 * "This row will be written when Save is pressed."
 *
 * Exactly the filter `attach-runner.runAttach` applies, stated once here so
 * the counters on the screen and the run itself can never disagree. Note it
 * keys off the DECISION and not off the tier: that is what lets a rescued
 * tier-3 row travel the identical attach path as an accepted tier-2 row,
 * without the runner needing to know tiers exist at all.
 */
const willAttach = (row: BatchImageRow): boolean =>
  row.selected && !!row.selectedCoinId && row.decision !== 'skipped';

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

  /**
   * Why the last import attempt was refused, or null if it was not.
   *
   * There was no error surface on this session at all before — the import
   * either worked or failed silently, which is precisely how 1,700 rows came
   * to be stamped with paths that resolved to nothing. The one thing that can
   * set this today is the base-folder guard in `applyConfirmedMatches`.
   *
   * Cleared at the START of every attempt rather than when the user dismisses
   * it, so a stale message can never make a successful import look failed.
   */
  readonly blockedReason = signal<string | null>(null);

  /** Coin ids whose thumbnails are currently rendered (tier 1). */
  readonly expandedCoins = signal<Set<string>>(new Set());

  /** Near-match group ids whose thumbnails are currently rendered (tier 2). */
  readonly nearPhotoGroups = signal<Set<string>>(new Set());

  /**
   * TIER 3's escape hatch, and the reason it costs the user nothing: the
   * filenames whose "Attach anyway" panel has been OPENED.
   *
   * Empty by default and empty forever unless the user clicks. That emptiness
   * IS the design -- tier 3 has to stay a read-only report you can scroll past
   * without answering anything, so the candidate list and the search box do
   * not exist in the DOM, do not prompt and do not ask until the row is opened
   * by hand. See row-decisions.ts for why the hatch exists at all, given the
   * near-match bar stays exactly where it is.
   */
  readonly rescueOpen = signal<Set<string>>(new Set());

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
   * On a fresh install there is nothing remembered and the box starts EMPTY.
   * It used to be seeded with the app's own install directory from
   * `GET /api/app-info`; that was removed because it is never the right answer
   * and, looking like a real path, was worse than blank. See the header of
   * import-base-folder.ts.
   *
   * Set up in the constructor because it needs the StorageService and a signal
   * for the first selected file.
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
     *
     * It is now used for a SECOND thing: checking, before anything is written,
     * that the paths this import would record actually resolve on disk. See
     * `applyConfirmedMatches` and base-folder-check.ts. Still optional, and
     * still degrading to "just do the import" when absent — the check is a
     * safety net, never a dependency.
     */
    private readonly api?: ApiService
  ) {
    this.coins = new CoinLookup(inv, matching);
    this.folder = new BaseFolderState(
      // The live example is built from the first file of the current selection.
      computed(() => this.filterResult()?.accepted?.[0]),
      storage
    );
    // Fire-and-forget: the box starts empty and is filled in a moment later
    // with the saved folder, if there is one. Nothing can be imported in that
    // window, so there is no race to worry about — and if the restore fails
    // outright, an empty box is a state the screen already handles with a
    // visible warning.
    void this.folder.restore();
  }

  /* ---------------------------------------------------------------------
   * Derived views
   * ------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------
   * THE THREE REVIEW TIERS
   * ---------------------------------------------------------------------
   * These come straight off `result.tier`, which is decided once by
   * image-matching/near-match.ts. The screen does no classifying of its own —
   * which is what makes the rule testable without a browser, and what stops
   * a presentation tweak from changing what gets attached.
   *
   *   TIER 1 matchedImages  attached automatically; the user may untick/skip.
   *   TIER 2 nearMatches    one yes/no each (and often one per COIN, see
   *                         nearMatchGroups).
   *   TIER 3 notImported    skipped automatically, listed read-only.
   * ------------------------------------------------------------------- */

  /** TIER 1. Matcher cleared all three auto gates. */
  readonly matchedImages = computed(() =>
    this.imageReviews().filter(r => r.result.tier === 'matched')
  );

  /**
   * TIER 1, by `status` rather than by tier.
   *
   * Identical to `matchedImages` today — tier 'matched' is defined as status
   * 'auto' — and kept as a separate name so a test can assert the two really
   * do agree, i.e. that the tier layer has not started attaching things.
   */
  readonly autoMatches = computed(() =>
    this.imageReviews().filter(r => r.result.status === 'auto')
  );

  /** TIER 2. Same coin on all four attributes, something else off. */
  readonly nearMatches = computed(() =>
    this.imageReviews().filter(r => r.result.tier === 'near')
  );

  /**
   * TIER 2, grouped by the coin being suggested, which is the unit the screen
   * actually asks about — five photos of one coin is one question.
   */
  readonly nearMatchGroups = computed(() =>
    this.batch.groupNearMatches(this.imageReviews())
  );

  /** TIER 3. No apparent match, so skipped automatically and shown read-only. */
  readonly notImported = computed(() =>
    this.imageReviews().filter(r => r.result.tier === 'not-imported')
  );

  /**
   * TIER 3 rows the user has rescued with "Attach anyway".
   *
   * They keep `tier === 'not-imported'` on purpose -- the matcher's
   * classification is not the user's to rewrite, and keeping it means the row
   * stays exactly where it was in the read-only list, so that list's
   * 25-at-a-time paging is unaffected by a rescue. What changes is the
   * DECISION on the row, which is the only thing the attach run looks at.
   */
  readonly rescuedFromSkipped = computed(() =>
    this.notImported().filter(willAttach)
  );

  /**
   * Rows still waiting on the user. With the tiers in place this is exactly
   * the unanswered tier-2 rows: tier 1 is decided and tier 3 is skipped.
   * It is THE number the screen leads with.
   */
  readonly outstandingCount = computed(() =>
    this.imageReviews().filter(r => r.decision === 'review').length
  );

  /**
   * The one-line answer to "how much work is this?", shown at the top of the
   * screen before anything else.
   *
   * With 2,140 files, "47 need your attention, 1,890 attached, 203 skipped"
   * is the single most valuable thing on the page: it tells the user the SHAPE
   * of the job before they scroll into it.
   */
  readonly tierSummary = computed(() => {
    const rows = this.imageReviews();
    const notImported = this.notImported();
    /* A tier-3 row the user rescued with "Attach anyway" is still tier 3 by
     * CLASSIFICATION, but it is no longer skipped by OUTCOME -- so it has to
     * be counted in "will be attached" and taken out of "skipped", or the
     * sentence at the top of the screen would go on reporting a photo as
     * thrown away while the Save button is about to write it. */
    const rescued = notImported.filter(willAttach);
    const stillSkipped = notImported.filter(r => !willAttach(r));
    return {
      total: rows.length,
      /** Tier 1, plus tier-2 rows accepted, plus tier-3 rows rescued. */
      willAttach: rows.filter(willAttach).length,
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

  /** Rows that will actually be written on confirm. */
  readonly readyToAttach = computed(() => this.imageReviews().filter(willAttach));

  readonly attachCount = computed(() => this.readyToAttach().length);

  /**
   * True while a long stage is running, so the buttons can be disabled.
   *
   * The rule itself lives in import-progress.ts, next to the factories that
   * produce the phases, so "a new stage" and "a stage the buttons know about"
   * cannot drift apart — they drifted apart once already, which is how the
   * Save button stayed live through the first file of an import.
   */
  readonly busy = computed(() => isBusy(this.progress()));

  /**
   * The line of text and the bar width, as computeds rather than template
   * method calls.
   *
   * Same reason `nearChips` is a computed: a `{{ progressLabel(...) }}` in the
   * template re-runs on every change-detection pass, and during an import
   * there is a change-detection pass after every single file.
   */
  readonly progressLabel = computed(() => progressLabel(this.progress()));
  readonly progressDetail = computed(() => progressDetail(this.progress()));
  readonly progressPercent = computed(() => progressPercent(this.progress()));
  readonly progressIndeterminate = computed(() => isIndeterminate(this.progress()));

  /** Thumbnail URLs, passed straight down to the child components. */
  readonly thumbnailUrls = computed(() => this.thumbnails.urls());

  /* ---------------------------------------------------------------------
   * 1 + 2. File selection, filtering and filename matching
   * ------------------------------------------------------------------- */

  /* ---------------------------------------------------------------------
   * THE SHAPE OF THE TWO LONG METHODS BELOW, AND WHY EVERY `yieldToBrowser`
   * IN THEM IS LOAD-BEARING
   * ---------------------------------------------------------------------
   * Both of them follow the same three-beat pattern for each stage:
   *
   *     this.progress.set(<stage>Progress(...));   // say what is happening
   *     await yieldToBrowser();                    // let the browser DRAW it
   *     <the slow thing>;                          // only now do the work
   *
   * The middle line is the one that is easy to delete and fatal to delete.
   * JavaScript is single threaded: writing a signal schedules a render, it
   * does not perform one, and nothing reaches the screen until the current
   * task hands the event loop back. The previous version of this code set the
   * matching progress and then ran the first 200-filename chunk in the same
   * task — ~1.1 s against a 2,000-coin inventory — so the bar the user was
   * supposed to be watching did not exist yet. That is the "screen was
   * basically frozen with no indication that anything was going on" report:
   * the indicator was written, just never painted.
   *
   * See import-progress.ts for the stages themselves.
   * ------------------------------------------------------------------- */

  async handleDirectorySelection(event: Event): Promise<void> {
    // The impatient-click guard. A folder select is seconds long, so the user
    // WILL click the picker again; without this the second run interleaves
    // with the first and the review list ends up a mixture of both.
    if (this.busy()) return;

    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';

    // Up BEFORE the filter, not after it: classifying 2,140 File handles is
    // the first thing that keeps the main thread, and it used to happen with
    // a blank screen.
    this.progress.set(scanningProgress(files.length));
    await yieldToBrowser();

    // FILTER FIRST. Everything downstream can then assume "this is an image
    // the browser can draw", and the user gets an honest skipped-file report.
    const filtered = filterImageFiles(files);
    if (filtered.accepted.length === 0) {
      // Still surface the report - "0 of 43 files were usable" is information.
      this.progress.set(null);
      this.filterResult.set(filtered.totalSelected > 0 ? filtered : null);
      return;
    }

    this.reset();
    this.filterResult.set(filtered);
    this.thumbnails.register(filtered.accepted);

    // `reset()` just cleared `progress`, so put the indicator straight back up
    // with no `await` in between — otherwise the screen blinks empty here.
    // Matching is chunked so the progress line can repaint between chunks.
    this.setMatchProgress(0, filtered.accepted.length);
    await yieldToBrowser();
    const rows = await this.batch.buildRows(
      filtered.accepted,
      this.inv.inventory(),
      (done, total) => this.setMatchProgress(done, total)
    );

    /* -------------------------------------------------------------------
     * THE LONGEST WAIT IN THE WHOLE FLOW, AND IT USED TO BE THE ONLY ONE
     * WITH THE INDICATOR ALREADY SWITCHED OFF.
     * -------------------------------------------------------------------
     * `imageReviews.set(rows)` invalidates every computed on this class —
     * coinGroups, nearMatchGroups, notImported, the chip maps in the modal —
     * and then Angular creates the review screen's DOM from the result. For
     * the full share that is thousands of rows' worth of work, none of it
     * ours and none of it interruptible.
     *
     * The old code did `imageReviews.set(rows)` and `progress.set(null)` in
     * one unbroken task, which means the indicator came down at the exact
     * moment it was most needed. Now it stays up, we yield so Angular can do
     * the render while it is showing, and only the task AFTER that takes it
     * down.
     * ----------------------------------------------------------------- */
    this.progress.set(buildingProgress(rows.length));
    await yieldToBrowser();
    this.imageReviews.set(rows);
    await yieldToBrowser();
    this.progress.set(null);
  }

  private setMatchProgress(processed: number, total: number): void {
    this.progress.set(matchingProgress(processed, total));
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

  /* ---------------------------------------------------------------------
   * TIER 2 ANSWERS
   * ---------------------------------------------------------------------
   * Three of them, and nothing else — that is the whole point. The owner's
   * instruction was "one action, not a form": accept the suggestion, pick a
   * different one from the dropdown of other near candidates, or skip.
   * ------------------------------------------------------------------- */

  /** "Yes, that is the coin." */
  acceptNearMatch(fileName: string): void {
    this.imageReviews.update(rows => decisions.acceptNearMatch(rows, fileName));
  }

  /** "No, it is this other one" — the dropdown of other near candidates. */
  chooseNearCandidate(fileName: string, coinId: string): void {
    this.imageReviews.update(rows => decisions.chooseNearCandidate(rows, fileName, coinId));
  }

  /**
   * "Yes" for every unanswered photo in one coin's group.
   *
   * This is the control that makes a five-shot coin cost one click instead of
   * five. It touches only rows that are still waiting, so pressing it twice is
   * harmless and it never overrides a choice the user already made.
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
   * Show or hide one near-match group's thumbnails.
   *
   * Opt-in for the same reason the matched coin groups are: an object URL is
   * a real decode of a real multi-megabyte JPEG off the share. Tier 2 should
   * be answerable from the filename and the parsed attributes alone — that is
   * what the chips are for — so the photos are there when a question is
   * genuinely close, not by default.
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

  /* ---------------------------------------------------------------------
   * TIER 3's ESCAPE HATCH -- "Attach anyway"
   * ---------------------------------------------------------------------
   * Tier 3 is a read-only report and it must stay one: a 2,140-file run
   * cannot afford a list that demands attention. So this is strictly OPT-IN.
   * Nothing below runs, nothing expands and nothing is asked until the user
   * clicks "Attach anyway" on a specific row, and a row he never touches stays
   * skipped and contributes nothing whatsoever to the attach run.
   *
   * What it is FOR: the near-match bar is strict by instruction and stays
   * strict, but strictness with no exit means a photo the matcher itself
   * scores at 97% can be unattachable merely because its filename omits a
   * grade. The hatch is the exit. It never lowers the bar -- see the long note
   * at the top of row-decisions.ts.
   * ------------------------------------------------------------------- */

  /**
   * Is the "Attach anyway" hatch offered on this row at all?
   *
   * False for exactly one group: the photographs the owner ruled out of the
   * automated import entirely -- counterfeits and multi-coin shots.
   *
   *   "Ignore the Fake coins."
   *   "Never automatically attach nor offer as attachable in the automated
   *    import. A user can try to manually choose such a photo manually at a
   *    later time to attach to a coin(s)."
   *
   * The hatch IS the "offer as attachable", so these rows do not get one. The
   * row itself stays in the list with its reason -- it is the OFFER that is
   * withdrawn, never the file -- and the "later time" he is describing is the
   * per-coin image gallery, which has no idea this method exists.
   */
  canRescue(fileName: string): boolean {
    const row = this.imageReviews().find(r => r.fileName === fileName);
    return !!row && row.result.parsed.excludedFromAutoImport !== true;
  }

  /** Open the "Attach anyway" panel on one tier-3 row. */
  openRescue(fileName: string): void {
    // Belt and braces with the template, which does not render the link for
    // these rows in the first place.
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

  /**
   * SOURCE 1: one of the ranked candidates the matcher already produced.
   *
   * This is the 97% Morgan case -- the right coin is at the top of a list
   * tier 3 simply never showed anybody.
   */
  rescueWithCandidate(fileName: string, coinId: string): void {
    this.imageReviews.update(rows => decisions.rescueWithCandidate(rows, fileName, coinId));
    this.closeRescue(fileName);
  }

  /**
   * SOURCE 2: free-text search, for the rows with no candidates at all.
   *
   * The search is `CoinLookup` -- the same per-row search box (`setTerm` /
   * `results`) that has been unit-tested here all along and was orphaned when
   * the old image-match-resolver component was deleted in the tier rework.
   * Reused rather than rewritten: one search implementation means one set of
   * rules about what matches, and one place to fix them.
   */
  rescueWithSearch(fileName: string, coinId: string): void {
    const label = this.coins.nameById(coinId);
    this.imageReviews.update(rows => decisions.rescueWithCoin(rows, fileName, coinId, label));
    this.closeRescue(fileName);
  }

  skipImage(fileName: string): void {
    this.imageReviews.update(rows => decisions.skipRow(rows, fileName));
  }

  /**
   * TIER 1's Skip: "I am done with this coin, take it off my screen."
   *
   * Marks every one of the coin's photos skipped, which drops the whole group
   * out of `coinGroups()` (grouping ignores skipped rows). Deliberately not
   * the same as the "None" bulk button, which only unticks and leaves the
   * group sitting there reading "0 of 8 selected".
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

  /* ---------------------------------------------------------------------
   * 4. Confirm - the only place files are read and the database is written
   * ------------------------------------------------------------------- */

  async applyConfirmedMatches(): Promise<void> {
    /* -------------------------------------------------------------------
     * BOTH LINES BELOW RUN SYNCHRONOUSLY, ON THE SAME TICK AS THE CLICK.
     * -------------------------------------------------------------------
     * That is the whole point of them. `busy()` is derived from `progress`,
     * and nothing used to set `progress` until the first file had been read
     * off the share and downscaled — seconds, for a 46 MB JPEG over SMB. For
     * the whole of that window the Save button was still enabled and the
     * screen still said nothing, so a user who clicked again (and they did,
     * because the screen looked dead) ran the entire import twice and got
     * every photo written twice.
     *
     * The guard is the belt to that braces: even if some future caller
     * reaches this method without going through a disabled button, a second
     * run cannot start while one is in flight.
     * ----------------------------------------------------------------- */
    if (this.busy()) return;
    this.progress.set(startingAttachProgress(this.attachCount()));

    /* -------------------------------------------------------------------
     * THE BASE-FOLDER GUARD — refuse an import that would record dead paths.
     * -------------------------------------------------------------------
     * The owner once imported a folder and every row came back pointing into
     * his DEVELOPMENT folder, because the base-folder box was still holding
     * its fallback (the app's own install directory) while the picker
     * supplied only the relative half. The screen's live preview showed the
     * wrong path the whole time and changed nothing, because it is advisory.
     * base-folder-check.ts has the full story.
     *
     * Note the ORDER. `progress` is set above, synchronously, on the click's
     * own tick — that is the double-import fix and it must not be moved below
     * an `await`. Running the check after it means `busy()` is already true
     * while we wait, so a second click still cannot start a second run; and
     * when the check refuses, `progress` is cleared again here.
     *
     * With no ApiService there is nothing to ask, so the import proceeds
     * exactly as it always did.
     * ----------------------------------------------------------------- */
    this.blockedReason.set(null);
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
    this.nearPhotoGroups.set(new Set());
    this.rescueOpen.set(new Set());
    this.filterResult.set(null);
    this.progress.set(null);
    this.summary.set(null);
    // Otherwise a refusal from the previous selection would still be on screen
    // after the user picks a different folder to start over with — which is
    // exactly what they would do in response to reading it.
    this.blockedReason.set(null);
  }
}
