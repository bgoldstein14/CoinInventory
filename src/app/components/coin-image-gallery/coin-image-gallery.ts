import { Component, computed, input } from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import { coinPhotoCount } from '../../services/coin-photos';
import { describeCoin } from '../../services/image-matching/coin-signature';
import { CoinRecord } from '../../types/coin.model';
import { CoinImagePathLink } from '../coin-image-path-link/coin-image-path-link';

/**
 * CoinImageGallery — the overlay listing every photo attached to the selected
 * coin, with buttons to add more, delete one, enlarge one, or make one the
 * grid thumbnail.
 *
 * Photo management has a surprising amount of plumbing behind it (file
 * pickers, drag-and-drop, base64 encoding). All of that lives in
 * CoinImagesStore; this component is just the markup that drives it.
 *
 * ONE COIN, ALWAYS. Everything on screen comes from `coin().imagePaths` —
 * fetched for that one coin by InventoryService.loadCoinImages(), since the
 * list endpoint does not carry photographs — and `coin` is the App shell's
 * currently selected coin. There is no code path here that can reach another
 * coin's photos. (If the gallery ever *looks* like it is showing more than one
 * coin's worth, the photos really are all attached to this coin — see
 * coin-gallery-scope.spec.ts, which covers both the scoping property and the
 * import behaviour that can make one coin legitimately collect a whole
 * folder.)
 */
@Component({
  selector: 'app-coin-image-gallery',
  imports: [CoinImagePathLink],
  templateUrl: './coin-image-gallery.html',
  styleUrl: './coin-image-gallery.scss'
})
export class CoinImageGallery {
  /** The coin whose photos are being shown. */
  readonly coin = input.required<CoinRecord>();

  /** Shared photo state, owned by the App shell. */
  readonly images = input.required<CoinImagesStore>();

  /**
   * "Morgan Dollar 1881-S — PCGS MS64", for the dialog title.
   *
   * Reuses the matcher's `describeCoin` rather than re-deriving a label here:
   * the import review screens already name coins that way, so the gallery
   * title and the import screens agree word for word.
   */
  protected readonly coinLabel = computed(() => describeCoin(this.coin()));

  /**
   * The photographs to draw, or an empty list while they are still arriving.
   *
   * `GET /api/coins` does not carry them (server/routes/coins/list-query.ts),
   * so `coin().imagePaths` is ABSENT until `InventoryService.loadCoinImages()`
   * fills it in for the selected coin. Reading it directly would throw; this
   * computed re-renders the moment the fetch lands.
   */
  protected readonly photos = computed(() => this.coin().imagePaths ?? []);

  /**
   * How many photos this coin has, shown as a chip next to the heading.
   *
   * Deliberately NOT `photos().length`: the count is known from the list's
   * `imageCount` before the photographs themselves arrive, so the heading is
   * right immediately instead of flashing "0".
   */
  protected readonly photoCount = computed(() => coinPhotoCount(this.coin()));

  /**
   * "This coin has photographs, but we do not have them yet."
   *
   * Distinguishes the two reasons the tile list can be empty. Without it a
   * coin with eight photos would briefly show the "No photos yet — add the
   * first one" invitation, and a user who believes it attaches a duplicate.
   */
  protected readonly stillLoading = computed(
    () => this.photos().length === 0 && this.photoCount() > 0
  );

  // Note: the lazy fetch of the recorded file paths is triggered by the
  // CoinImagePathLink children (see that component), and the fetch of the
  // photographs themselves by InventoryService.selectCoin — so this
  // component still needs nothing but its two inputs.
}
