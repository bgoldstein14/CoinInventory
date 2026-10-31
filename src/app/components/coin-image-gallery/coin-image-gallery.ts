import { Component, computed, input } from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import { describeCoin } from '../../services/image-matching/coin-signature';
import { CoinRecord } from '../../types/coin.model';
import { CoinImagePathLink } from '../coin-image-path-link/coin-image-path-link';

/**
 * CoinImageGallery — the overlay listing every photo attached to the selected
 * coin, with buttons to add more, delete one, enlarge one, or make one the
 * grid thumbnail.
 *
 * WHY THIS FILE EXISTS
 * Photo management is a self-contained job with a surprising amount of plumbing
 * behind it (file pickers, drag-and-drop, base64 encoding). All of that lives
 * in CoinImagesStore; this component is just the markup that drives it.
 *
 * ONE COIN, ALWAYS. Everything on screen comes from `coin().imagePaths`, and
 * `coin` is the App shell's currently selected coin. There is no code path
 * here that can reach another coin's photos. (If the gallery ever *looks* like
 * it is showing more than one coin's worth, the photos really are all attached
 * to this coin — see the notes in coin-gallery-scope.spec.ts, which covers
 * both the scoping property and the import behaviour that can make one coin
 * legitimately collect a whole folder.)
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

  /** How many photos this coin has, shown as a chip next to the heading. */
  protected readonly photoCount = computed(() => this.coin().imagePaths.length);

  // Note: the lazy fetch of the recorded file paths is triggered by the
  // CoinImagePathLink children (see that component), not from here — so this
  // component still needs nothing but its two inputs.
}
