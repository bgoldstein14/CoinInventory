import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImageMatchingService } from '../../services/image-matching.service';
import { InventoryService } from '../../services/inventory.service';
import { BatchImageImportService } from '../../services/batch-image-import.service';
import { StorageService } from '../../services/storage.service';
import { ApiService } from '../../services/api.service';
import { BatchImportSession } from '../../services/image-import/batch-import-session';
import { CoinImageGroupRow } from '../coin-image-group/coin-image-group';
import { NearMatchReview } from '../near-match-review/near-match-review';

/**
 * ImageImportModal — the batch image import screen: point at a folder, see how
 * much work there actually is, answer the handful of questions that need
 * answering, and save.
 *
 * WHY THIS FILE IS SO SHORT
 * All of the state and behaviour lives in BatchImportSession (see
 * services/image-import/batch-import-session.ts), which documents the
 * four-step flow: filter the files, match on file NAMES only, review, then
 * read + downscale + save just the ticked photos. This component is the shell
 * that owns one session and renders it.
 *
 * ---------------------------------------------------------------------------
 * THE THREE TIERS, WHICH ARE THE SHAPE OF THIS SCREEN
 * ---------------------------------------------------------------------------
 * The photo library is ~2,140 files, so anything that needs a decision PER
 * FILE is unusable. The review is therefore split by what question can be
 * asked, not by how confident the matcher was:
 *
 *   1. MATCHED        attached automatically, grouped by coin
 *                     (app-coin-image-group). Tick boxes and Skip live here.
 *   2. NEAR MATCH     one yes/no per COIN (app-near-match-review). Same coin
 *                     on year + type + denomination + grade, something else
 *                     off. Accept, pick another near candidate, or skip.
 *   3. NOT IMPORTED   skipped automatically, listed READ-ONLY — there is no
 *                     apparent match, so there is no question worth asking.
 *                     Modelled on the "Not imported" exception panels in the
 *                     QIF and CSV importers: filename, what we read, why it
 *                     was skipped. Nothing is silently dropped.
 *
 *                     Each row carries ONE opt-in control, "Attach anyway",
 *                     and nothing else. It is the deliberate exception to the
 *                     read-only rule: the four-attribute near-match bar is
 *                     strict by instruction and is NOT being relaxed, but a
 *                     photo the matcher scores at 97% must not be a dead end
 *                     just because its filename omits a grade. Opt-in means
 *                     exactly that — until the user clicks it, nothing
 *                     expands, nothing prompts, and the list behaves like the
 *                     report it was before.
 *
 * The rule that decides a tier lives in
 * services/image-matching/near-match.ts, not here. This component only draws
 * what it is told.
 *
 * The session is created per modal instance, so closing and re-opening the
 * dialog always starts from a clean slate.
 */
@Component({
  selector: 'app-image-import-modal',
  imports: [FormsModule, DecimalPipe, CoinImageGroupRow, NearMatchReview],
  templateUrl: './image-import-modal.html',
  styleUrl: './image-import-modal.scss'
})
export class ImageImportModal {
  readonly closed = output<void>();

  /**
   * All the import state. Public to the template, which reads it directly
   * (`session.coinGroups()`, `session.toggleImage(...)`) rather than going
   * through a layer of one-line pass-through methods.
   */
  protected readonly session = new BatchImportSession(
    inject(InventoryService),
    inject(ImageMatchingService),
    inject(BatchImageImportService),
    // `optional` because the unit tests build this component from a bare
    // Injector with no root providers; StorageService only powers remembering
    // the base folder, and the import works fine (just forgetfully) without it.
    inject(StorageService, { optional: true }) ?? undefined,
    // Also optional, and for the same reason. ApiService is used here solely to
    // ask the backend where the app is installed, so the base-folder box starts
    // from a real host path on a first run rather than empty. Without it the box
    // just starts empty, which the screen already handles.
    inject(ApiService, { optional: true }) ?? undefined
  );

  /* ---------------------------------------------------------------------
   * How much of the two long lists to actually render
   * ---------------------------------------------------------------------
   * Selecting the share's root can leave several hundred not-imported files -
   * group shots, stamps, bond coupons, camera-default names - and the tier-2
   * queue can run to a few dozen coins. Putting all of that in the DOM at once
   * is slow to create and slow to update forever after.
   *
   * So both lists are paged: a screenful at a time, with a "show more" button.
   * This is purely a rendering decision, which is why it lives in the
   * component rather than in the session - the data is all there either way.
   * ------------------------------------------------------------------- */

  /** Entries added per "show more" click, and shown initially. */
  private static readonly PAGE_SIZE = 25;

  protected readonly nearLimit = signal(ImageImportModal.PAGE_SIZE);
  protected readonly skippedLimit = signal(ImageImportModal.PAGE_SIZE);

  /** Tier 2, paged. The unit is a COIN, so 25 groups is a lot of photos. */
  protected readonly visibleNearGroups = computed(() =>
    this.session.nearMatchGroups().slice(0, this.nearLimit())
  );

  /** Tier 3, paged. Read-only rows, so this is purely about DOM size. */
  protected readonly visibleNotImported = computed(() =>
    this.session.notImported().slice(0, this.skippedLimit())
  );

  /**
   * "What we read from the filename" for every tier-2 photo, keyed by
   * filename.
   *
   * Built once here rather than called per row from the template: a method
   * call in a template runs on every change-detection pass, and
   * `parsedChips` allocates an array each time.
   */
  protected readonly nearChips = computed(() => {
    const chips: Record<string, string[]> = {};
    for (const row of this.session.nearMatches()) {
      chips[row.fileName] = this.session.coins.chips(row);
    }
    return chips;
  });

  /**
   * Display labels for every coin a tier-2 row could end up on, so an answered
   * row can name its coin without the child component needing the inventory.
   */
  protected readonly nearCoinLabels = computed(() => {
    const labels: Record<string, string> = {};
    for (const row of this.session.nearMatches()) {
      for (const candidate of row.result.nearMatch?.candidates ?? []) {
        labels[candidate.coinId] = candidate.coinLabel;
      }
    }
    return labels;
  });

  /**
   * The same chips for the VISIBLE page of tier-3 rows.
   *
   * Only the visible page, because tier 3 can run to several hundred files and
   * there is no point formatting chips for rows nobody has scrolled to yet.
   */
  protected readonly skippedChips = computed(() => {
    const chips: Record<string, string[]> = {};
    for (const row of this.visibleNotImported()) {
      chips[row.fileName] = this.session.coins.chips(row);
    }
    return chips;
  });

  /**
   * "Will attach to <coin>" labels for the tier-3 rows the user has rescued.
   *
   * Built here, up front, for the same reason `nearChips` is: calling
   * `coins.nameById()` from the template would run a linear scan of the whole
   * inventory on every change-detection pass, for every rescued row. The map
   * is keyed by filename because a tier-3 row has no coin until it is rescued.
   */
  protected readonly rescuedLabels = computed(() => {
    const labels: Record<string, string> = {};
    for (const row of this.session.rescuedFromSkipped()) {
      labels[row.fileName] = this.session.coins.nameById(row.selectedCoinId);
    }
    return labels;
  });

  protected showMoreNear(): void {
    this.nearLimit.update(n => n + ImageImportModal.PAGE_SIZE);
  }

  protected showMoreSkipped(): void {
    this.skippedLimit.update(n => n + ImageImportModal.PAGE_SIZE);
  }

  /**
   * Discard the run and close. Revokes every preview URL on the way out.
   *
   * REFUSED WHILE A STAGE IS RUNNING. The Cancel button carries `[disabled]`,
   * but the two other ways out of this dialog — clicking the backdrop and the
   * × in the header — are not buttons and have no disabled state. `reset()`
   * clears the ThumbnailCache, which is where the attach runner is holding the
   * File handles it is part-way through reading, so a stray backdrop click
   * mid-import turned every remaining photo into a "File handle was lost"
   * failure. The user gets no feedback from the refusal beyond the fact that
   * the dialog stays put, which is the correct amount: the busy indicator
   * directly above already explains why.
   */
  close(): void {
    if (this.session.busy()) return;
    this.session.reset();
    this.nearLimit.set(ImageImportModal.PAGE_SIZE);
    this.skippedLimit.set(ImageImportModal.PAGE_SIZE);
    this.closed.emit();
  }
}
