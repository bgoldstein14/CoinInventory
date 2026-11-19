import { Component, computed, effect, inject, input, linkedSignal, signal } from '@angular/core';
import { CoinImagesStore } from '../../features/inventory/coin-images.store';
import {
  chooseViewerSource,
  describeViewerSource,
  initialViewerSize,
  maxViewerSize,
  minViewerSize,
  PixelSize
} from '../../features/inventory/photo-viewer-window';
import { CoinImagePathsService } from '../../services/coin-image-paths.service';
import { coinPhotoCount } from '../../services/coin-photos';
import { CoinRecord } from '../../types/coin.model';
import { CoinImagePathLink } from '../coin-image-path-link/coin-image-path-link';

/**
 * Full-size photo window opened from a gallery thumbnail. Opens at about half
 * the display, resizable by its corner (CSS `resize: both`), between a usable
 * minimum and the image's native resolution (see photo-viewer-window.ts).
 *
 * Shows the original camera file when the backend can still serve it, and
 * falls back to the downscaled copy stored in the database otherwise.
 */
@Component({
  selector: 'app-coin-photo-viewer',
  imports: [CoinImagePathLink],
  templateUrl: './coin-photo-viewer.html',
  styleUrl: './coin-photo-viewer.scss'
})
export class CoinPhotoViewer {
  private readonly paths = inject(CoinImagePathsService);

  /** The coin whose photos are being browsed. */
  readonly coin = input.required<CoinRecord>();

  /** Shared photo state, owned by the App shell. */
  readonly images = input.required<CoinImagesStore>();

  /** The stored `data:` URL of the photo on screen, or null if the index is out of range. */
  protected readonly currentImage = computed<string | null>(
    () => this.photos()[this.images().photoViewerIndex()] ?? null
  );

  /**
   * This coin's photos, or an empty list until InventoryService.loadCoinImages()
   * fills them in (the coin list endpoint does not include them).
   */
  protected readonly photos = computed(() => this.coin().imagePaths ?? []);

  /** Photo count for the "3 of 8" counter; uses `imageCount` until the photos arrive. */
  protected readonly photoCount = computed(() => coinPhotoCount(this.coin()));

  /** 1-based position of the photo on screen. */
  protected readonly photoPosition = computed(() => this.images().photoViewerIndex() + 1);

  /**
   * What CoinImagePathsService knows about this photo's original file. Updates
   * when the existence check returns, upgrading the viewer to the original.
   */
  protected readonly pathView = computed(() => {
    const image = this.currentImage();
    return image ? this.paths.viewFor(image) : null;
  });

  /**
   * Original-file URLs that failed to load, so the viewer falls back to the
   * stored copy (a file can disappear between the existence check and the fetch).
   */
  private readonly failedOriginals = signal<ReadonlySet<string>>(new Set());

  /** The URL actually bound to `<img src>`, and which of the two copies it is. */
  protected readonly source = computed(() => {
    const stored = this.currentImage() ?? '';
    const view = this.pathView();
    const failed = view?.fileUrl ? this.failedOriginals().has(view.fileUrl) : false;
    // A null view forces the stored copy.
    return chooseViewerSource(stored, failed ? null : view);
  });

  /**
   * Natural pixel size of the image on screen, set on load. A linkedSignal so
   * it resets to null whenever the URL changes.
   */
  protected readonly naturalSize = linkedSignal<string, PixelSize | null>({
    source: () => this.source().url,
    computation: () => null
  });

  /**
   * Initial window size in px. Depends only on the natural size, so it is
   * written once per photo; anything else here would overwrite a user's
   * corner-drag resize.
   */
  protected readonly windowSize = computed<PixelSize | null>(() => {
    const natural = this.naturalSize();
    if (!natural) return null;
    return initialViewerSize(natural, this.viewportSize());
  });

  /** Upper size limit: the image's native resolution. Null until loaded. */
  protected readonly maxSize = computed(() => maxViewerSize(this.naturalSize()));

  /** Lower size limit, never above the upper limit. */
  protected readonly minSize = computed(() => minViewerSize(this.naturalSize()));

  /** The "Original file — 4032 × 3024" caption. */
  protected readonly sourceLabel = computed(
    () => describeViewerSource(this.source().kind, this.naturalSize())
  );

  constructor() {
    // Source paths are not part of the coin list, so load them for this coin
    // (cached per coin). Needed when the viewer opens before any path link has rendered.
    effect(() => this.paths.ensureLoaded(this.coin().id));
  }

  /** Record the real pixel size of whatever just finished loading. */
  protected onImageLoad(event: Event): void {
    const img = event.target as HTMLImageElement;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      this.naturalSize.set({ width: img.naturalWidth, height: img.naturalHeight });
    }
  }

  /**
   * The original failed to load: remember it and fall back to the stored copy.
   * An error on the stored copy itself has no fallback.
   */
  protected onImageError(): void {
    const current = this.source();
    if (current.kind !== 'original') return;
    this.failedOriginals.update(set => new Set(set).add(current.url));
  }

  /**
   * The current display size. Deliberately not a signal, so windowSize() does
   * not recompute while the user is resizing.
   */
  private viewportSize(): PixelSize {
    // Unit tests evaluate this without a DOM.
    if (typeof window === 'undefined') return { width: 1280, height: 800 };
    return { width: window.innerWidth, height: window.innerHeight };
  }
}
