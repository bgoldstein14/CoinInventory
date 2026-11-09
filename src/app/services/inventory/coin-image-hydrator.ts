 /*
 * CoinImageHydrator
 *
 * WHAT THIS FILE OWNS
 *   Fetching ONE coin's photographs on demand and writing them onto the
 *   in-memory record, so the detail panel, the gallery and the full-screen
 *   viewer can go on binding to `coin.imagePaths` exactly as they always did.
 *
 * ---- WHY IT EXISTS ----
 * `GET /api/coins` used to inline every photograph of every coin. At 105
 * coins the response could no longer be built at all: `JSON.stringify` threw
 * `RangeError: Invalid string length`, the client saw a 500 and reported
 * "Failed to connect to database", and the app was unusable. The list now
 * returns `imageCount` and no `imagePaths` key at all.
 *
 * Something has to put the photographs back for the ONE coin the user is
 * actually looking at. That is this.
 *
 * ---- WHY IT HYDRATES THE RECORD RATHER THAN KEEPING ITS OWN CACHE ----
 * `coin.imagePaths` is not only what the screen reads — it is what the WRITE
 * path reads. "Set as main photo", "delete this photo" and "add photos" all
 * build a new array out of it and PUT the result, and `PUT /api/coins/:id`
 * REPLACES the coin's whole image set. A parallel cache would mean two
 * copies of the same list that can disagree, and the first time they
 * disagreed a save would write the wrong set of photographs to the database.
 * One copy, on the record, is the only arrangement with no such failure.
 *
 * ---- HYDRATION IS NOT AN EDIT — THE RULE THAT KEEPS IT SAFE ----
 * This class writes STRAIGHT into the inventory signal. It deliberately does
 * NOT go through CoinEditor.updateCoin(), and it deliberately does not touch
 * CoinChangeTracker:
 *
 *   - Through CoinEditor, hydration would be indistinguishable from the user
 *     editing the photographs. The debounced PUT would fire and send
 *     `imagePaths` back to the server, which would DELETE and re-insert every
 *     image row on a coin the user only looked at. Pointless at best, and one
 *     more chance to lose a photograph at worst.
 *
 *   - The change tracker's job is "what did the server confirm". It is left
 *     alone because it already holds no `imagePaths` entry for these coins
 *     (the list had none to seed it with), so an untouched field can never be
 *     in its dirty set and can never reach a PUT body. Adding the hydrated
 *     value would be truthful but buys nothing, and the one thing it could
 *     conceivably do — clear a dirty flag — is the thing we must not risk.
 *
 * There is a test for every sentence above in
 * services/inventory/coin-image-hydration.spec.ts.
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
    /** The live, on-screen coin list (shared with InventoryService). */
    private readonly inventory: WritableSignal<CoinRecord[]>,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService
  ) {}

   /*
   * coinId -> the request currently IN FLIGHT for it. Nothing else.
   *
   * THERE IS NO "ALREADY FETCHED" CACHE HERE, AND THAT IS THE DESIGN. The
   * record itself is the cache: once the photographs are on `coin.imagePaths`
   * the first branch of load() returns them and no request is made.
   *
   * It matters because the inventory gets REPLACED wholesale — a reconnect, a
   * JSON import, a "Retry connection". A separate "already fetched" set would
   * still say yes for coins whose fresh records have no `imagePaths` key
   * again, and their photographs would never load a second time. Nothing has
   * to remember to invalidate a cache that does not exist.
   *
   * In-flight requests ARE tracked, so the detail panel and the gallery both
   * opening on the same coin share one request instead of racing.
    */
  private readonly inFlight = new Map<string, Promise<string[]>>();

  /**
   * Fetch a coin's photographs and write them onto its record.
   *
   * Resolves with the photographs, in display order.
   *
   * REJECTS when the fetch fails — it does not resolve with `[]`. An empty
   * array means "this coin has no photographs", and callers that are about
   * to SAVE an image array (the batch import's append mode) build the request
   * body out of this answer. Turning a dropped connection into "no
   * photographs" there would delete every picture on the coin.
   */
  load(coinId: string): Promise<string[]> {
    const inFlight = this.inFlight.get(coinId);
    if (inFlight) return inFlight;

    const coin = this.find(coinId);

    // Already loaded — including a genuine empty array. The in-memory copy is
    // also the more current one: the user may have attached a photo a second
    // ago that the server has not been told about yet, and re-reading would
    // throw that away.
    const inMemory = coinImagesInMemory(coin);
    if (inMemory) return Promise.resolve(inMemory);

    // The list already said this coin has nothing. A request cannot improve
    // on that answer. Hydrating with a real empty array lets the gallery show
    // its "attach the first photo" empty state instead of a spinner.
    if (coin && coinPhotoCount(coin) === 0) {
      this.apply(coinId, []);
      return Promise.resolve([]);
    }

    const request = this.fetch(coinId);
    this.inFlight.set(coinId, request);
    return request;
  }

  /**
   * Fire-and-forget version, for callers with nowhere to put a promise — a
   * selection handler, or a template-driven effect.
   *
   * Swallows the failure (it is already logged). The screen shows no
   * photographs and the next attempt re-tries; nothing is written, so
   * nothing can be lost.
   */
  ensure(coinId: string | null | undefined): void {
    if (!coinId) return;
    void this.load(coinId).catch(() => undefined);
  }

  /* ---- Internals ---- */

  private async fetch(coinId: string): Promise<string[]> {
    try {
      const images = await firstValueFrom(this.apiService.getCoinImages(coinId));

      // Remember where each original file lives while we have it. This is
      // what makes the "open the original photo" link work, and what lets an
      // outgoing PUT carry the path back rather than making the server look
      // it up. See services/image-source-paths.ts.
      imageSourcePaths.recordAll(images);

      // SQL already sorted by SortOrder, so recordset order IS display order
      // and position 0 is the coin's main photo.
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
      // Always clear the in-flight entry, success or failure. On success the
      // record now answers; on failure a later attempt must genuinely retry
      // rather than replay this error for the rest of the session.
      this.inFlight.delete(coinId);
    }
  }

  private find(coinId: string): CoinRecord | undefined {
    return this.inventory().find(coin => coin.id === coinId);
  }

  /**
   * Write the photographs onto the record.
   *
   * A plain signal update with no change-tracking and no HTTP: see the
   * "hydration is not an edit" section in the file header. The coin is looked
   * up again here rather than captured earlier, because the fetch is
   * asynchronous and the list may have been replaced while it was in flight —
   * in which case there is nothing to hydrate and we must not resurrect a
   * record that is gone.
   */
  private apply(coinId: string, imagePaths: string[]): void {
    this.inventory.update(coins =>
      coins.map(coin => (coin.id === coinId ? { ...coin, imagePaths } : coin))
    );
  }
}
