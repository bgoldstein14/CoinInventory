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
  LogEntry
} from '../types/coin.model';
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
   * This triggers the backend to call the metals.live API.
   * @returns Observable with spot price result
   */
  fetchSpotPrices(): Observable<SpotPriceResult> {
    return this.http.get<SpotPriceResult>(`${this.baseUrl}/api/spot-prices/fetch`);
  }

  /**
   * Save spot prices to the database.
   * @param prices - Spot prices for gold, silver, platinum, copper
   * @returns Observable that completes when save is done
   */
  saveSpotPrices(prices: SpotPrices): Observable<void> {
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
}
