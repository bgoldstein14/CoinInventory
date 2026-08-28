import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpotPriceService } from './spot-price.service';
import { of, throwError } from 'rxjs';
import { createTestSpotPriceService } from '../testing/test-helpers';

/**
 * Tests for SpotPriceService.
 *
 * SpotPriceService uses inject() for ApiService, LoggingService, and
 * NotificationService. The createTestSpotPriceService() helper creates the
 * service inside a proper injection context with mock dependencies.
 */
describe('SpotPriceService', () => {
  let service: SpotPriceService;
  let mockApiService: any;
  let mockLoggingService: any;
  let mockNotificationService: any;

  beforeEach(() => {
    // Create mock dependencies for SpotPriceService
    mockApiService = {
      fetchSpotPrices: vi.fn(),
    };
    mockLoggingService = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockNotificationService = {
      show: vi.fn(),
      showInfo: vi.fn(),
      showWarning: vi.fn(),
      showError: vi.fn(),
    };

    // Create SpotPriceService inside injection context with mocks
    const result = createTestSpotPriceService({
      mockApiService,
      mockLogger: mockLoggingService,
      mockNotification: mockNotificationService,
    });
    service = result.service;
  });

  it('should parse backend spot price response', async () => {
    // SpotPriceService now calls backend API via ApiService instead of direct fetch
    const mockResponse = {
      prices: {
        gold: 2650.30,
        silver: 31.45,
        platinum: 1025.00,
        copper: 4.15
      },
      source: 'metals.live (COMEX)',
      timestamp: '2024-01-15T12:00:00Z'
    };

    mockApiService.fetchSpotPrices.mockReturnValue(of(mockResponse));

    const result = await service.fetchSpotPrices();

    expect(result.prices.gold).toBe(2650.30);
    expect(result.prices.silver).toBe(31.45);
    expect(result.prices.platinum).toBe(1025.00);
    expect(result.prices.copper).toBe(4.15);
    expect(result.source).toContain('COMEX');
    expect(result.error).toBeUndefined();
    expect(mockLoggingService.info).toHaveBeenCalled();
  });

  it('should return error on API failure', async () => {
    // Mock API throwing an error
    mockApiService.fetchSpotPrices.mockReturnValue(
      throwError(() => new Error('Network error'))
    );

    const result = await service.fetchSpotPrices();

    expect(result.error).toBe('Network error');
    expect(result.prices.gold).toBe(0);
    expect(mockLoggingService.error).toHaveBeenCalled();
    expect(mockNotificationService.showError).toHaveBeenCalled();
  });

  it('should handle backend error response', async () => {
    // Mock backend returning an error state
    const mockErrorResponse = {
      prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
      source: '',
      timestamp: '',
      error: 'HTTP 503'
    };

    mockApiService.fetchSpotPrices.mockReturnValue(of(mockErrorResponse));

    const result = await service.fetchSpotPrices();

    expect(result.error).toBe('HTTP 503');
    expect(mockNotificationService.showWarning).toHaveBeenCalled();
  });
});
