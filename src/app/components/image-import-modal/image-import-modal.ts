import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImageMatchingService } from '../../services/image-matching.service';
import { InventoryService } from '../../services/inventory.service';
import { BatchImageImportService } from '../../services/batch-image-import.service';
import { StorageService } from '../../services/storage.service';
import { ApiService } from '../../services/api.service';
import { BatchImportSession } from '../../services/image-import/batch-import-session';
import { shotLabel } from '../../services/image-import/photo-sets';
import { CoinImageGroupRow } from '../coin-image-group/coin-image-group';
import { NearMatchReview } from '../near-match-review/near-match-review';

/**
 * Batch image import screen. Owns one BatchImportSession
 * (services/image-import/batch-import-session.ts) and renders its three tiers:
 * matched coins, near matches (one yes/no per coin) and a read-only list of
 * skipped files with an opt-in "Attach anyway". Tier rules live in
 * services/image-matching/near-match.ts.
 */
@Component({
  selector: 'app-image-import-modal',
  imports: [FormsModule, DecimalPipe, CoinImageGroupRow, NearMatchReview],
  templateUrl: './image-import-modal.html',
  styleUrl: './image-import-modal.scss'
})
export class ImageImportModal {
  readonly closed = output<void>();

  /** All import state; the template reads it directly. */
  protected readonly session = new BatchImportSession(
    inject(InventoryService),
    inject(ImageMatchingService),
    inject(BatchImageImportService),
    // Optional so unit tests can build the component without root providers;
        // without it the base folder is simply not remembered.
    inject(StorageService, { optional: true }) ?? undefined,
    // Optional for the same reason; used only to prefill the base folder with the
        // app's install path.
    inject(ApiService, { optional: true }) ?? undefined
  );

  /** Entries rendered initially and per "show more" click; the long lists are paged for DOM performance. */
  private static readonly PAGE_SIZE = 25;

  protected readonly nearLimit = signal(ImageImportModal.PAGE_SIZE);
  protected readonly skippedLimit = signal(ImageImportModal.PAGE_SIZE);

  /** Tier 2, paged by coin. */
  protected readonly visibleNearGroups = computed(() =>
    this.session.nearMatchGroups().slice(0, this.nearLimit())
  );

  /** Tier 3, paged by photo set (all shots of one coin share a row). */
  protected readonly visibleNotImported = computed(() =>
    this.session.notImportedSets().slice(0, this.skippedLimit())
  );

  /** The shot chips ("Obverse", "Reverse #2", "Label") for each visible set, by lead file. */
  protected readonly shotChips = computed(() => {
    const chips: Record<string, Array<{ fileName: string; label: string }>> = {};
    for (const set of this.visibleNotImported()) {
      chips[set.leadFileName] = set.rows.map(row => ({ fileName: row.fileName, label: shotLabel(row) }));
    }
    return chips;
  });

  /** Per visible set: how many members will attach and to which coin, or null. */
  protected readonly setRescue = computed(() => {
    const labels = this.rescuedLabels();
    const state: Record<string, { label: string; count: number } | null> = {};
    for (const set of this.visibleNotImported()) {
      const rescued = set.rows.filter(row => !!labels[row.fileName]);
      state[set.leadFileName] = rescued.length > 0
        ? { label: labels[rescued[0].fileName], count: rescued.length }
        : null;
    }
    return state;
  });

  /**
     * Parsed filename chips for every tier-2 photo, keyed by filename.
     * Computed once rather than called from the template on every change-detection pass.
     */
  protected readonly nearChips = computed(() => {
    const chips: Record<string, string[]> = {};
    for (const row of this.session.nearMatches()) {
      chips[row.fileName] = this.session.coins.chips(row);
    }
    return chips;
  });

  /** Labels for every coin a tier-2 row could end up on. */
  protected readonly nearCoinLabels = computed(() => {
    const labels: Record<string, string> = {};
    for (const row of this.session.nearMatches()) {
      for (const candidate of row.result.nearMatch?.candidates ?? []) {
        labels[candidate.coinId] = candidate.coinLabel;
      }
    }
    return labels;
  });

  /** Parsed chips for the visible page of tier-3 rows only. */
  protected readonly skippedChips = computed(() => {
    const chips: Record<string, string[]> = {};
    for (const set of this.visibleNotImported()) {
      chips[set.leadFileName] = this.session.coins.chips(set.rows[0]);
    }
    return chips;
  });

  /**
     * "Will attach to <coin>" labels for rescued tier-3 rows, keyed by filename.
     * Precomputed because `coins.nameById()` scans the inventory.
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
     * Discard the run and close. Ignored while a stage is running: the backdrop
     * has no disabled state, and reset() would release File handles mid-import.
     */
  close(): void {
    if (this.session.busy()) return;
    this.session.reset();
    this.nearLimit.set(ImageImportModal.PAGE_SIZE);
    this.skippedLimit.set(ImageImportModal.PAGE_SIZE);
    this.closed.emit();
  }
}
