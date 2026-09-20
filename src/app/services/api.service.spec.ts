import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ApiService, describeHttpError, resolveApiBaseUrl } from './api.service';
import { defer, firstValueFrom, of, throwError } from 'rxjs';

/**
 * Builds a stand-in for Angular's `HttpErrorResponse`.
 *
 * We deliberately do NOT import the real class: doing so pulls Angular's XHR
 * backend into this test file and it then needs the JIT compiler. The helpers
 * under test identify HTTP errors structurally (by their numeric `status`),
 * so a plain object is an accurate stand-in.
 */
function httpError(status: number, statusText: string, body?: unknown) {
  return { status, statusText, error: body ?? null, name: 'HttpErrorResponse' };
}

/**
 * Tests for ApiService.
 *
 * This service wraps all backend HTTP calls via Angular's HttpClient.
 * It provides methods for:
 * - CRUD operations on coins, categories, coin sets, transactions
 * - Reference data (denominations, mint marks)
 * - Spot price proxy
 * - Logging
 *
 * ApiService uses constructor injection for HttpClient, so we pass a mock
 * HttpClient directly via the constructor for testing.
 */
describe('ApiService', () => {
  let service: ApiService;
  let mockHttpClient: any;

  // All API calls go through baseUrl (http://localhost:3000)
  const baseUrl = 'http://localhost:3000';

  beforeEach(() => {
    // Mock HttpClient
    mockHttpClient = {
      get: vi.fn(() => of([])),
      post: vi.fn(() => of({})),
      put: vi.fn(() => of({})),
      delete: vi.fn(() => of({})),
    };

    // Create service with mocked HttpClient via constructor
    service = new (ApiService as any)(mockHttpClient);
  });

  // --- Coins CRUD ---

  it('getCoins calls GET /api/coins', () => {
    service.getCoins();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/coins`);
  });

  it('createCoin calls POST /api/coins', () => {
    const coin = {
      id: 'c1',
      denomination: 'Quarter',
      year: '1964',
      coinType: 'Washington',
      category: 'Silver',
      country: 'USA',
      grade: 'MS65',
      certCompany: '',
      certNumber: '',
      variety: '',
      mintMark: 'D',
      composition: '',
      purchaseDate: '2024-01-01',
      purchasePrice: 10,
      currentValue: 15,
      notes: '',
      imagePaths: [],
      tags: [],
      source: 'manual' as const,
    };

    service.createCoin(coin);
    expect(mockHttpClient.post).toHaveBeenCalledWith(`${baseUrl}/api/coins`, coin);
  });

  it('updateCoin calls PUT /api/coins/:id', () => {
    service.updateCoin('c1', { currentValue: 20 });
    expect(mockHttpClient.put).toHaveBeenCalledWith(`${baseUrl}/api/coins/c1`, { currentValue: 20 });
  });

  it('deleteCoin calls DELETE /api/coins/:id', () => {
    service.deleteCoin('c1');
    expect(mockHttpClient.delete).toHaveBeenCalledWith(`${baseUrl}/api/coins/c1`);
  });

  // --- Categories ---

  it('getCategories calls GET /api/categories', () => {
    service.getCategories();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/categories`);
  });

  it('createCategory calls POST /api/categories', () => {
    service.createCategory('New Category');
    expect(mockHttpClient.post).toHaveBeenCalledWith(`${baseUrl}/api/categories`, { name: 'New Category' });
  });

  it('deleteCategory calls DELETE /api/categories/:name', () => {
    service.deleteCategory('Old Category');
    expect(mockHttpClient.delete).toHaveBeenCalledWith(`${baseUrl}/api/categories/Old Category`);
  });

  // --- Coin Sets ---

  it('getCoinSets calls GET /api/coin-sets', () => {
    service.getCoinSets();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/coin-sets`);
  });

  it('createCoinSet calls POST /api/coin-sets', () => {
    service.createCoinSet('Morgan Set');
    expect(mockHttpClient.post).toHaveBeenCalledWith(`${baseUrl}/api/coin-sets`, { name: 'Morgan Set' });
  });

  it('deleteCoinSet calls DELETE /api/coin-sets/:name', () => {
    service.deleteCoinSet('Morgan Set');
    expect(mockHttpClient.delete).toHaveBeenCalledWith(`${baseUrl}/api/coin-sets/Morgan Set`);
  });

  // --- Transactions ---

  it('getTransactions calls GET /api/transactions', () => {
    service.getTransactions();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/transactions`);
  });

  it('createTransaction calls POST /api/transactions', () => {
    const txn = {
      id: 't1',
      coinId: 'c1',
      type: 'purchase' as const,
      date: '2024-01-01',
      amount: 100,
      dealer: 'Heritage',
      notes: 'Auction win',
    };

    service.createTransaction(txn);
    expect(mockHttpClient.post).toHaveBeenCalledWith(`${baseUrl}/api/transactions`, txn);
  });

  it('deleteTransaction calls DELETE /api/transactions/:id', () => {
    service.deleteTransaction('t1');
    expect(mockHttpClient.delete).toHaveBeenCalledWith(`${baseUrl}/api/transactions/t1`);
  });

  // --- Reference Data ---

  it('getDenominations calls GET /api/denominations', () => {
    service.getDenominations();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/denominations`);
  });

  it('getMintMarks calls GET /api/mintmarks', () => {
    service.getMintMarks();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/mintmarks`);
  });

  it('getMetalContents calls GET /api/metalcontents', () => {
    service.getMetalContents();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/metalcontents`);
  });

  // --- Spot Prices ---

  it('fetchSpotPrices calls GET /api/spot-prices/fetch', () => {
    service.fetchSpotPrices();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/spot-prices/fetch`);
  });

  // --- Logging ---

  it('postLog calls POST /api/log', () => {
    const logEntry = {
      level: 'INFO' as const,
      message: 'Test log message',
      details: 'Additional context',
      source: 'frontend' as const,
      timestamp: '2024-01-01T12:00:00Z',
    };

    service.postLog(logEntry);
    expect(mockHttpClient.post).toHaveBeenCalledWith(`${baseUrl}/api/log`, logEntry);
  });

  // --- Bounded retry on transient failures ---

  it('retries a 503 on updateCoin with exponential backoff, then succeeds', async () => {
    vi.useFakeTimers();

    try {
      let attempts = 0;
      // `defer` re-runs the factory on every (re)subscription, which is exactly
      // what `retry` does — so this counts real attempts.
      mockHttpClient.put = vi.fn(() =>
        defer(() => {
          attempts++;
          return attempts < 3
            ? throwError(() => httpError(503, 'Service Unavailable'))
            : of(undefined);
        })
      );

      const result = firstValueFrom(service.updateCoin('c1', { grade: 'MS66' }));
      // Backoff is 500ms then 1000ms; 2s covers both.
      await vi.advanceTimersByTimeAsync(2000);

      await expect(result).resolves.toBeUndefined();
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a deterministic 409 conflict', async () => {
    let attempts = 0;
    mockHttpClient.put = vi.fn(() =>
      defer(() => {
        attempts++;
        return throwError(() => httpError(409, 'Conflict'));
      })
    );

    await expect(firstValueFrom(service.updateCoin('c1', { grade: 'MS66' }))).rejects.toBeTruthy();
    expect(attempts).toBe(1);
  });

  it('gives up after a bounded number of retries', async () => {
    vi.useFakeTimers();

    try {
      let attempts = 0;
      mockHttpClient.delete = vi.fn(() =>
        defer(() => {
          attempts++;
          return throwError(() => httpError(0, 'Unknown Error'));
        })
      );

      const result = firstValueFrom(service.deleteCoin('c1'));
      // Attach the rejection handler before advancing so it is never floating.
      const assertion = expect(result).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;

      // 1 original attempt + 2 retries.
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Health check ---

  it('healthCheck calls GET /api/health and maps success to true', async () => {
    mockHttpClient.get = vi.fn(() => of({ status: 'ok' }));

    await expect(firstValueFrom(service.healthCheck())).resolves.toBe(true);
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/health`);
  });

  it('healthCheck maps a failure (e.g. 503) to false instead of erroring', async () => {
    mockHttpClient.get = vi.fn(() =>
      throwError(() => httpError(503, 'Service Unavailable'))
    );

    await expect(firstValueFrom(service.healthCheck())).resolves.toBe(false);
  });

  // --- Base URL resolution ---

  it('resolveApiBaseUrl falls back to localhost:3000 outside a browser', () => {
    // Unit tests run in Node, where `window` is undefined.
    expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
  });

  // --- Error message helper ---

  it('describeHttpError extracts status, statusText and the server message', () => {
    const error = httpError(409, 'Conflict', { error: 'coin already exists' });

    const message = describeHttpError(error);
    expect(message).toContain('409');
    expect(message).toContain('Conflict');
    expect(message).toContain('coin already exists');
    // Must stay short — the old code JSON.stringify'd the whole response.
    expect(message.length).toBeLessThan(120);
  });

  it('describeHttpError reports status 0 as a network error', () => {
    expect(describeHttpError(httpError(0, 'Unknown Error'))).toContain('Network error');
  });

  it('describeHttpError handles plain Errors and unknown values', () => {
    expect(describeHttpError(new Error('boom'))).toBe('boom');
    expect(describeHttpError('just a string')).toBe('just a string');
  });
});
