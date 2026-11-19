import { Component, computed, input } from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import { coinPhotoCount } from '../../services/coin-photos';
import { describeCoin } from '../../services/image-matching/coin-signature';
import { CoinRecord } from '../../types/coin.model';
import { CoinImagePathLink } from '../coin-image-path-link/coin-image-path-link';

/**
 * Overlay listing the selected coin's photos, with add, delete, enlarge and
 * set-as-main actions. The logic lives in CoinImagesStore; this is the markup.
 * Only ever shows the one selected coin's photos.
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

  /** Dialog title, e.g. "Morgan Dollar 1881-S — PCGS MS64"; same wording as the import screens. */
  protected readonly coinLabel = computed(() => describeCoin(this.coin()));

  /** The photos, or an empty list until InventoryService.loadCoinImages() fills them in. */
  protected readonly photos = computed(() => this.coin().imagePaths ?? []);

  /** Photo count from `imageCount`, known before the photos themselves arrive. */
  protected readonly photoCount = computed(() => coinPhotoCount(this.coin()));

  /** True while the coin has photos that have not arrived yet, so the empty state is not shown. */
  protected readonly stillLoading = computed(
    () => this.photos().length === 0 && this.photoCount() > 0
  );

}
