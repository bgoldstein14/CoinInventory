 /**
  * Loads each image's recorded source path and checks whether those files
  * still exist, for the "open the original photo" links.
  *
  *   GET  /api/coins/:id/images   recorded sourcePath for each image
  *   POST /api/images/exists      whether each file still exists
  *
  * - Lazy: nothing is fetched until a coin is viewed.
  * - One existence request per coin, not per image.
  * - Cached for the session: images per coin id, existence per path (the same
  *   file can be the source of several images).
  * - A failed request leaves existence 'unknown' (path shown as plain text),
  *   never 'missing'.
  */

import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { describeHttpError } from './http-utils';
import { imageSourcePaths } from './image-source-paths';
import { CoinImageRecord, ImageFileExistence } from '../types/coin-image.model';
import { buildImagePathView, ImagePathView } from '../features/inventory/image-path-display';

/** Server limit on paths per request; guards against a pathological record. */
const MAX_PATHS_PER_CHECK = 500;

@Injectable({ providedIn: 'root' })
export class CoinImagePathsService {
  private readonly api = inject(ApiService);
  private readonly logger = inject(LoggingService);

  /** path -> exists. A path absent from the map is 'unknown'. */
  private readonly existenceByPath = signal<Record<string, boolean>>({});

  /** Coins already fetched or in flight, so re-selecting a coin issues no requests. */
  private readonly loadedCoins = new Set<string>();

  /** Fetches and checks a coin's image paths once; later calls are no-ops. */
  ensureLoaded(coinId: string | null | undefined): void {
    if (!coinId || this.loadedCoins.has(coinId)) return;
    // Marked before the await so concurrent callers don't both fetch.
    this.loadedCoins.add(coinId);
    void this.load(coinId);
  }

  /**
   * Render model for one image, looked up by its `data:` URL. Reads the shared
   * ImageSourcePathRegistry, so paths from a just-finished batch import show at once.
   */
  viewFor(imageData: string): ImagePathView {
    const sourcePath = imageSourcePaths.pathFor(imageData);
    return buildImagePathView(
      sourcePath,
      this.existenceOf(sourcePath),
      path => this.api.imageFileUrl(path)
    );
  }

  /** Whether any of these images has a known source path (else the panel shows "no locations recorded"). */
  anyPathRecorded(imagePaths: readonly string[]): boolean {
    return imageSourcePaths.hasAnyPathFor(imagePaths);
  }

  /** Existence of one path; absent from the map means 'unknown', not 'missing'. */
  existenceOf(sourcePath: string | null): ImageFileExistence {
    if (!sourcePath) return 'unknown';
    const known = this.existenceByPath()[sourcePath];
    if (known === undefined) return 'unknown';
    return known ? 'present' : 'missing';
  }

  /** Clears all cached answers (tests and full inventory reload). */
  reset(): void {
    this.loadedCoins.clear();
    this.existenceByPath.set({});
  }

  private async load(coinId: string): Promise<void> {
    let images: CoinImageRecord[];

    try {
      images = await firstValueFrom(this.api.getCoinImages(coinId));
    } catch (error) {
      // Forget the coin so a later attempt can retry; paths stay 'unknown'.
      this.loadedCoins.delete(coinId);
      this.logger.warn(
        `Could not load image paths for coin ${coinId}`,
        describeHttpError(error)
      );
      return;
    }

    // Also lets an outgoing PUT keep paths of unchanged images (see image-source-paths.ts).
    imageSourcePaths.recordAll(images);

    // One request for the whole coin, de-duplicated.
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

      // Merge: other coins' answers stay valid.
      this.existenceByPath.update(current => ({ ...current, ...results }));
    } catch (error) {
      // Record nothing, so these paths stay 'unknown'.
      this.logger.warn(
        `Could not check original image files for coin ${coinId}`,
        describeHttpError(error)
      );
    }
  }
}
