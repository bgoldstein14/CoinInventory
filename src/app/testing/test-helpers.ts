/**
 * Test helpers that create inject()-based services (InventoryService,
 * SpotPriceService) inside an injection context with mock dependencies.
 */
import { Injector, runInInjectionContext } from '@angular/core';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { StorageService } from '../services/storage.service';
import { ApiService } from '../services/api.service';
import { LoggingService } from '../services/logging.service';
import { NotificationService } from '../services/notification.service';
import { InventoryService } from '../services/inventory.service';
import { SpotPriceService } from '../services/spot-price.service';

/**
 * Creates mock objects for all services that InventoryService depends on.
 * These mocks satisfy the inject() calls without needing a real backend.
 */
export function createMockDependencies() {
  // Mock ApiService — all HTTP methods return empty observables
  const mockApiService = {
    getCoins: vi.fn(() => of([])),
    getCategories: vi.fn(() => of([])),
    getCoinSets: vi.fn(() => of([])),
    getDenominations: vi.fn(() => of([])),
    getMintMarks: vi.fn(() => of([])),
    // Required: ConnectionManager.loadLookupTables calls every lookup getter
    // during hydrate(), so a missing method breaks startup in many tests.
    getCatalogs: vi.fn(() => of([])),
    createCatalog: vi.fn(() => of({})),
    updateCatalog: vi.fn(() => of(undefined)),
    deleteCatalog: vi.fn(() => of(undefined)),
    // Issuers and in-use counts: read only by the reference-data screen.
    getIssuers: vi.fn(() => of([])),
    createIssuer: vi.fn(() => of({})),
    updateIssuer: vi.fn(() => of({})),
    deleteIssuer: vi.fn(() => of(undefined)),
    getReferenceUsage: vi.fn(() =>
      of({
        categories: {}, coinSets: {}, denominations: {}, mintMarks: {}, catalogs: {},
        metalContents: {}
      })
    ),
    getMetalContents: vi.fn(() => of([
      'Gold', 'Silver', 'Platinum', 'Palladium', 'Copper', 'Nickel', 'Copper-Nickel',
      'Bronze', 'Brass', 'Zinc', 'Steel', 'Aluminum', 'Nickel-Brass', 'Clad', 'Other'
    ])),
    // Photos are fetched per coin (the list endpoint omits them); default to none.
    getCoinImages: vi.fn(() => of([])),
    // Mirrors the real signature, including the cache-busting revision.
    coinThumbnailUrl: vi.fn((coinId: string, revision = 0) => {
      const url = `/api/coins/${encodeURIComponent(coinId)}/thumbnail`;
      return revision > 0 ? `${url}?v=${revision}` : url;
    }),
    createCoin: vi.fn(() => of({})),
    updateCoin: vi.fn(() => of({})),
    deleteCoin: vi.fn(() => of({})),
    createCategory: vi.fn(() => of({})),
    deleteCategory: vi.fn(() => of({})),
    createCoinSet: vi.fn(() => of({})),
    deleteCoinSet: vi.fn(() => of({})),
    fetchSpotPrices: vi.fn(() => of({
      prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
      source: '', timestamp: ''
    })),
    // The empty-table response: a null `fetchedAt` tells ConnectionManager
    // nothing is saved, so it keeps the in-memory defaults.
    getLatestSpotPrices: vi.fn(() => of({
      gold: 0, silver: 0, platinum: 0, copper: 0, source: null, fetchedAt: null
    })),
    saveSpotPrices: vi.fn(() => of(undefined)),
    postLog: vi.fn(() => of({})),
    healthCheck: vi.fn(() => of({})),
  } as unknown as ApiService;

  // Mock LoggingService — just captures calls
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggingService;

  // Mock NotificationService — just captures calls
  const mockNotification = {
    showInfo: vi.fn(),
    showWarning: vi.fn(),
    showError: vi.fn(),
    show: vi.fn(),
    dismiss: vi.fn(),
    notifications: () => [],
  } as unknown as NotificationService;

  const storage = new StorageService();

  return { storage, mockApiService, mockLogger, mockNotification };
}

/** Creates an InventoryService with mock providers; returns it with its injector and mocks. */
export function createTestInventoryService() {
  const deps = createMockDependencies();

  const injector = Injector.create({
    providers: [
      { provide: ApiService, useValue: deps.mockApiService },
      { provide: LoggingService, useValue: deps.mockLogger },
      { provide: NotificationService, useValue: deps.mockNotification },
    ]
  });

  const inv = runInInjectionContext(injector, () => new InventoryService());

  return { inv, injector, ...deps };
}

/** Creates a SpotPriceService with mock providers; pass `overrides` to supply your own mocks. */
export function createTestSpotPriceService(overrides?: {
  mockApiService?: any;
  mockLogger?: any;
  mockNotification?: any;
}) {
  const mockApiService = (overrides?.mockApiService ?? {
    fetchSpotPrices: vi.fn(() => of({
      prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
      source: '', timestamp: ''
    })),
  }) as unknown as ApiService;

  const mockLogger = (overrides?.mockLogger ?? {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as LoggingService;

  const mockNotification = (overrides?.mockNotification ?? {
    showInfo: vi.fn(),
    showWarning: vi.fn(),
    showError: vi.fn(),
    show: vi.fn(),
    dismiss: vi.fn(),
    notifications: () => [],
  }) as unknown as NotificationService;

  const injector = Injector.create({
    providers: [
      { provide: ApiService, useValue: mockApiService },
      { provide: LoggingService, useValue: mockLogger },
      { provide: NotificationService, useValue: mockNotification },
    ]
  });

  const service = runInInjectionContext(injector, () => new SpotPriceService());

  return { service, injector, mockApiService, mockLogger, mockNotification };
}
