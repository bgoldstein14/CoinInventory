 /*
  * Fetches one coin's photos on demand and writes them onto its in-memory record,
  * so the detail panel, gallery and viewer keep binding to `coin.imagePaths`.
  * `GET /api/coins` returns only `imageCount` (inlining every photo made the
  * response too large to serialise).
  *
  * The record itself holds the photos, not a separate cache: the write paths
  * (set main photo, delete, add) build their PUT from `coin.imagePaths`, and the
  * PUT replaces the whole image set, so two copies could save the wrong set.
  *
  * Hydration is not an edit: it writes straight into the inventory signal,
  * bypassing CoinEditor (which would PUT the images back, deleting and
  * re-inserting every row) and CoinChangeTracker (which has no `imagePaths`
  * entry for these coins, so the field can't become dirty). Tested in
  * inventory/coin-image-hydration.spec.ts.
  */

import { WritableSignal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CoinRecord } from '../../types/coin.model';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { coinImagesInMemory, coinPhotoCount } from '../coin-photos';
import { imageSourcePaths } from '../image-source-paths';

export class CoinImageHydrator {
  constructor(
    /** The on-screen coin list (shared with InventoryService). */
    private readonly inventory: WritableSignal<CoinRecord[]>,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService
  ) {}

   /*
    * coinId -> request in flight, so concurrent callers share one request. There
    * is no "already fetched" cache: the record is the cache, and the inventory is
    * replaced wholesale on reconnect or import, so a separate set would go stale.
    */
  private readonly inFlight = new Map<string, Promise<string[]>>();

  /**
   * Fetches a coin's photos (in display order) and writes them onto its record.
   * Rejects on failure rather than resolving `[]`: callers about to save an image
   * array (e.g. the batch import's append mode) would otherwise delete every photo.
   */
  load(coinId: string): Promise<string[]> {
    const inFlight = this.inFlight.get(coinId);
    if (inFlight) return inFlight;

    const coin = this.find(coinId);

    // Already loaded (including a genuine empty array), and more current than the
    // server if the user just attached a photo.
    const inMemory = coinImagesInMemory(coin);
    if (inMemory) return Promise.resolve(inMemory);

    // The list said there are none. An empty array shows the gallery's empty state
    // rather than a spinner.
    if (coin && coinPhotoCount(coin) === 0) {
      this.apply(coinId, []);
      return Promise.resolve([]);
    }

    const request = this.fetch(coinId);
    this.inFlight.set(coinId, request);
    return request;
  }

  /**
   * Fire-and-forget version for selection handlers and effects. Swallows the
   * (already logged) failure; nothing is written, and the next attempt retries.
   */
  ensure(coinId: string | null | undefined): void {
    if (!coinId) return;
    void this.load(coinId).catch(() => undefined);
  }

  /* Internals */

  private async fetch(coinId: string): Promise<string[]> {
    try {
      const images = await firstValueFrom(this.apiService.getCoinImages(coinId));

      // Record each original file's path (for "open the original" links and for
      // outgoing PUTs; see services/image-source-paths.ts).
      imageSourcePaths.recordAll(images);

      // SQL sorts by SortOrder, so position 0 is the main photo.
      const paths = images.map(image => image.imageData);
      this.apply(coinId, paths);
      return paths;
    } catch (error) {
      this.logger.warn(
        `Could not load photographs for coin ${coinId}`,
        describeHttpError(error)
      );
      throw error;
    } finally {
      // Always clear the in-flight entry so a later attempt genuinely retries.
      this.inFlight.delete(coinId);
    }
  }

  private find(coinId: string): CoinRecord | undefined {
    return this.inventory().find(coin => coin.id === coinId);
  }

  /**
   * Writes the photos onto the record: a plain signal update with no change
   * tracking or HTTP. The coin is looked up again because the list may have been
   * replaced during the fetch; a vanished record is not recreated.
   */
  private apply(coinId: string, imagePaths: string[]): void {
    this.inventory.update(coins =>
      coins.map(coin => (coin.id === coinId ? { ...coin, imagePaths } : coin))
    );
  }
}
