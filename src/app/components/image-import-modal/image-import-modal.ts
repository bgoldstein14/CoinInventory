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
import { ImageMatchResolver } from '../image-match-resolver/image-match-resolver';

/**
 * ImageImportModal — the batch image import screen: point at a folder, review
 * the proposed coin/photo pairings, tick what you want, and save.
 *
 * WHY THIS FILE IS SO SHORT
 * All of the state and behaviour lives in BatchImportSession (see
 * services/image-import/batch-import-session.ts), which documents the
 * four-step flow: filter the files, match on file NAMES only, review grouped
 * by coin, then read + downscale + save just the ticked photos. This component
 * is the shell that owns one session and the two child components that render
 * it:
 *
 *   app-coin-image-group    — one coin and its proposed photos, with
 *                             checkboxes and the per-coin bulk controls.
 *   app-image-match-resolver — one photo the matcher could not place, with its
 *                             ranked candidates and a coin search box.
 *
 * The session is created per modal instance, so closing and re-opening the
 * dialog always starts from a clean slate.
 */
@Component({
  selector: 'app-image-import-modal',
  imports: [FormsModule, DecimalPipe, CoinImageGroupRow, ImageMatchResolver],
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
   * How much of the two "needs a human" buckets to actually render
   * ---------------------------------------------------------------------
   * Selecting the share's root can leave several hundred unmatched files -
   * group shots, stamps, bond coupons, camera-default names. Each one renders
   * a card with a ranked candidate list and a search input, and the search
   * input re-runs its (cheap) filter on every change-detection pass. Putting
   * 1,700 of those in the DOM at once is slow to create and slow to update
   * forever after.
   *
   * So the cards are paged: a screenful at a time, with a "show more" button.
   * This is purely a rendering decision, which is why it lives in the
   * component rather than in the session - the data is all there either way.
   * ------------------------------------------------------------------- */

  /** Cards added per "show more" click, and shown initially. */
  private static readonly PAGE_SIZE = 25;

  protected readonly reviewLimit = signal(ImageImportModal.PAGE_SIZE);
  protected readonly unmatchedLimit = signal(ImageImportModal.PAGE_SIZE);

  protected readonly visibleReviewMatches = computed(() =>
    this.session.reviewMatches().slice(0, this.reviewLimit())
  );

  protected readonly visibleUnmatchedImages = computed(() =>
    this.session.unmatchedImages().slice(0, this.unmatchedLimit())
  );

  protected showMoreReview(): void {
    this.reviewLimit.update(n => n + ImageImportModal.PAGE_SIZE);
  }

  protected showMoreUnmatched(): void {
    this.unmatchedLimit.update(n => n + ImageImportModal.PAGE_SIZE);
  }

  /** Discard the run and close. Revokes every preview URL on the way out. */
  close(): void {
    this.session.reset();
    this.reviewLimit.set(ImageImportModal.PAGE_SIZE);
    this.unmatchedLimit.set(ImageImportModal.PAGE_SIZE);
    this.closed.emit();
  }
}
