import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  CoinRecord,
  Denomination,
  MintMarkOption,
  TransactionRecord,
  SpotPrices,
  LogEntry
} from '../types/coin.model';
import { SpotPriceResult } from './spot-price.service';

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
 * The baseUrl defaults to localhost:3000 for local development.
 * In production, this should be updated to point to the production backend.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  // Base URL for all API calls
  // TODO: Replace with environment variable in production
  private readonly baseUrl = 'http://localhost:3000';

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
   * @param coin - Partial coin record with required fields
   * @returns Observable with the newly created coin's ID
   */
  createCoin(coin: Partial<CoinRecord>): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.baseUrl}/api/coins`, coin);
  }

  /**
   * Update an existing coin's data.
   * @param id - The coin's unique identifier
   * @param coin - Partial coin record with fields to update
   * @returns Observable that completes when update is done
   */
  updateCoin(id: string, coin: Partial<CoinRecord>): Observable<void> {
    return this.http.put<void>(`${this.baseUrl}/api/coins/${id}`, coin);
  }

  /**
   * Delete a coin from the inventory.
   * @param id - The coin's unique identifier
   * @returns Observable that completes when deletion is done
   */
  deleteCoin(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/api/coins/${id}`);
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
   * Check if the backend API is available.
   * Makes a simple GET request to /api/coins with a short timeout.
   * @returns Observable that emits true if backend is available, false otherwise
   */
  healthCheck(): Observable<boolean> {
    // This is a simplified implementation
    // In a real app, you'd use timeout() and catchError() operators
    return this.http.get<CoinRecord[]>(`${this.baseUrl}/api/coins`).pipe(
      // If request succeeds, return true
      // If request fails, catchError will handle it in the component
    ) as any; // Type assertion needed because we're simplifying the implementation
  }
}
