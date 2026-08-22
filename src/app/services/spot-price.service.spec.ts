import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpotPriceService } from './spot-price.service';

describe('SpotPriceService', () => {
  let service: SpotPriceService;

  beforeEach(() => {
    service = new SpotPriceService();
  });

  it('should parse metals.live response', async () => {
    const mockResponse = [
      { gold: 2650.30 },
      { silver: 31.45 },
      { platinum: 1025.00 },
      { copper: 4.15 }
    ];

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const result = await service.fetchSpotPrices();

    expect(result.prices.gold).toBe(2650.30);
    expect(result.prices.silver).toBe(31.45);
    expect(result.prices.platinum).toBe(1025.00);
    expect(result.prices.copper).toBe(4.15);
    expect(result.source).toContain('COMEX');
    expect(result.error).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('should return error on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await service.fetchSpotPrices();

    expect(result.error).toBe('Network error');
    expect(result.prices.gold).toBe(0);

    vi.unstubAllGlobals();
  });

  it('should return error on HTTP error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }));

    const result = await service.fetchSpotPrices();

    expect(result.error).toBe('HTTP 503');

    vi.unstubAllGlobals();
  });
});
