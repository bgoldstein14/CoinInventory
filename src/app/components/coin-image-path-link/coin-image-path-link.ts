import { Component, computed, effect, inject, input } from '@angular/core';
import { CoinImagePathsService } from '../../services/coin-image-paths.service';

/**
 * CoinImagePathLink — shows where ONE photo's original file lives, and makes it
 * clickable when that file is still there.
 *
 * WHY THIS IS ITS OWN COMPONENT
 * Three places show a photo (the gallery list, the full-screen viewer, and the
 * detail sidebar's photo strip) and all three need identical behaviour: the
 * same three states, the same tooltip wording, the same muted colour. Putting
 * it in one component means there is exactly one copy of that logic and one
 * copy of the CSS, instead of three that drift apart.
 *
 * All this component takes is the image's `data:` URL. It looks the path up
 * through CoinImagePathsService, which already holds both the recorded paths
 * and the cached does-it-still-exist answers.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LINK GOES THROUGH THE BACKEND
 * ---------------------------------------------------------------------------
 * The natural thing to write is `<a href="file:///C:/pics/x.jpg">`. It does not
 * work. Chrome and Edge block navigation from an `http://` page to a `file://`
 * URL, and they do it SILENTLY — the user clicks and absolutely nothing
 * happens, not even an error. It is a hard security boundary; no attribute or
 * setting disables it.
 *
 * So we link to `GET /api/images/file?path=...` instead. The Express server
 * runs on the user's own machine, opens the file itself and streams it back
 * with `Content-Disposition: inline`, which the browser is happy to display.
 * From the page's point of view it is just a same-origin http URL.
 * See ApiService.imageFileUrl.
 */
@Component({
  selector: 'app-coin-image-path-link',
  imports: [],
  templateUrl: './coin-image-path-link.html',
  styleUrl: './coin-image-path-link.scss'
})
export class CoinImagePathLink {
  private readonly paths = inject(CoinImagePathsService);

  /** The displayed image's `data:` URL — the key everything is looked up by. */
  readonly imageData = input.required<string>();

  /**
   * The coin this image belongs to, so this component can trigger the lazy
   * fetch of that coin's recorded paths.
   *
   * WHY THE FETCH IS TRIGGERED HERE, of all places: this is the one component
   * that Angular always constructs through its own injector, so it is the one
   * place `CoinImagePathsService` can be injected without making the detail
   * panel and the gallery harder to construct in unit tests. `ensureLoaded` is
   * idempotent and cached per coin, so eight of these on screen still produce
   * exactly one request.
   *
   * Optional (defaults to null) so the component can be dropped anywhere the
   * paths are already loaded without inventing a coin id for it.
   */
  readonly coinId = input<string | null>(null);

  /**
   * Everything the template renders, worked out in
   * features/inventory/image-path-display.ts. A computed, so the row updates
   * itself when the paths arrive and again when the batched existence check
   * comes back a moment later.
   */
  protected readonly view = computed(() => this.paths.viewFor(this.imageData()));

  constructor() {
    // LAZY LOAD. The recorded paths are not part of the main coin list (which
    // can be fetched without image payloads at all), so they are pulled the
    // first time a coin's photos are actually looked at.
    effect(() => this.paths.ensureLoaded(this.coinId()));
  }
}
