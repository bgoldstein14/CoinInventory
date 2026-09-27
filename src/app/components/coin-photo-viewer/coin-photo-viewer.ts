import { Component, computed, input } from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import { CoinRecord } from '../../types/coin.model';
import { CoinImagePathLink } from '../coin-image-path-link/coin-image-path-link';

/**
 * CoinPhotoViewer — the full-screen "lightbox" you get by clicking a thumbnail
 * in the gallery, with previous / next / close controls.
 *
 * WHY THIS FILE EXISTS
 * It is a completely separate overlay from the gallery (different z-index,
 * different backdrop, different keyboard affordances), so it gets its own
 * component. Which photo is showing lives in CoinImagesStore, shared with the
 * gallery that opened it.
 */
@Component({
  selector: 'app-coin-photo-viewer',
  imports: [CoinImagePathLink],
  templateUrl: './coin-photo-viewer.html',
  styleUrl: './coin-photo-viewer.scss'
})
export class CoinPhotoViewer {
  /** The coin whose photos are being browsed. */
  readonly coin = input.required<CoinRecord>();

  /** Shared photo state, owned by the App shell. */
  readonly images = input.required<CoinImagesStore>();

  /**
   * The `data:` URL of the photo currently on screen, or null if the index has
   * somehow drifted out of range (which the store prevents, but the template
   * should not depend on that). Also the key the path caption looks itself up
   * by, so it follows the previous/next buttons automatically.
   */
  protected readonly currentImage = computed<string | null>(
    () => this.coin().imagePaths[this.images().photoViewerIndex()] ?? null
  );
}
