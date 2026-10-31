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
import { CoinRecord } from '../../types/coin.model';
import { CoinImagePathLink } from '../coin-image-path-link/coin-image-path-link';

/**
 * CoinPhotoViewer — the full-size photo window you get by clicking a thumbnail
 * in the gallery.
 *
 * WHAT IT IS, IN THE OWNER'S WORDS
 *   "clicking on the image opens a large popup showing the full size coin
 *    image which is in a resizable window where the image takes up the full
 *    size of the window (which should start off only taking about 1/2 the
 *    display) allow me to shrink and grow the image window up to the highest
 *    resolution of the picture"
 *
 * So it is no longer a fixed lightbox. It is a WINDOW:
 *
 *   - it opens at about half the display, shaped like the photo so the photo
 *     fills it exactly;
 *   - you drag its bottom-right corner to resize it (plain CSS `resize: both`
 *     — see the stylesheet; no drag handlers, no library);
 *   - it will not shrink below a usable minimum, and it will not grow past the
 *     image's own native resolution, because past that there is no more detail
 *     to reveal and the photo would simply go soft.
 *
 * All of those numbers come from features/inventory/photo-viewer-window.ts,
 * which is pure arithmetic and has its own spec. This component's whole job is
 * to feed it the two things only a browser knows — the loaded image's
 * naturalWidth/naturalHeight and the size of the display — and bind the
 * answers to CSS.
 *
 * ---------------------------------------------------------------------------
 * WHICH PHOTO IT ACTUALLY SHOWS
 * ---------------------------------------------------------------------------
 * `coin.imagePaths[i]` is NOT the original. It is the downscaled ~250 KB copy
 * kept in the database. Opening "full size" on that would cap the window at a
 * resolution far below the real photo's, which is not what was asked for.
 *
 * So when the original camera file is still on disk, this viewer shows THAT,
 * streamed by the backend from `GET /api/images/file?path=…`. When it is not
 * (no path was ever recorded, or the file has since moved) it falls back to
 * the stored copy and the maximum shrinks accordingly — automatically, because
 * the maximum is always the natural size of whatever actually loaded.
 *
 * A one-line caption at the bottom says which of the two is on screen.
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

  /**
   * The stored `data:` URL of the photo currently on screen, or null if the
   * index has somehow drifted out of range (which the store prevents, but the
   * template should not depend on that). Also the key everything else here is
   * looked up by, so it all follows the previous/next buttons automatically.
   */
  protected readonly currentImage = computed<string | null>(
    () => this.coin().imagePaths[this.images().photoViewerIndex()] ?? null
  );

  /** How many photos there are, for the "3 of 8" counter. */
  protected readonly photoCount = computed(() => this.coin().imagePaths.length);

  /** 1-based position of the photo on screen, for the same counter. */
  protected readonly photoPosition = computed(() => this.images().photoViewerIndex() + 1);

  /**
   * What CoinImagePathsService knows about this photo's original file. A
   * computed over that service's signals, so when the "does this file still
   * exist" check comes back a moment after opening, the viewer notices and
   * upgrades itself from the stored copy to the original.
   */
  protected readonly pathView = computed(() => {
    const image = this.currentImage();
    return image ? this.paths.viewFor(image) : null;
  });

  /**
   * Originals we asked for and did not get.
   *
   * The existence check and the actual fetch are two separate moments: the
   * backend can confirm a file at 12:00 and fail to serve it at 12:01 (it was
   * deleted in between, or it is on a share that just dropped). Without this
   * the user would be left looking at a broken-image icon with a perfectly
   * good stored copy sitting unused. Keyed by URL so one bad file does not
   * taint the rest, and held in memory only for the life of the overlay.
   */
  private readonly failedOriginals = signal<ReadonlySet<string>>(new Set());

  /** The URL actually bound to `<img src>`, and which of the two copies it is. */
  protected readonly source = computed(() => {
    const stored = this.currentImage() ?? '';
    const view = this.pathView();
    const failed = view?.fileUrl ? this.failedOriginals().has(view.fileUrl) : false;
    // Passing null for the view is what forces the stored-copy branch.
    return chooseViewerSource(stored, failed ? null : view);
  });

  /**
   * The on-screen image's real pixel dimensions, filled in by (load).
   *
   * A linkedSignal rather than a plain one: its `source` is the URL being
   * shown, so it RESETS ITSELF to null the moment that changes — stepping to
   * the next photo, or swapping the stored copy for the original. A plain
   * signal would keep the previous photo's dimensions and size the window from
   * them until the new image finished loading.
   */
  protected readonly naturalSize = linkedSignal<string, PixelSize | null>({
    source: () => this.source().url,
    computation: () => null
  });

  /**
   * The window's size, in px, as bound to the element.
   *
   * IMPORTANT, AND EASY TO BREAK: this is deliberately computed ONLY from the
   * image's natural size, so it changes exactly twice per photo — once to null
   * when the photo changes, and once when the new one has loaded. In between
   * those moments Angular writes nothing to the element, which is precisely
   * what lets `resize: both` work: a user drag sets inline width/height, and
   * nothing here comes along afterwards and overwrites it.
   *
   * Add anything else to this computed (a mouse position, a window-resize
   * signal, a timer) and dragging the corner will start snapping back.
   */
  protected readonly windowSize = computed<PixelSize | null>(() => {
    const natural = this.naturalSize();
    if (!natural) return null;
    return initialViewerSize(natural, this.viewportSize());
  });

  /** Hard ceiling: the image's native resolution. Null until it has loaded. */
  protected readonly maxSize = computed(() => maxViewerSize(this.naturalSize()));

  /** Floor, never above the ceiling. See minViewerSize(). */
  protected readonly minSize = computed(() => minViewerSize(this.naturalSize()));

  /** The "Original file — 4032 × 3024" caption. */
  protected readonly sourceLabel = computed(
    () => describeViewerSource(this.source().kind, this.naturalSize())
  );

  constructor() {
    // Same lazy load the gallery relies on: the recorded source paths are not
    // part of the main coin list, so they are fetched the first time a coin's
    // photos are looked at. Without this the viewer could be opened (via a
    // deep link or a keyboard shortcut) before any CoinImagePathLink has been
    // rendered, and would never discover that an original exists.
    // `ensureLoaded` is cached per coin, so calling it again costs nothing.
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
   * The original would not load after all. Remember that and fall back.
   *
   * Only meaningful for the 'original' branch — an error on the stored copy
   * means the database row itself is corrupt, and there is nothing left to
   * fall back TO, so we leave the broken-image icon rather than loop.
   */
  protected onImageError(): void {
    const current = this.source();
    if (current.kind !== 'original') return;
    this.failedOriginals.update(set => new Set(set).add(current.url));
  }

  /**
   * The display size. Read through a method (not captured once) so that the
   * numbers are current whenever a photo loads — but NOT a signal, because
   * windowSize() must not recompute while the user is dragging the corner.
   */
  private viewportSize(): PixelSize {
    // `typeof window` guard: this component is only ever rendered in a
    // browser, but the computed above can be evaluated by a unit test that
    // has no DOM, and a crash there would be a confusing way to find out.
    if (typeof window === 'undefined') return { width: 1280, height: 800 };
    return { width: window.innerWidth, height: window.innerHeight };
  }
}
