import { signal } from '@angular/core';

 /*
 * CoinThumbnailRevisionRegistry
 *
 * WHAT THIS FILE OWNS
 *   One number per coin: "how many times has the SERVER confirmed a change to
 *   this coin's photographs since the page loaded?" Nothing else.
 *
 * ---- THE BUG IT FIXES ----
 * The grid's Photo column renders
 *
 *     <img src="/api/coins/<id>/thumbnail" loading="lazy">
 *
 * and that URL used to depend on NOTHING BUT THE COIN ID. Attaching a photo
 * goes through the ordinary edit path, which means:
 *
 *   t+0ms     the new imagePaths array is painted on screen optimistically,
 *             so `hasPhoto(coin)` flips to true and the <img> appears,
 *   t+0ms     the browser immediately requests the thumbnail — and the
 *             server has not been told about the photograph yet, so it
 *             answers 404 ("No thumbnail available for coin ..."),
 *   t+1000ms  the debounced PUT finally fires and the image is stored.
 *
 * At that point the picture exists but the <img> is already broken, and
 * NOTHING re-requests it: the element is unchanged, the URL is byte-identical,
 * and a browser never retries a failed image load on its own. The thumbnail
 * stays broken until the grid is reloaded. (Negative HTTP caching of that 404
 * makes it worse — a re-render of the identical URL can be served the cached
 * failure — but it is not the cause: the race is.)
 *
 * ---- THE FIX, AND WHY IT IS SHAPED THIS WAY ----
 * The URL now carries a revision token that is bumped ONLY when the server
 * has ACKNOWLEDGED a write that changed the coin's image set. Bumping it at
 * paint time would be useless: that is precisely the moment the server does
 * not have the picture yet.
 *
 * So the sequence becomes: 404 against `.../thumbnail`, then — when the PUT
 * lands — `.../thumbnail?v=1`, a URL the browser has never seen, which it
 * therefore fetches and gets the photograph.
 *
 * Revision 0 renders the BARE url, exactly as before. That matters: a coin
 * whose photographs never change keeps one stable URL all session, so
 * scrolling the grid still costs a 304 with an empty body against the ETag
 * the thumbnail endpoint relies on (see server/routes/coins/thumbnail.ts).
 * Disabling caching instead would re-download every visible photograph on
 * every scroll.
 *
 * Revisions are never reset, not even when the whole list is reloaded from
 * the server. Going back to `?v=0` would mean going back to a URL whose last
 * response may have been a 404, which is the bug again.
 *
 * ---- WHY A MODULE-LEVEL SINGLETON AND NOT AN @Injectable ----
 * Same reason as services/image-source-paths.ts, whose revision-counter idiom
 * this file follows deliberately rather than inventing a second one:
 * `InventoryService` must stay constructible from an injection context that
 * provides only ApiService, LoggingService and NotificationService, and this
 * class has no dependencies of its own.
  */

export class CoinThumbnailRevisionRegistry {
  /** coin id -> how many confirmed image writes it has had this session. */
  private readonly perCoin = new Map<string, number>();

  /**
   * Bumped every time the map changes, purely so Angular knows to re-render.
   *
   * A `Map` is invisible to Angular's reactivity, so a template that read it
   * directly would be evaluated once and never again — and "never again" is
   * exactly the bug this file exists to fix. `revisionOf()` touches this
   * signal, which makes every caller depend on it, and `bump()` increments
   * it. (Signals work perfectly well outside dependency injection.)
   */
  private readonly revision = signal(0);

  /**
   * This coin's current token: 0 for a coin whose photographs have not
   * changed since the page loaded.
   */
  revisionOf(coinId: string): number {
    this.revision(); // subscribe: re-run me when any coin's images change
    return this.perCoin.get(coinId) ?? 0;
  }

  /**
   * The server has confirmed a write that changed this coin's image set.
   *
   * Call this from the SUCCESS handler of a create/update, never from the
   * optimistic paint — see the file header.
   */
  bump(coinId: string): void {
    if (!coinId) return;
    this.perCoin.set(coinId, (this.perCoin.get(coinId) ?? 0) + 1);
    this.revision.update(n => n + 1);
  }

  /** Forget everything. Used by tests; the app has no reason to call it. */
  clear(): void {
    if (this.perCoin.size === 0) return;
    this.perCoin.clear();
    this.revision.update(n => n + 1);
  }
}

/**
 * The one instance the whole app shares: written by CoinEditor when a write
 * carrying `imagePaths` is acknowledged, read by InventoryTable when it builds
 * a row's thumbnail URL.
 */
export const coinThumbnailRevisions = new CoinThumbnailRevisionRegistry();

/**
 * Did this write change the coin's photographs?
 *
 * A payload only touches the image set when it actually carries an
 * `imagePaths` KEY — `PUT /api/coins/:id` replaces the images if and only if
 * that key is present (see server/routes/coins/writes.ts), so this is the
 * same test the server applies, and a grade-only edit does not invalidate a
 * perfectly good cached thumbnail.
 */
export function writeTouchesImages(payload: object | null | undefined): boolean {
  if (!payload) return false;
  return Object.prototype.hasOwnProperty.call(payload, 'imagePaths');
}
