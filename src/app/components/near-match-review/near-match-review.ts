import { DecimalPipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { BatchImageRow, NearMatchGroup } from '../../types/coin.model';

/**
 * Tier 2 of the batch image import: one coin and the photos that nearly match it.
 * Each row offers Attach, a dropdown of other coins that also passed the near-match
 * test (see services/image-matching/near-match.ts), or Skip. Presentational only:
 * state arrives as inputs and decisions leave as outputs.
 */
@Component({
  selector: 'app-near-match-review',
  imports: [DecimalPipe],
  templateUrl: './near-match-review.html',
  styleUrl: './near-match-review.scss'
})
export class NearMatchReview {
  /** The coin and its near-matching photos. */
  readonly group = input.required<NearMatchGroup>();

  /** "What we read from each filename", already formatted by the modal. */
  readonly chips = input<Record<string, string[]>>({});

  /** Object URLs by filename. Empty until the user asks to see the photos. */
  readonly thumbnailUrls = input<Record<string, string>>({});

  /** True when the user has asked to see this group's photos. */
  readonly photosShown = input(false);

  /** Coin labels by id, so an answered row can name the coin it will go to. */
  readonly coinLabels = input<Record<string, string>>({});

  /** Show / hide this group's thumbnails. Emits the coin id. */
  readonly photosToggled = output<string>();

  /** "Yes" for every unanswered photo in the group. Emits the coin id. */
  readonly allAccepted = output<string>();

  /** "Skip" for every unanswered photo in the group. Emits the coin id. */
  readonly allSkipped = output<string>();

  /** "Yes" for one photo. Emits the filename. */
  readonly accepted = output<string>();

  /** "Skip" for one photo. Emits the filename. */
  readonly skipped = output<string>();

  /** Undo an answer. Emits the filename. */
  readonly reset = output<string>();

  /** A different near candidate was picked from the dropdown. */
  readonly candidateChosen = output<{ fileName: string; coinId: string }>();

  /** Chips for one row, or an empty list. */
  protected chipsFor(fileName: string): string[] {
    return this.chips()[fileName] ?? [];
  }

  protected thumbnailFor(fileName: string): string {
    return this.thumbnailUrls()[fileName] ?? '';
  }

  /** Display label for the coin an answered row will be attached to. */
  protected labelFor(coinId: string | null): string {
    if (!coinId) return '';
    return this.coinLabels()[coinId] ?? coinId;
  }

  /**
   * Pull the chosen coin id out of a <select> change without `$any` in the
   * template, and reset the control so it always reads "or pick another".
   */
  protected onCandidatePicked(row: BatchImageRow, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const coinId = select.value;
    select.value = '';
    if (coinId) this.candidateChosen.emit({ fileName: row.fileName, coinId });
  }
}
