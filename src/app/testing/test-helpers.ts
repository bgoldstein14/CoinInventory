/**
 * Shared test helpers for creating services inside Angular injection contexts.
 *
 * InventoryService and SpotPriceService use Angular's inject() function for
 * dependency injection, which means they MUST be created inside an injection
 * context (not with plain `new`). These helpers set up the required injection
 * context with mock dependencies so tests can create service instances.
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
    getTransactions: vi.fn(() => of([])),
    getDenominations: vi.fn(() => of([])),
    getMintMarks: vi.fn(() => of([])),
    createCoin: vi.fn(() => of({})),
    updateCoin: vi.fn(() => of({})),
    deleteCoin: vi.fn(() => of({})),
    createCategory: vi.fn(() => of({})),
    deleteCategory: vi.fn(() => of({})),
    createCoinSet: vi.fn(() => of({})),
    deleteCoinSet: vi.fn(() => of({})),
    createTransaction: vi.fn(() => of({})),
    deleteTransaction: vi.fn(() => of({})),
    fetchSpotPrices: vi.fn(() => of({
      prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
      source: '', timestamp: ''
    })),
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

/**
 * Creates an InventoryService inside a proper Angular injection context.
 *
 * InventoryService uses inject() for ApiService, LoggingService,
 * and NotificationService. This function sets up an Injector with mock providers
 * so the inject() calls succeed during construction.
 *
 * @returns Object with the InventoryService instance, StorageService, and all mocks
 */
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

/**
 * Creates a SpotPriceService inside a proper Angular injection context.
 *
 * SpotPriceService uses inject() for ApiService, LoggingService, and
 * NotificationService. Optionally accepts pre-created mocks for fine-grained
 * control in tests that need to configure mock behavior.
 *
 * @param overrides - Optional pre-created mock objects to use instead of defaults
 * @returns Object with the SpotPriceService instance and all mocks
 */
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
