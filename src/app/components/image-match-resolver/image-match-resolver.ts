import { Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { BatchImageRow, CoinRecord, RankedImageMatch } from '../../types/coin.model';

/**
 * ImageMatchResolver — one card for a photo the matcher could NOT confidently
 * place, in either of the two "needs a human" buckets:
 *
 *   * "Needs your choice" — the matcher has ranked candidates but is not sure
 *     (e.g. an 1881 Morgan that could be the S or the O mint).
 *   * "No match found"    — nothing worth suggesting: the group shots
 *     ("Gold Coins.JPG", "20th Century Type Set.JPG"), the non-coin items
 *     (stamps, bond coupons, albums) and camera-default names
 *     ("IM000025.JPG", "Coin_026.JPG").
 *
 * WHY THIS FILE EXISTS
 * The card is the same in both buckets, and it carries a fair amount of
 * markup — parsed-attribute chips, a ranked candidate list and a coin search
 * box. Leaving it inline would have pushed the modal template past 300 lines.
 *
 * It is a dumb component: every piece of state arrives as an input and every
 * decision leaves as an output. The modal owns the row list.
 */
@Component({
  selector: 'app-image-match-resolver',
  imports: [DecimalPipe],
  templateUrl: './image-match-resolver.html',
  styleUrl: './image-match-resolver.scss'
})
export class ImageMatchResolver {
  /** The unresolved file. */
  readonly row = input.required<BatchImageRow>();

  /** "What we read from the filename", already formatted by the modal. */
  readonly chips = input<string[]>([]);

  /** Current text in this card's coin-search box. */
  readonly searchTerm = input('');

  /** Coins matching that text (max 8), resolved by the modal. */
  readonly searchResults = input<CoinRecord[]>([]);

  /** Display label for the coin currently chosen, if any. */
  readonly selectedCoinLabel = input('');

  /** Lazily-created object URL for the preview, or '' for no preview. */
  readonly thumbnailUrl = input('');

  /** The search text changed. */
  readonly searchChanged = output<string>();

  /** The user picked one of the matcher's ranked candidates. */
  readonly candidateChosen = output<RankedImageMatch>();

  /** The user picked a coin from the free-text search. Emits the coin id. */
  readonly coinAssigned = output<string>();

  /** "Don't attach this one." */
  readonly skipped = output<void>();

  /** Undo a skip or a choice and go back to undecided. */
  readonly reset = output<void>();

  /** Pull the value out of an input event without `$any` in the template. */
  protected onSearchInput(event: Event): void {
    this.searchChanged.emit((event.target as HTMLInputElement).value);
  }
}
