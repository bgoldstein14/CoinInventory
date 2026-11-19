import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ApiService, describeHttpError, resolveApiBaseUrl } from './api.service';
import { defer, firstValueFrom, of, throwError } from 'rxjs';

/**
 * A stand-in for Angular's `HttpErrorResponse`. The real class would pull in the
 * XHR backend (needing the JIT compiler); the helpers identify HTTP errors by
 * their numeric `status`, so a plain object is accurate.
 */
function httpError(status: number, statusText: string, body?: unknown) {
  return { status, statusText, error: body ?? null, name: 'HttpErrorResponse' };
}

/** ApiService takes HttpClient by constructor injection, so a mock is passed directly. */
describe('ApiService', () => {
  let service: ApiService;
  let mockHttpClient: any;

  const baseUrl = 'http://localhost:3000';

  beforeEach(() => {
    mockHttpClient = {
      get: vi.fn(() => of([])),
      post: vi.fn(() => of({})),
      put: vi.fn(() => of({})),
      delete: vi.fn(() => of({})),
    };

    service = new (ApiService as any)(mockHttpClient);
  });

  // Coins

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

  // Categories

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

  // Coin sets

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

  // Transactions are coin fields now; no separate transaction endpoint may exist.

  it('no longer exposes any transaction endpoint', () => {
    const api = service as unknown as Record<string, unknown>;
    expect(api['getTransactions']).toBeUndefined();
    expect(api['createTransaction']).toBeUndefined();
    expect(api['deleteTransaction']).toBeUndefined();
  });

  // Reference data

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

  // Spot prices

  it('fetchSpotPrices calls GET /api/spot-prices/fetch', () => {
    service.fetchSpotPrices();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/spot-prices/fetch`);
  });

  // /fetch calls COMEX live; /latest reads back the newest saved row.
  it('getLatestSpotPrices calls GET /api/spot-prices/latest', () => {
    service.getLatestSpotPrices();
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/spot-prices/latest`);
  });

  it('getLatestSpotPrices passes the saved row straight through', async () => {
    const row = {
      gold: 2600, silver: 30, platinum: 950, copper: 4,
      source: 'COMEX/NYMEX futures via Yahoo Finance',
      fetchedAt: '2026-10-02T14:02:00.000Z'
    };
    mockHttpClient.get = vi.fn(() => of(row));

    await expect(firstValueFrom(service.getLatestSpotPrices())).resolves.toEqual(row);
  });

  it('getLatestSpotPrices surfaces the empty-table answer unchanged', async () => {
    // An empty table gives 200 with zeros and null `fetchedAt`, which callers rely on.
    const empty = { gold: 0, silver: 0, platinum: 0, copper: 0, source: null, fetchedAt: null };
    mockHttpClient.get = vi.fn(() => of(empty));

    await expect(firstValueFrom(service.getLatestSpotPrices())).resolves.toEqual(empty);
  });

  it('saveSpotPrices calls POST /api/spot-prices with the provenance label', () => {
    // Each call inserts a new history row; call only on a deliberate user action.
    service.saveSpotPrices({ gold: 2600, silver: 30, platinum: 950, copper: 4, source: 'Manual entry' });
    expect(mockHttpClient.post).toHaveBeenCalledWith(`${baseUrl}/api/spot-prices`, {
      gold: 2600, silver: 30, platinum: 950, copper: 4, source: 'Manual entry'
    });
  });

  // Logging

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

  // Bounded retry on transient failures

  it('retries a 503 on updateCoin with exponential backoff, then succeeds', async () => {
    vi.useFakeTimers();

    try {
      let attempts = 0;
      // `defer` re-runs the factory on every (re)subscription, so this counts attempts.
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
      // Attach the rejection handler before advancing the timers.
      const assertion = expect(result).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;

      // 1 original attempt + 2 retries.
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // Health check

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

  // App info (image import base-folder prefill)

  it('getAppFolder calls GET /api/app-info and returns the folder', async () => {
    mockHttpClient.get = vi.fn(() => of({ appFolder: 'D:\\CoinInventory', source: 'module' }));

    await expect(firstValueFrom(service.getAppFolder())).resolves.toBe('D:\\CoinInventory');
    expect(mockHttpClient.get).toHaveBeenCalledWith(`${baseUrl}/api/app-info`);
  });

  it('getAppFolder maps any failure to an empty string instead of erroring', async () => {
    // Only a prefill: a missing endpoint or a down server must give '', not an error.
    mockHttpClient.get = vi.fn(() => throwError(() => httpError(404, 'Not Found')));

    await expect(firstValueFrom(service.getAppFolder())).resolves.toBe('');
  });

  it('getAppFolder tolerates a 200 with no appFolder in the body', async () => {
    // A different body shape must not put `undefined` in the text box.
    mockHttpClient.get = vi.fn(() => of({}));

    await expect(firstValueFrom(service.getAppFolder())).resolves.toBe('');
  });

  // Base URL resolution

  it('resolveApiBaseUrl falls back to localhost:3000 outside a browser', () => {
    // Unit tests run in Node, where `window` is undefined.
    expect(resolveApiBaseUrl()).toBe('http://localhost:3000');
  });

  // Error message helper

  it('describeHttpError extracts status, statusText and the server message', () => {
    const error = httpError(409, 'Conflict', { error: 'coin already exists' });

    const message = describeHttpError(error);
    expect(message).toContain('409');
    expect(message).toContain('Conflict');
    expect(message).toContain('coin already exists');
    // Must stay short, not the whole serialised response.
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
