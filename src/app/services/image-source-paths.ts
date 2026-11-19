 /**
  * Side table mapping each displayed image (`data:` URL) to the absolute path of
  * its original file. Kept separate so `CoinRecord.imagePaths` stays a plain
  * string array (it is bound to `<img [src]>` and diffed by the change tracker).
  *
  * `CoinEditor` calls `enrich()` on the way to the server, turning
  *     ["data:...AAA", "data:...BBB"]
  * into the object form the backend also accepts (server/routes/coins/image-payload.ts):
  *     [{ imageData: "data:...AAA", sourcePath: "\\srv\pics\a.jpg" },
  *      { imageData: "data:...BBB", sourcePath: null }]
  *
  * This is an optimisation, not the safety net. `PUT /api/coins/:id` replaces the
  * whole image set, and the server carries existing source paths forward onto
  * entries that supply none (`replaceImages()` in server/routes/coins/write-helpers.ts).
  * `sourcePath: null` means "unknown", not "clear the path"; keep that contract.
  *
  * Populated by the batch import (image-import/source-path.ts) and from
  * `GET /api/coins/:id/images`. In-memory and session-scoped.
  */

import { signal } from '@angular/core';
import { AttachedImage } from '../types/coin-image.model';

/**
 * A plain singleton (`imageSourcePaths` below) rather than an @Injectable, so
 * InventoryService doesn't gain an injected dependency its tests would need to provide.
 */
export class ImageSourcePathRegistry {
  /**
   * imageData (`data:` URL) -> absolute source path. Keyed by image data because
   * at import time the rows have no database id yet.
   */
  private readonly paths = new Map<string, string>();

  /**
   * Bumped on every change so signal readers re-run; a Map alone is not reactive.
   */
  private readonly revision = signal(0);

  /** Records one image's source path. Empty paths are not stored: "unknown" is the absence of an entry. */
  record(imageData: string, sourcePath: string | null | undefined): void {
    if (!imageData) return;
    const trimmed = (sourcePath ?? '').trim();
    if (trimmed.length === 0) return;
    // Skip the revision bump when nothing changed, to avoid re-rendering image rows.
    if (this.paths.get(imageData) === trimmed) return;
    this.paths.set(imageData, trimmed);
    this.revision.update(n => n + 1);
  }

  recordAll(images: readonly { imageData: string; sourcePath: string | null }[]): void {
    for (const image of images) this.record(image.imageData, image.sourcePath);
  }

  /** The known path for this image, or null. */
  pathFor(imageData: string): string | null {
    this.revision(); // reactive dependency
    return this.paths.get(imageData) ?? null;
  }

  /** Returns a new array in the object form, with every known source path attached. */
  enrich(imagePaths: readonly string[]): AttachedImage[] {
    return imagePaths.map(imageData => ({
      imageData,
      sourcePath: this.pathFor(imageData)
    }));
  }

  /**
   * True if a path is known for at least one image. CoinEditor uses this to send
   * the plain string array unless there is something to add.
   */
  hasAnyPathFor(imagePaths: readonly string[]): boolean {
    this.revision(); // reactive dependency
    return imagePaths.some(imageData => this.paths.has(imageData));
  }

  /** Forgets everything (tests only). */
  clear(): void {
    this.paths.clear();
    this.revision.update(n => n + 1);
  }
}

/** Shared instance used by the batch import, CoinImagePathsService and CoinEditor. */
export const imageSourcePaths = new ImageSourcePathRegistry();
