import { DecimalPipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { BatchImageRow, NearMatchGroup } from '../../types/coin.model';

/**
 * NearMatchReview — TIER 2 of the batch image import: one coin, and the photos
 * that are one yes/no away from being attached to it.
 *
 * WHAT A NEAR MATCH IS
 * The filename and the coin agree on all four identifying attributes — year,
 * coin type, denomination and grade — so they are the same coin; but something
 * ELSE is off (a mint mark that disagrees, a variety, a cert number, or simply
 * two coins fitting equally well), so the matcher's safety gates would not
 * attach it unasked. The rule itself lives in
 * `services/image-matching/near-match.ts`; this file only draws it.
 *
 * THE ONE DESIGN CONSTRAINT: one action, not a form. A row offers exactly
 * three things and nothing else:
 *
 *   Attach              accept the suggested coin
 *   a dropdown          pick one of the OTHER coins that also passed the
 *                       near-match test (never the whole inventory — a coin
 *                       the test rejected must not be one click away)
 *   Skip                leave this photo alone
 *
 * There is deliberately no free-text coin search here. The point of the three
 * tiers is that a file nobody can suggest a coin for never reaches this list
 * in the first place, so hand-solving does not belong on this screen.
 *
 * WHY THE UNIT IS A COIN AND NOT A FILE
 * A coin routinely has 8-10 photos: both faces, the slab label, numbered
 * retakes and derivative renderings. When they near-match, they all
 * near-match the same coin, and asking the same question five times is the
 * manual work this screen exists to remove — hence the group header's
 * "Attach all", which settles the whole coin at once.
 *
 * It is a dumb component: every piece of state arrives as an input and every
 * decision leaves as an output. The session owns the rows.
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
