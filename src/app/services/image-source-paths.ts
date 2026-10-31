/* ===========================================================================
 * ImageSourcePathRegistry
 * ---------------------------------------------------------------------------
 * A side table: "for this displayed image, where did the original file live?"
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM IT SOLVES
 * ---------------------------------------------------------------------------
 * An image now has two pieces of information: the downscaled `data:` URL we
 * show, and the absolute path of the full-size original on the host machine.
 *
 * The obvious move would be to widen `CoinRecord.imagePaths` from `string[]` to
 * an array of objects. That is a bad trade here, because `imagePaths` is bound
 * directly to `<img [src]>` in four places (the gallery, the photo viewer, the
 * table thumbnail, the report), and it is one of the fields the change tracker
 * diffs. Turning its entries into objects would touch all of that, and a
 * mistake in the change-tracking path is how the user previously lost data.
 *
 * So `imagePaths` keeps holding plain strings, and the paths live here,
 * keyed by the image data itself. `CoinEditor` then calls `enrich()` on its way
 * out to the server, turning
 *
 *     imagePaths: ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"]
 *
 * into the object form the backend also accepts (see
 * server/routes/coins/image-payload.ts):
 *
 *     imagePaths: [{ imageData: "data:...AAA", sourcePath: "\\\\srv\\pics\\a.jpg" },
 *                  { imageData: "data:...BBB", sourcePath: null }]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ALSO PREVENTS A DATA-LOSS BUG
 * ---------------------------------------------------------------------------
 * `PUT /api/coins/:id` REPLACES a coin's whole image set (it deletes the rows
 * and re-inserts them). Any entry sent as a bare string comes back with
 * `SourcePath NULL`. So without this registry, re-ordering or deleting ONE
 * photo — both of which send the full `imagePaths` array — would quietly wipe
 * the recorded paths of every other photo on that coin. Enriching every
 * outgoing array from a single place means a path, once known, survives all of
 * those operations.
 *
 * The registry is populated from both ends:
 *   - the batch import, which has just computed the path (see
 *     services/image-import/source-path.ts), and
 *   - the viewer, which learns paths from `GET /api/coins/:id/images`.
 *
 * It is in-memory and session-scoped. Losing it costs nothing: the paths are
 * in the database, and the next fetch re-populates it. `enrich()` degrades to
 * "sourcePath: null" for anything it has never been told about, which is the
 * same as the pre-existing behaviour.
 * =========================================================================== */

import { signal } from '@angular/core';
import { AttachedImage } from '../types/coin-image.model';

/**
 * Deliberately NOT an Angular `@Injectable`.
 *
 * `InventoryService` has to stay constructible from an injection context that
 * provides only ApiService, LoggingService and NotificationService — that is
 * rule 1 in its file header, and it is how every existing test builds it.
 * Adding a fourth injected dependency would break all of them. This class has
 * no dependencies of its own (it is a Map and four methods), so a plain
 * module-level singleton, `imageSourcePaths` at the bottom of this file, gives
 * the same single-shared-instance guarantee with none of the wiring.
 */
export class ImageSourcePathRegistry {
  /**
   * imageData (`data:` URL) -> absolute source path.
   *
   * Keyed by the image data rather than by a database id on purpose: at import
   * time there is no id yet (the rows have not been written), and the data URL
   * is the only thing that identifies the image on both sides of the wire.
   * The keys are long strings, but there are only ever a few hundred of them
   * and the values are already held in memory by the coin records anyway.
   */
  private readonly paths = new Map<string, string>();

  /**
   * Bumped every time the map changes, purely so Angular knows to re-render.
   *
   * A `Map` is invisible to Angular's reactivity: a `computed()` that reads it
   * would be evaluated once and then never again, so a path that arrives from
   * the server a moment after the panel rendered would never appear on screen.
   * The readers below touch this signal, which makes them depend on it, and
   * the writers increment it. (Signals work perfectly well outside dependency
   * injection — `signal()` is just a function.)
   */
  private readonly revision = signal(0);

  /**
   * Remember where one image came from. A null/empty path is simply not
   * recorded — "unknown" is the absence of an entry, so there is exactly one
   * representation of it.
   */
  record(imageData: string, sourcePath: string | null | undefined): void {
    if (!imageData) return;
    const trimmed = (sourcePath ?? '').trim();
    if (trimmed.length === 0) return;
    // Nothing changed? Don't bump the revision — a pointless re-render of every
    // gallery row is not free when each row holds a base64 image.
    if (this.paths.get(imageData) === trimmed) return;
    this.paths.set(imageData, trimmed);
    this.revision.update(n => n + 1);
  }

  /** Record a whole batch at once. */
  recordAll(images: readonly { imageData: string; sourcePath: string | null }[]): void {
    for (const image of images) this.record(image.imageData, image.sourcePath);
  }

  /** The path we know for this image, or null if we have never been told. */
  pathFor(imageData: string): string | null {
    this.revision(); // subscribe: re-run me when a path is recorded
    return this.paths.get(imageData) ?? null;
  }

  /**
   * Turn a plain `imagePaths` array into the object form, attaching every
   * source path we know about.
   *
   * Returns a NEW array; the input is left untouched, because the caller's copy
   * is the one bound to the screen.
   */
  enrich(imagePaths: readonly string[]): AttachedImage[] {
    return imagePaths.map(imageData => ({
      imageData,
      sourcePath: this.pathFor(imageData)
    }));
  }

  /**
   * True if we know a path for at least one of these images — i.e. if
   * enriching the array would actually carry any information.
   *
   * `CoinEditor` uses this to leave the request body completely untouched when
   * there is nothing to add, so the compatibility path (a plain array of
   * strings, which is what the server has always received) stays the norm and
   * the object form only appears when it is needed.
   */
  hasAnyPathFor(imagePaths: readonly string[]): boolean {
    this.revision(); // subscribe: re-run me when a path is recorded
    return imagePaths.some(imageData => this.paths.has(imageData));
  }

  /** Forget everything. Used by tests; the app has no reason to call it. */
  clear(): void {
    this.paths.clear();
    this.revision.update(n => n + 1);
  }
}

/**
 * The one instance the whole app shares.
 *
 * Imported directly by the batch import (which records paths), by
 * CoinImagePathsService (which learns them from the server) and by CoinEditor
 * (which attaches them to outgoing requests).
 */
export const imageSourcePaths = new ImageSourcePathRegistry();
