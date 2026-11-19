import { Component, computed, effect, inject, input } from '@angular/core';
import { CoinImagePathsService } from '../../services/coin-image-paths.service';

/**
 * Shows where one photo's original file lives, as a link when the file still
 * exists. Shared by the gallery and the full-size viewer.
 *
 * Links go through `GET /api/images/file?path=...` because browsers silently
 * block `file://` links from an http page (see ApiService.imageFileUrl).
 */
@Component({
  selector: 'app-coin-image-path-link',
  imports: [],
  templateUrl: './coin-image-path-link.html',
  styleUrl: './coin-image-path-link.scss'
})
export class CoinImagePathLink {
  private readonly paths = inject(CoinImagePathsService);

  /** The displayed image's `data:` URL, used as the lookup key. */
  readonly imageData = input.required<string>();

  /**
   * The coin this image belongs to; triggers the lazy load of its recorded
   * paths (cached per coin, so many links cost one request). Optional.
   */
  readonly coinId = input<string | null>(null);

  /** Display state from image-path-display.ts; updates when paths and existence checks arrive. */
  protected readonly view = computed(() => this.paths.viewFor(this.imageData()));

  constructor() {
    // Recorded paths are not in the coin list, so load them on first view.
    effect(() => this.paths.ensureLoaded(this.coinId()));
  }
}
