/* ===========================================================================
 * CoinImagePathsService
 * ---------------------------------------------------------------------------
 * "Where did this photo come from, and is that file still there?"
 *
 * Two questions, two endpoints, and a cache in front of both:
 *
 *   GET  /api/coins/:id/images   the recorded sourcePath for each image
 *   POST /api/images/exists      does each of those files still exist
 *
 * ---------------------------------------------------------------------------
 * THE RULES THIS SERVICE ENFORCES
 * ---------------------------------------------------------------------------
 *  1. LAZY. Nothing is fetched until a coin is actually being viewed. The main
 *     coin list can be loaded without image payloads, and pulling the full
 *     base64 for every coin up front is exactly what that change was avoiding.
 *
 *  2. ONE existence request per coin, never one per image. A coin with eight
 *     photos means one POST with eight paths, not eight POSTs. Otherwise the
 *     links pop in one at a time and the server does eight rounds of disk I/O
 *     it could have done in one.
 *
 *  3. CACHED for the session. Clicking away from a coin and back must not
 *     re-fetch anything. Images are cached per coin id and existence per path,
 *     so re-selecting a coin is free. (Per PATH, not per coin, because the same
 *     file can legitimately be the source for more than one image.)
 *
 *  4. A FAILURE IS "UNKNOWN", NOT "MISSING". If the backend cannot be reached
 *     we know nothing about the files, so the paths render as plain text. The
 *     alternative — showing every photo as gone whenever the server blinks —
 *     would be actively alarming and wrong.
 * =========================================================================== */

import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { describeHttpError } from './http-utils';
import { imageSourcePaths } from './image-source-paths';
import { CoinImageRecord, ImageFileExistence } from '../types/coin-image.model';
import { buildImagePathView, ImagePathView } from '../features/inventory/image-path-display';

/**
 * The server rejects more than 500 paths in one request. A coin never has
 * anywhere near that many photos, so this slice is a guard against a
 * pathological record rather than an expected code path — but it means a bad
 * row can never turn the whole panel's check into a 400.
 */
const MAX_PATHS_PER_CHECK = 500;

@Injectable({ providedIn: 'root' })
export class CoinImagePathsService {
  private readonly api = inject(ApiService);
  private readonly logger = inject(LoggingService);

  /**
   * path -> does it exist. A signal so the templates re-render the moment the
   * check comes back; a path that is absent from this map is 'unknown'.
   */
  private readonly existenceByPath = signal<Record<string, boolean>>({});

  /**
   * Coins we have already fetched (or are fetching). Rule 3: re-selecting a
   * coin must issue no requests at all. A plain Set, not a signal — nothing
   * renders from it.
   */
  private readonly loadedCoins = new Set<string>();

  /**
   * Fetch a coin's image paths and check them, unless we already have.
   *
   * Safe to call from an effect or repeatedly on every change-detection pass:
   * the `loadedCoins` guard makes every call after the first a no-op.
   */
  ensureLoaded(coinId: string | null | undefined): void {
    if (!coinId || this.loadedCoins.has(coinId)) return;
    // Marked BEFORE the await so two near-simultaneous calls (the detail panel
    // and the gallery both opening) cannot both fire the request.
    this.loadedCoins.add(coinId);
    void this.load(coinId);
  }

  /**
   * The render model for one image, looked up by its `data:` URL.
   *
   * Reads from ImageSourcePathRegistry rather than holding its own coin->path
   * map, because that registry is also populated by the batch import — so a
   * photo imported a moment ago shows its path immediately, without waiting
   * for a round trip to the server.
   */
  viewFor(imageData: string): ImagePathView {
    const sourcePath = imageSourcePaths.pathFor(imageData);
    return buildImagePathView(
      sourcePath,
      this.existenceOf(sourcePath),
      path => this.api.imageFileUrl(path)
    );
  }

  /**
   * Do we know a source path for ANY of these images?
   *
   * Lets the detail panel choose between listing the paths and showing a
   * single quiet "no locations recorded" sentence, rather than rendering a
   * column of blank rows for a coin whose photos all predate this feature.
   */
  anyPathRecorded(imagePaths: readonly string[]): boolean {
    return imageSourcePaths.hasAnyPathFor(imagePaths);
  }

  /**
   * What we know about one path. Absent from the map means we have not been
   * told — which is 'unknown', NOT 'missing'. See rule 4.
   */
  existenceOf(sourcePath: string | null): ImageFileExistence {
    if (!sourcePath) return 'unknown';
    const known = this.existenceByPath()[sourcePath];
    if (known === undefined) return 'unknown';
    return known ? 'present' : 'missing';
  }

  /** Drop every cached answer. For tests and for a full inventory reload. */
  reset(): void {
    this.loadedCoins.clear();
    this.existenceByPath.set({});
  }

  /* =========================================================================
   * Internals
   * ======================================================================= */

  private async load(coinId: string): Promise<void> {
    let images: CoinImageRecord[];

    try {
      images = await firstValueFrom(this.api.getCoinImages(coinId));
    } catch (error) {
      // Forget the coin so a later attempt (after the server comes back) can
      // retry. Every path stays 'unknown' in the meantime, which renders as
      // plain text rather than as a false "file is gone".
      this.loadedCoins.delete(coinId);
      this.logger.warn(
        `Could not load image paths for coin ${coinId}`,
        describeHttpError(error)
      );
      return;
    }

    // Remember every path we were told about. This is also what lets an
    // outgoing PUT keep the paths of images it is not changing — see
    // services/image-source-paths.ts.
    imageSourcePaths.recordAll(images);

    // Rule 2: ONE request for the whole coin. De-duplicated here as well as on
    // the server, so the request body stays small.
    const paths = [...new Set(
      images.map(image => image.sourcePath).filter((p): p is string => !!p && p.length > 0)
    )].slice(0, MAX_PATHS_PER_CHECK);

    if (paths.length === 0) return;

    await this.checkExistence(coinId, paths);
  }

  private async checkExistence(coinId: string, paths: string[]): Promise<void> {
    try {
      const response = await firstValueFrom(this.api.checkImagesExist(paths));
      const results = response?.results ?? {};

      // Merge rather than replace: another coin's answers are still valid, and
      // the same file may well be shared between coins.
      this.existenceByPath.update(current => ({ ...current, ...results }));
    } catch (error) {
      // Deliberately record NOTHING. Leaving these paths out of the map keeps
      // them 'unknown', so the UI shows the path as plain text and makes no
      // claim about the file. See rule 4 in the file header.
      this.logger.warn(
        `Could not check original image files for coin ${coinId}`,
        describeHttpError(error)
      );
    }
  }
}
