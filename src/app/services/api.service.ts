import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, timeout } from 'rxjs/operators';
import {
  CoinRecord,
  Denomination,
  MintMarkOption,
  TransactionRecord,
  SpotPrices,
  SpotPriceResult,
  LatestSpotPrices,
  LogEntry
} from '../types/coin.model';
import { CoinImageRecord } from '../types/coin-image.model';
import { describeHttpError, resolveApiBaseUrl, retryTransientFailures } from './http-utils';

// ============================================================================
// Shared helpers
// ============================================================================
// These used to be defined here. They now live in ./http-utils so that
// services which only need a helper (e.g. LoggingService) can import it
// without dragging ApiService -- and therefore Angular's HttpClient/XHR
// backend -- into the module graph. Re-exported so existing imports of
// `describeHttpError` / `resolveApiBaseUrl` / `retryTransientFailures` from
// './api.service' keep working unchanged.
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

  // ========================================
  // Coin Operations
  // ========================================

  /**
   * Fetch all coins from the inventory.
   * @returns Observable of coin array
   */
  getCoins(): Observable<CoinRecord[]> {
    return this.http.get<CoinRecord[]>(`${this.baseUrl}/api/coins`);
  }

  /**
   * Fetch a single coin by ID.
   * @param id - The coin's unique identifier
   * @returns Observable of the coin record
   */
  getCoin(id: string): Observable<CoinRecord> {
    return this.http.get<CoinRecord>(`${this.baseUrl}/api/coins/${id}`);
  }

  /**
   * Create a new coin in the inventory.
   * Retries automatically on network/5xx failures (see retryTransientFailures).
   * @param coin - Partial coin record with required fields
   * @returns Observable with the newly created coin's ID
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
   *
   * @param id - The coin's unique identifier
   * @param coin - Partial coin record containing ONLY changed fields
   * @returns Observable that completes when update is done
   */
  updateCoin(id: string, coin: Partial<CoinRecord>): Observable<void> {
    return this.http
      .put<void>(`${this.baseUrl}/api/coins/${id}`, coin)
      .pipe(retryTransientFailures());
  }

  /**
   * Delete a coin from the inventory.
   * Retries automatically on network/5xx failures.
   * @param id - The coin's unique identifier
   * @returns Observable that completes when deletion is done
   */
  deleteCoin(id: string): Observable<void> {
    return this.http
      .delete<void>(`${this.baseUrl}/api/coins/${id}`)
      .pipe(retryTransientFailures());
  }

  // ========================================
  // Coin Image Operations (and the ORIGINAL file behind each image)
  // ========================================

  /**
   * Fetch the full image records for ONE coin: the displayable base64 data
   * plus, for each one, the absolute path of the original file on the host
   * machine (`sourcePath`, which is null when no path was ever recorded).
   *
   * Called lazily — only when a coin is actually being viewed. `GET /api/coins`
   * can be asked to omit image payloads, so this is the endpoint that fills in
   * the detail for the single coin the user is looking at.
   *
   * @param coinId - The coin's unique identifier
   * @returns Observable of the coin's images, in display order
   */
  getCoinImages(coinId: string): Observable<CoinImageRecord[]> {
    return this.http.get<CoinImageRecord[]>(
      `${this.baseUrl}/api/coins/${encodeURIComponent(coinId)}/images`
    );
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
   * backslashes and almost always spaces (`\\192.168.0.10\Coin Pictures\...`),
   * and `&` or `#` in a filename would otherwise truncate the query string.
   *
   * @param sourcePath - Absolute path of the original file on the host machine
   * @returns An absolute, same-origin URL safe to put in `href`
   */
  imageFileUrl(sourcePath: string): string {
    return `${this.baseUrl}/api/images/file?path=${encodeURIComponent(sourcePath)}`;
  }

  // ========================================
  // Denomination Operations
  // ========================================

  /**
   * Fetch all available denominations (Quarter, Half Dollar, etc.).
   * @returns Observable of denomination array
   */
  getDenominations(): Observable<Denomination[]> {
    return this.http.get<Denomination[]>(`${this.baseUrl}/api/denominations`);
  }

  /**
   * Create a new denomination.
   * @param d - Partial denomination with required fields
   * @returns Observable with the newly created denomination
   */
  createDenomination(d: Partial<Denomination>): Observable<Denomination> {
    return this.http.post<Denomination>(`${this.baseUrl}/api/denominations`, d);
  }

  /**
   * Update an existing denomination.
   * @param id - The denomination's ID
   * @param d - Partial denomination with fields to update
   * @returns Observable that completes when update is done
   */
  updateDenomination(id: number, d: Partial<Denomination>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/denominations/${id}`, d);
  }

  /**
   * Delete a denomination.
   * @param id - The denomination's ID
   * @returns Observable that completes when deletion is done
   */
  deleteDenomination(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/denominations/${id}`);
  }

  // ========================================
  // Mint Mark Operations
  // ========================================

  /**
   * Fetch all available mint marks (D, S, P, W, etc.).
   * @returns Observable of mint mark array
   */
  getMintMarks(): Observable<MintMarkOption[]> {
    return this.http.get<MintMarkOption[]>(`${this.baseUrl}/api/mintmarks`);
  }

  /**
   * Create a new mint mark.
   * @param m - Partial mint mark with required fields
   * @returns Observable with the newly created mint mark
   */
  createMintMark(m: Partial<MintMarkOption>): Observable<MintMarkOption> {
    return this.http.post<MintMarkOption>(`${this.baseUrl}/api/mintmarks`, m);
  }

  /**
   * Update an existing mint mark.
   * @param id - The mint mark's ID
   * @param m - Partial mint mark with fields to update
   * @returns Observable that completes when update is done
   */
  updateMintMark(id: number, m: Partial<MintMarkOption>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/mintmarks/${id}`, m);
  }

  /**
   * Delete a mint mark.
   * @param id - The mint mark's ID
   * @returns Observable that completes when deletion is done
   */
  deleteMintMark(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/mintmarks/${id}`);
  }

  // ========================================
  // Category Operations
  // ========================================

  /**
   * Fetch all available categories.
   * @returns Observable of category name array
   */
  getCategories(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/categories`);
  }

  /**
   * Fetch all canonical metal content values from the database.
   * @returns Observable of metal content name array
   */
  getMetalContents(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/metalcontents`);
  }

  /**
   * Create a new category.
   * @param name - Category name
   * @returns Observable that completes when creation is done
   */
  createCategory(name: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/categories`, { name });
  }

  /**
   * Delete a category.
   * @param name - Category name
   * @returns Observable that completes when deletion is done
   */
  deleteCategory(name: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/categories/${name}`);
  }

  // ========================================
  // Coin Set Operations
  // ========================================

  /**
   * Fetch all available coin sets.
   * @returns Observable of coin set name array
   */
  getCoinSets(): Observable<string[]> {
    return this.http.get<string[]>(`${this.baseUrl}/api/coin-sets`);
  }

  /**
   * Create a new coin set.
   * @param name - Coin set name
   * @returns Observable that completes when creation is done
   */
  createCoinSet(name: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/coin-sets`, { name });
  }

  /**
   * Delete a coin set.
   * @param name - Coin set name
   * @returns Observable that completes when deletion is done
   */
  deleteCoinSet(name: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/coin-sets/${name}`);
  }

  // ========================================
  // Transaction Operations
  // ========================================

  /**
   * Fetch transactions, optionally filtered by coin ID.
   * @param coinId - Optional coin ID to filter transactions
   * @returns Observable of transaction array
   */
  getTransactions(coinId?: string): Observable<TransactionRecord[]> {
    const url = coinId
      ? `${this.baseUrl}/api/transactions?coinId=${coinId}`
      : `${this.baseUrl}/api/transactions`;
    return this.http.get<TransactionRecord[]>(url);
  }

  /**
   * Create a new transaction record.
   * @param t - Partial transaction with required fields
   * @returns Observable that completes when creation is done
   */
  createTransaction(t: Partial<TransactionRecord>): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/transactions`, t);
  }

  /**
   * Delete a transaction.
   * @param id - The transaction's unique identifier
   * @returns Observable that completes when deletion is done
   */
  deleteTransaction(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/transactions/${id}`);
  }

  // ========================================
  // Spot Price Operations
  // ========================================

  /**
   * Fetch current spot prices from external API.
   * This triggers the backend to read live COMEX/NYMEX futures prices.
   * @returns Observable with spot price result
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

  // ========================================
  // Logging Operations
  // ========================================

  /**
   * Send a log entry to the backend.
   * Used by LoggingService to persist frontend logs.
   * @param entry - Partial log entry with required fields
   * @returns Observable that completes when log is saved
   */
  postLog(entry: Partial<LogEntry>): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/api/log`, entry);
  }

  // ========================================
  // Health Check
  // ========================================

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

  // ========================================
  // App Info
  // ========================================

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
   * That box used to be prefilled with a hardcoded UNC path, which was right on
   * the developer's workstation and wrong on the host, and then with nothing at
   * all. It is now prefilled with this endpoint's answer: the app's own folder
   * is not where the photos are, but it IS a real path on the right machine with
   * the right drive letter, so the user has something correct to edit instead of
   * an empty box. Once they edit it, their choice is remembered and this value
   * is never consulted again.
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
}

