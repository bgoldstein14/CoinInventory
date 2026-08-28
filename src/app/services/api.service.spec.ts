import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ApiService } from './api.service';
import { of } from 'rxjs';

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
});
