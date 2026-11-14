import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import {
  CoinRecord,
  Denomination,
  MintMarkOption,
  SpotPrices,
  SpotPriceResult,
  LatestSpotPrices,
  LogEntry
} from '../types/coin.model';
import { CatalogOption } from '../types/catalog-reference';
import {
  DenominationLookupResult,
  IssuerCreationResult,
  IssuerRecord,
  IssuerRemovalResult,
  NewIssuer,
  ReferenceUsageCounts,
} from '../types/reference-data.model';
import { CoinImageRecord } from '../types/coin-image.model';
import {
  BackupDirectoryListing,
  BackupInspection,
  BackupJobStatus,
  BackupSuggestion,
  RestoreResult
} from './backup/backup-messages';
import { describeHttpError, resolveApiBaseUrl, retryTransientFailures } from './http-utils';

// Shared HTTP helpers live in ./http-utils so that a service needing only a
// helper (e.g. LoggingService) can import it without dragging ApiService --
// and therefore Angular's HttpClient/XHR backend -- into the module graph.
// Re-exported here so imports from './api.service' keep working.
export { describeHttpError, resolveApiBaseUrl, retryTransientFailures, isHttpErrorResponse, isRetryableError } from './http-utils';

/**
 * ApiService provides typed HTTP methods for all backend API endpoints.
 *
 * This service acts as the single source of truth for backend communication.
 * All HTTP calls return RxJS Observables that must be subscribed to execute.
 *
 * Usage:
 *   constructor(private api: ApiService) {}
 *
 *   // Subscribe to get data
 *   this.api.getCoins().subscribe({
 *     next: (coins) => console.log('Loaded coins:', coins),
 *     error: (err) => console.error('Failed to load coins:', err)
 *   });
 *
 * The baseUrl is resolved at runtime by `resolveApiBaseUrl()` â€” see that
 * function for the localhost:3000 vs. same-origin rules.
 *
 * Coin writes (POST/PUT/DELETE) are wrapped in `retryTransientFailures()` so a
 * brief backend hiccup does not lose the user's edit.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  /**
   * Base URL for all API calls, resolved once when the service is created.
   * See `resolveApiBaseUrl()` above for the rules.
   */
  private readonly baseUrl = resolveApiBaseUrl();

  constructor(private http: HttpClient) {}

  // ---- Coin Operations ----

  /**
   * Fetch all coins from the inventory.
   *
   * *** THE RETURNED RECORDS HAVE NO `imagePaths` KEY. ***
   *
   * Not an empty array — the key is absent. `GET /api/coins` must not inline
   * photographs: on a collection of ~100 coins the concatenated base64 pushes
   * `JSON.stringify` past V8's maximum string length and it throws
   * `RangeError: Invalid string length`, so the whole response fails with a
   * 500 that looks to the client like a dead database.
   *
   * Every coin still carries `imageCount`, which answers "does this coin have
   * photographs, and how many" for free. The photographs themselves come from
   * `getCoinImages()` below, one coin at a time, and the grid's row
   * thumbnails from `coinThumbnailUrl()`.
   *
   * @returns Observable of coin array, with image counts but no image data
   */
  getCoins(): Observable<CoinRecord[]> {
    return this.http.get<CoinRecord[]>(`${this.baseUrl}/api/coins`);
  }

  /** Fetch a single coin by ID. */
  getCoin(id: string): Observable<CoinRecord> {
    return this.http.get<CoinRecord>(`${this.baseUrl}/api/coins/${id}`);
  }

  /**
   * Create a new coin in the inventory.
   * Retries automatically on network/5xx failures (see retryTransientFailures).
   */
  createCoin(coin: Partial<CoinRecord>): Observable<{ id: string }> {
    return this.http
      .post<{ id: string }>(`${this.baseUrl}/api/coins`, coin)
      .pipe(retryTransientFailures());
  }

  /**
   * Update an existing coin's data.
   *
   * IMPORTANT: `coin` must contain ONLY the fields that actually changed.
   * The backend does a partial update, so sending a whole record would
   * overwrite fields the user never touched. InventoryService.updateCoin()
   * is responsible for computing that minimal diff.
   *
   * Retries automatically on network/5xx failures.
   */
  updateCoin(id: string, coin: Partial<CoinRecord>): Observable<void> {
    return this.http
      .put<void>(`${this.baseUrl}/api/coins/${id}`, coin)
      .pipe(retryTransientFailures());
  }

  /**
   * Delete a coin from the inventory.
   * Retries automatically on network/5xx failures.
   */
  deleteCoin(id: string): Observable<void> {
    return this.http
      .delete<void>(`${this.baseUrl}/api/coins/${id}`)
      .pipe(retryTransientFailures());
  }

  // ---- Coin Image Operations (and the ORIGINAL file behind each image) ----

  /**
   * Fetch the full image records for ONE coin: the displayable base64 data
   * plus, for each one, the absolute path of the original file on the host
   * machine (`sourcePath`, which is null when no path was ever recorded).
   *
   * Called lazily — only when a coin is actually being viewed. `GET /api/coins`
   * can be asked to omit image payloads, so this is the endpoint that fills in
   * the detail for the single coin the user is looking at.
   *
   * @returns Observable of the coin's images, in display order
   */
  getCoinImages(coinId: string): Observable<CoinImageRecord[]> {
    return this.http.get<CoinImageRecord[]>(
      `${this.baseUrl}/api/coins/${encodeURIComponent(coinId)}/images`
    );
  }

  /**
   * The URL of ONE coin's main photograph, as binary image bytes, for the
   * `src` of a grid row thumbnail.
   *
   * *** WHY A URL AND NOT AN OBSERVABLE ***
   *
   * Everything else here fetches data for TypeScript to hold. This returns a
   * string for the BROWSER to fetch, and that difference is the whole point:
   *
   *   - The grid renders these with `loading="lazy"`, so rows below the fold
   *     cost nothing until the user scrolls to them.
   *   - The browser caches each one, so scrolling back up costs a 304 with
   *     an empty body (the server sends `Cache-Control: no-cache` plus an
   *     ETag, so a photograph the user just changed still updates at once).
   *   - Nothing ever concatenates them. A JSON endpoint returning one
   *     thumbnail per coin would rebuild the oversized string that `getCoins`
   *     above exists to avoid; one image per HTTP response cannot, at any
   *     collection size.
   *
   * CALL IT ONLY FOR COINS THAT HAVE PHOTOGRAPHS. `imageCount` comes free on
   * every coin from `getCoins()`, so the grid renders no `<img>` at all for a
   * coin with none and makes no request. The endpoint answers 404 if asked
   * anyway, which is harmless but pointless.
   *
   * The id is URL-encoded: coin ids are free text and a `/` or `?` in one
   * would otherwise change which endpoint is being addressed.
   *
   * *** WHY THERE IS A REVISION PARAMETER ***
   *
   * Because the id alone was not enough, and a broken thumbnail was the
   * result. Attaching a photo repaints the row immediately but PUTs it a
   * second later, so the browser asked for this URL while the server still
   * had no image and got a 404. When the save landed, nothing re-requested:
   * same element, byte-identical URL, and a browser never retries a failed
   * image load. The picture stayed broken until the grid was reloaded.
   *
   * `revision` is the count of SERVER-CONFIRMED changes to that coin's image
   * set this session (services/inventory/coin-thumbnail-revision.ts). A
   * confirmed save therefore produces a URL the browser has never failed on,
   * and it fetches the photograph.
   *
   * REVISION 0 MUST STAY THE BARE URL. A coin whose photographs have not
   * changed keeps one stable URL for the whole session, which is what lets
   * scrolling the grid cost a 304 against the endpoint's ETag instead of
   * re-downloading every visible photograph. Do not "simplify" this by always
   * appending a token, and do not fix caching problems here by turning
   * caching off — see server/routes/coins/thumbnail.ts.
   *
   * @param coinId - the coin whose main photograph is wanted
   * @param revision - confirmed image-write count; 0 (the default) means
   *                   "unchanged since load" and yields the plain URL
   * @returns An absolute, same-origin URL safe to put in `src`
   */
  coinThumbnailUrl(coinId: string, revision = 0): string {
    const url = `${this.baseUrl}/api/coins/${encodeURIComponent(coinId)}/thumbnail`;
    return revision > 0 ? `${url}?v=${revision}` : url;
  }

  /**
   * Ask the backend whether a batch of original image files still exist on
   * disk, in ONE round trip.
   *
   * WHY BATCHED: a coin can easily have eight photos. Eight requests to render
   * one sidebar is wasteful and makes the links pop in one at a time, so the
   * endpoint takes an array and answers with a `path -> boolean` map. The
   * server de-duplicates the list and caps it at 500 paths per request.
   *
   * WHY A POST for what is logically a read: the payload is a list of long
   * Windows paths full of backslashes, colons, spaces and the occasional
   * non-ASCII character. A JSON body has no length limit to run into and no
   * encoding traps; a query string has both.
   *
   * @param paths - Absolute paths to check (max 500)
   * @returns Observable of `{ results: { [path]: boolean } }`
   */
  checkImagesExist(paths: string[]): Observable<{ results: Record<string, boolean> }> {
    return this.http.post<{ results: Record<string, boolean> }>(
      `${this.baseUrl}/api/images/exists`,
      { paths }
    );
  }

  /**
   * Ask which ORIGINAL files are already attached to each of a list of coins,
   * in ONE round trip.
   *
   * WHY THIS EXISTS: the batch image import needs to tell a photo it has
   * already stored from one it has not, and the only thing that identifies a
   * source file is `CoinImages.SourcePath`. That value is not available in
   * the browser — `CoinRecord.imagePaths` carries the downscaled `data:` URLs
   * and nothing else, deliberately (see services/image-source-paths.ts).
   * Without this endpoint, re-importing a folder offers every already-attached
   * photo again.
   *
   * WHY NOT `getCoinImages()` ABOVE: that one is per coin, and a review screen
   * covers ~112 of them. 112 requests to decide what to skip would cost more
   * than the duplicate import did.
   *
   * The response deliberately carries NO `imageData`. Those base64 blobs are
   * the bulk of the database, and this question is about file names.
   *
   * @param coinIds - Coins to ask about (max 500; the server rejects more)
   * @returns Observable of `{ results: { [coinId]: string[] } }`, with an
   *          entry for every id asked about — an empty array means "asked,
   *          nothing attached", which is not the same as a missing key.
   */
  getCoinImageSourcePaths(coinIds: string[]): Observable<{ results: Record<string, string[]> }> {
    return this.http.post<{ results: Record<string, string[]> }>(
      `${this.baseUrl}/api/coins/image-source-paths`,
      { coinIds }
    );
  }

  /**
   * Build the URL that serves an ORIGINAL full-resolution image file.
   *
   * *** WHY THIS GOES THROUGH THE BACKEND INSTEAD OF A `file:///` LINK ***
   *
   * The obvious idea is to render `<a href="file:///C:/Coin Pictures/x.jpg">`.
   * It does not work, and it fails in the most confusing possible way: Chrome
   * and Edge BLOCK navigation from an `http://` page to a `file://` URL, and
   * they block it SILENTLY. The user clicks, nothing happens, and there is not
   * even an error on screen. This is a hard browser security boundary — no
   * attribute, header or setting turns it off — because otherwise any web page
   * could probe your local disk.
   *
   * So the server, which is a normal process on the user's own machine and has
   * no such restriction, opens the file and streams it back with
   * `Content-Disposition: inline`. The browser is then just loading an ordinary
   * `http://` URL from the same origin, which it is perfectly happy to do in a
   * new tab.
   *
   * The path is URL-encoded because it is a Windows path: it contains
   * backslashes and almost always spaces (`\\NAS\Coin Pictures\...`),
   * and `&` or `#` in a filename would otherwise truncate the query string.
   *
   * @param sourcePath - Absolute path of the original file on the host machine
   * @returns An absolute, same-origin URL safe to put in `href`
   */
  imageFileUrl(sourcePath: string): string {
    return `${this.baseUrl}/api/images/file?path=${encodeURIComponent(sourcePath)}`;
  }

  // ---- Denomination Operations ----

  /** Fetch all available denominations (Quarter, Half Dollar, etc.). */
  getDenominations(): Observable<Denomination[]> {
    return this.http.get<Denomination[]>(`${this.baseUrl}/api/denominations`);
  }

  /** Create a new denomination. */
  createDenomination(d: Partial<Denomination>): Observable<Denomination> {
    return this.http.post<Denomination>(`${this.baseUrl}/api/denominations`, d);
  }

  /** Update an existing denomination. */
  updateDenomination(id: number, d: Partial<Denomination>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/denominations/${id}`, d);
  }

  /** Delete a denomination. */
  deleteDenomination(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/denominations/${id}`);
  }

  // ---- Issuer Operations (migration 011, design §4.5a) ----
  // Who struck the coin. These are read ONLY by the reference-data
  // maintenance screen, which is why there is no `issuers` signal on
  // InventoryService to go with them: 61 rows with their usage counts are
  // not worth fetching at startup for the large majority of sessions that
  // never open Settings. The screen loads them when it opens and drops them
  // when it closes.
  // ========================================

  /**
   * Fetch the ACTIVE issuers, each with its denomination and coin counts.
   * @returns Observable of issuer array, in picker order
   */
  getIssuers(): Observable<IssuerRecord[]> {
    return this.http.get<IssuerRecord[]>(`${this.baseUrl}/api/issuers`);
  }

  /**
   * Create an issuer the seed missed — OR BRING A REMOVED ONE BACK.
   *
   * Removal is a SOFT delete, so a removed issuer still holds its name and
   * cannot be re-created alongside itself. Posting that name revives the
   * existing row, keeping its id and its denominations, and the answer
   * carries `revived` and `denominationsRestored` so the caller can say
   * which of the two happened. See `IssuerCreationResult`.
   *
   * The server answers 409 for a name an ACTIVE issuer already holds rather
   * than letting UQ_Issuers_Name turn into a 500, and 400 for an ISO code
   * that is not exactly two letters. Both are expected answers, not faults.
   */
  createIssuer(issuer: NewIssuer): Observable<IssuerCreationResult> {
    return this.http.post<IssuerCreationResult>(`${this.baseUrl}/api/issuers`, issuer);
  }

  /**
   * Edit an issuer IN PLACE, keeping its id.
   *
   * Denominations reference an issuer by id, so remove-and-re-add — which is
   * all the text-keyed lookups offer — would orphan every denomination filed
   * under it.
   */
  updateIssuer(id: number, issuer: NewIssuer): Observable<IssuerRecord> {
    return this.http.put<IssuerRecord>(`${this.baseUrl}/api/issuers/${id}`, issuer);
  }

  /**
   * Remove an issuer, CASCADING to its denominations and their coins.
   *
   * Soft on the server, and atomic: the issuer, its denominations and the
   * `DenominationId` on every coin using them all go in one transaction, so
   * there is no state in which the issuer is gone and live denominations are
   * still filed under it. `Coins.Denomination` — the recorded text — is not
   * touched, which is what lets the caller promise that no coin is lost.
   *
   * It USED TO REFUSE with a 409 while any denomination remained. See the
   * handler in server/routes/lookups/issuers.ts for why that refusal was
   * the bug rather than the safeguard it looked like.
   *
   * The response says what actually happened, so the caller can report that
   * rather than what it predicted in the confirmation.
   */
  deleteIssuer(id: number): Observable<IssuerRemovalResult> {
    return this.http.delete<IssuerRemovalResult>(`${this.baseUrl}/api/issuers/${id}`);
  }

  /**
   * Ask what denominations an issuer struck. THE APP'S ONLY OUTBOUND
   * REQUEST, and it only goes as far as our own server, which forwards the
   * NAME and nothing else to Wikidata.
   *
   * *** CALLING THIS AT ALL IS THE DECISION. *** The checkbox on the issuer
   * form must gate the CALL, not the handling of the answer: "unchecked
   * must skip the request entirely rather than making it and discarding
   * the answer". There is nothing this method or the route behind it can do
   * about a packet that has already left.
   *
   * It does not fail. No network, no results and a timeout all come back as
   * a 200 with an `outcome` saying which — see
   * server/routes/lookups/denomination-lookup.ts for why a 500 would be
   * wrong for the commonest case.
   */
  lookUpDenominations(issuerName: string): Observable<DenominationLookupResult> {
    const name = encodeURIComponent(issuerName);
    return this.http.get<DenominationLookupResult>(`${this.baseUrl}/api/denomination-lookup?name=${name}`);
  }

  /**
   * How many coins use each entry of each reference list.
   *
   * One round trip for all five types. Counted in SQL rather than from the
   * loaded coins because the number shown beside Remove has to be the
   * number of rows Remove will touch, and Remove is a server-side UPDATE —
   * so both have to come from the same place or they can disagree.
   */
  getReferenceUsage(): Observable<ReferenceUsageCounts> {
    return this.http.get<ReferenceUsageCounts>(`${this.baseUrl}/api/reference-usage`);
  }

  // ---- Catalogue Operations ----
  // The reference catalogues a coin can be attributed to -- Sear, RIC,
  // Hendin, Krause. Identical in shape to the denomination and mint-mark
  // calls above and below, on purpose: it is the same kind of lookup table,
  // maintained from the same kind of screen, with the same soft delete.
  // ========================================

  /** Fetch the ACTIVE catalogues, in seeded order. */
  getCatalogs(): Observable<CatalogOption[]> {
    return this.http.get<CatalogOption[]>(`${this.baseUrl}/api/catalogs`);
  }

  /**
   * Create a new catalogue the seed did not include.
   * @param c - Partial catalogue; `name` is required
   */
  createCatalog(c: Partial<CatalogOption>): Observable<CatalogOption> {
    return this.http.post<CatalogOption>(`${this.baseUrl}/api/catalogs`, c);
  }

  /** Rename a catalogue (or change where it sits in the picker). */
  updateCatalog(id: number, c: Partial<CatalogOption>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/catalogs/${id}`, c);
  }

  /**
   * Remove a catalogue. SOFT delete on the server (IsActive = 0), so coins
   * already attributed to it keep reading "Sear 6819" and a mistake is
   * recoverable by reactivating the row.
   */
  deleteCatalog(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/catalogs/${id}`);
  }

  // ---- Mint Mark Operations ----

  /** Fetch all available mint marks (D, S, P, W, etc.). */
  getMintMarks(): Observable<MintMarkOption[]> {
    return this.http.get<MintMarkOption[]>(`${this.baseUrl}/api/mintmarks`);
  }

  /** Create a new mint mark. */
  createMintMark(m: Partial<MintMarkOption>): Observable<MintMarkOption> {
    return this.http.post<MintMarkOption>(`${this.baseUrl}/api/mintmarks`, m);
  }

  /** Update an existing mint mark. */
  updateMintMark(id: number, m: Partial<MintMarkOption>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/mintmarks/${id}`, m);
  }

  /** Delete a mint mark. */
  deleteMintMark(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/mintmarks/${id}`);
  }

  // ---- Category Operations ----

  /** Fetch all available categories. */
  getCategories(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/categories`);
  }

  /** Fetch all canonical metal content values from the database. */
  getMetalContents(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/metalcontents`);
  }

  /** Create a new category. */
  createCategory(name: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/categories`, { name });
  }

  /** Delete a category. */
  deleteCategory(name: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/categories/${name}`);
  }

  // ---- Coin Set Operations ----

  /** Fetch all available coin sets. */
  getCoinSets(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/coin-sets`);
  }

  /** Create a new coin set. */
  createCoinSet(name: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/coin-sets`, { name });
  }

  /** Delete a coin set. */
  deleteCoinSet(name: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/coin-sets/${name}`);
  }

  // ---- Transaction Operations: REMOVED ----
  //
  // getTransactions / createTransaction / deleteTransaction called
  // /api/transactions, which no longer exists. The buy and the sale are
  // ordinary fields on the coin now — purchasedFrom, soldTo,
  // transactionNotes, plus the money and dates that were always there — so
  // they are saved by updateCoin() along with every other field. Do not add
  // a second write path back.

  // ---- Spot Price Operations ----

  /**
   * Fetch current spot prices from external API.
   * This triggers the backend to read live COMEX/NYMEX futures prices.
   */
  fetchSpotPrices(): Observable<SpotPriceResult> {
    return this.http.get<SpotPriceResult>(`${this.baseUrl}/api/spot-prices/fetch`);
  }

  /**
   * Read back the most recently SAVED spot prices from the database.
   *
   * This is the start-up counterpart to fetchSpotPrices() above. That one goes
   * out to COMEX live; this one just reads the newest row of our own
   * SpotPrices history table, which is what lets melt values survive a restart
   * without hitting a third-party API every time the app opens.
   *
   * The route never 404s. When the table is empty it answers 200 with every
   * price zeroed and `source`/`fetchedAt` both null, so callers should test
   * `fetchedAt` rather than the numbers to tell "nothing saved yet" apart from
   * "saved prices that are genuinely zero".
   *
   * @returns Observable of the newest saved prices plus their provenance
   */
  getLatestSpotPrices(): Observable<LatestSpotPrices> {
    return this.http.get<LatestSpotPrices>(`${this.baseUrl}/api/spot-prices/latest`);
  }

  /**
   * Save spot prices to the database.
   *
   * *** THIS INSERTS A NEW HISTORY ROW EVERY TIME IT IS CALLED. ***
   * There is no update-in-place; POST /api/spot-prices is an INSERT (see
   * server/routes/data/spot-prices.ts). That is by design — the table is a
   * price history — but it means this method must only ever be reached from a
   * DELIBERATE user action, never from a signal change or a keystroke.
   * InventoryService.commitSpotPrices() is the only caller and it exists
   * precisely to enforce that; read its comment before adding another.
   *
   * @param prices - Spot prices for gold, silver, platinum, copper, plus an
   *                 optional `source` label recording where they came from
   *                 (e.g. "COMEX/NYMEX futures via Yahoo Finance", "Manual entry")
   * @returns Observable that completes when save is done
   */
  saveSpotPrices(prices: SpotPrices & { source?: string }): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/spot-prices`, prices);
  }

  // ---- Logging Operations ----

  /**
   * Send a log entry to the backend.
   * Used by LoggingService to persist frontend logs.
   */
  postLog(entry: Partial<LogEntry>): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/log`, entry);
  }

  // ---- Health Check ----

  /**
   * Check if the backend API is alive.
   *
   * Hits the dedicated `GET /api/health` endpoint, which returns
   * `200 { status: 'ok' }` when the server and its database are healthy,
   * or `503` when they are not.
   *
   * This observable NEVER errors â€” it always emits a single boolean, which
   * makes it safe to use directly in a template or a simple `if`:
   *
   *   this.api.healthCheck().subscribe(alive => console.log(alive));
   *
   * The pipeline reads as: wait at most 5 seconds (`timeout`), treat any
   * successful response as `true` (`map`), and turn *any* failure â€” timeout,
   * 503, network error â€” into `false` (`catchError` + `of(false)`).
   *
   * @returns Observable that emits true if the backend is available, false otherwise
   */
  healthCheck(): Observable<boolean> {
    return this.http.get<{ status: string }>(`${this.baseUrl}/api/health`).pipe(
      timeout(5000),
      map(() => true),
      catchError(() => of(false))
    );
  }

  // ---- App Info ----

  /**
   * Ask the backend which folder the app itself is installed in, on the machine
   * hosting it.
   *
   * *** WHY THE BROWSER HAS TO ASK ***
   *
   * The batch image import needs one thing a browser will never reveal: where a
   * picked file really lives on disk. A directory picker hands JavaScript only
   * `File.webkitRelativePath` — the path RELATIVE to the chosen folder — so the
   * import screen has to ask the user for the front half of the path. (The full
   * story is in services/image-import/source-path.ts.)
   *
   * The app's own folder is not where the photos are, but it IS a real path
   * on the right machine with the right drive letter, so it is used to
   * prefill that box: the user has something correct to edit instead of an
   * empty one. Once they edit it, their choice is remembered and this value
   * is never consulted again. Do not hardcode a default here -- anything
   * hardcoded is right on one workstation and wrong on the host.
   *
   * *** WHY THIS OBSERVABLE NEVER ERRORS ***
   *
   * Same contract as `healthCheck()` above: any failure — the endpoint missing
   * because the backend has not been rebuilt, a timeout, no server at all —
   * emits `''` rather than propagating. This value is a cosmetic convenience,
   * and an import screen that refused to open because it could not fetch a
   * default would be a plainly bad trade. An empty answer simply leaves the box
   * empty, which the screen already handles: it shows its "no folder given"
   * warning and records no source paths.
   *
   * The 5-second timeout matters for the same reason. Without it a hung request
   * would leave the box empty indefinitely with no explanation.
   *
   * @returns Observable that emits the host-side app folder, or '' on any failure
   */
  getAppFolder(): Observable<string> {
    return this.http.get<{ appFolder?: string }>(`${this.baseUrl}/api/app-info`).pipe(
      timeout(5000),
      // Defensive: an old or proxied backend could answer 200 with a body that
      // has no `appFolder`, and `undefined` must not reach the text box.
      map(info => (typeof info?.appFolder === 'string' ? info.appFolder : '')),
      catchError(() => of(''))
    );
  }

  /* ===================== Backup and restore (§16) =====================
   *
   * *** EVERY ONE OF THESE PROPAGATES ITS ERRORS. ***
   *
   * That is the opposite of `getAppFolder()` and `healthCheck()` just
   * above, and the difference is deliberate. Those two answer cosmetic
   * questions, so swallowing a failure and returning a blank is the right
   * trade — a screen that refused to open because a prefill could not be
   * fetched would be worse than one with an empty box.
   *
   * Nothing here is cosmetic. A backup that silently resolves to "fine"
   * when the server said no is a user who believes they have a copy of
   * their collection and does not. A restore that swallows a 400 is a
   * refusal the user never sees. So these are also NOT wrapped in
   * `retryTransientFailures()`: retrying a restore would mean replacing
   * the collection twice.
   */

  /** Where to put a backup and what to call it. Never cached. */
  getBackupSuggestion(): Observable<BackupSuggestion> {
    return this.http.get<BackupSuggestion>(`${this.baseUrl}/api/backup/suggestion`);
  }

  /**
   * The `*.db` files the SERVER can see in a folder the user named.
   *
   * *** THIS IS HOW THE RESTORE BOX OFFERS A CHOICE AT ALL. *** A browser
   * will not read a folder for a web page, so without this endpoint the
   * only way to name the file that is about to replace an entire
   * collection is to type its path exactly. The server can simply look.
   *
   * Read-only on the server's side (see server/backup/list-db-files.ts
   * for what it will and will not report), but its errors still
   * propagate like the rest of §16: a folder that silently resolves to
   * "no backups here" when the real answer was "that folder does not
   * exist" is how a user concludes their backups are gone.
   */
  listBackupFiles(directory: string): Observable<BackupDirectoryListing> {
    return this.http.get<BackupDirectoryListing>(`${this.baseUrl}/api/backup/files`, {
      params: { directory }
    });
  }

  /** Starts a backup. Resolves with the job's opening status (HTTP 202). */
  startBackup(directory: string, fileName: string): Observable<BackupJobStatus> {
    return this.http.post<BackupJobStatus>(`${this.baseUrl}/api/backup/jobs`, {
      directory,
      fileName
    });
  }

  /** How far the backup has got. Polled by BackupRunner. */
  getBackupJob(id: string): Observable<BackupJobStatus> {
    return this.http.get<BackupJobStatus>(
      `${this.baseUrl}/api/backup/jobs/${encodeURIComponent(id)}`
    );
  }

  /** Asks a running backup to stop. It stops on its next batch. */
  cancelBackup(id: string): Observable<{ accepted: boolean }> {
    return this.http.post<{ accepted: boolean }>(
      `${this.baseUrl}/api/backup/jobs/${encodeURIComponent(id)}/cancel`,
      {}
    );
  }

  /**
   * Looks at a file WITHOUT changing anything, and reports what it is.
   *
   * Answers 200 even for a file that will be refused — the inspection
   * succeeded and its answer is "no" — so the caller reads
   * `decision.acceptable`, not the status code.
   */
  inspectBackup(path: string): Observable<BackupInspection> {
    return this.http.post<BackupInspection>(`${this.baseUrl}/api/restore/inspect`, { path });
  }

  /** *** REPLACES THE COLLECTION. *** The server validates again first. */
  restoreBackup(path: string): Observable<RestoreResult> {
    return this.http.post<RestoreResult>(`${this.baseUrl}/api/restore`, { path });
  }
}

