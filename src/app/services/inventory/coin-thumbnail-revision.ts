import { signal } from '@angular/core';

 /*
  * One number per coin: how many server-confirmed changes to its photos there
  * have been this session. Appended to the grid thumbnail URL.
  *
  * Attaching a photo paints it immediately, so the thumbnail <img> appears and
  * requests `/api/coins/<id>/thumbnail` before the debounced PUT has stored the
  * image, and gets a 404. Browsers never retry a failed image load for an
  * unchanged URL, so the thumbnail would stay broken. Bumping the revision when
  * the server acknowledges the write gives a new URL (`?v=1`) that loads the photo.
  *
  * Revision 0 is the bare URL, so unchanged coins keep one cacheable URL (304s
  * against the endpoint's ETag; see server/routes/coins/thumbnail.ts).
  * Revisions are never reset, even on reload (going back could hit a cached 404).
  *
  * A module-level singleton, like services/image-source-paths.ts, so
  * InventoryService gains no injected dependency.
  */

export class CoinThumbnailRevisionRegistry {
  /** coin id -> confirmed image writes this session. */
  private readonly perCoin = new Map<string, number>();

  /**
   * Bumped on every change so readers re-run; a Map alone is not reactive.
   * `revisionOf()` reads it and `bump()` increments it.
   */
  private readonly revision = signal(0);

  /** This coin's token; 0 when its photos haven't changed since load. */
  revisionOf(coinId: string): number {
    this.revision(); // reactive dependency
    return this.perCoin.get(coinId) ?? 0;
  }

  /**
   * The server confirmed a write that changed this coin's images. Call from the
   * create/update success handler, never from the optimistic paint.
   */
  bump(coinId: string): void {
    if (!coinId) return;
    this.perCoin.set(coinId, (this.perCoin.get(coinId) ?? 0) + 1);
    this.revision.update(n => n + 1);
  }

  /** Forgets everything (tests only). */
  clear(): void {
    if (this.perCoin.size === 0) return;
    this.perCoin.clear();
    this.revision.update(n => n + 1);
  }
}

/**
 * Shared instance: written by CoinEditor when an `imagePaths` write is
 * acknowledged, read by InventoryTable to build thumbnail URLs.
 */
export const coinThumbnailRevisions = new CoinThumbnailRevisionRegistry();

/**
 * Whether a write changed the coin's photos: true when the payload has an
 * `imagePaths` key, the same test `PUT /api/coins/:id` applies (see
 * server/routes/coins/writes.ts).
 */
export function writeTouchesImages(payload: object | null | undefined): boolean {
  if (!payload) return false;
  return Object.prototype.hasOwnProperty.call(payload, 'imagePaths');
}
