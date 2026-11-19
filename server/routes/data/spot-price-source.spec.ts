/**
 * The COMEX/NYMEX spot-price fetcher, with `fetch` stubbed. The key case is
 * copper: quoted per pound, but the frontend assumes per troy ounce, so a
 * missed conversion overstates copper melt values ~14.6x while still looking
 * plausible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchSpotPrices } from './spot-price-source';

/** Builds the slice of Yahoo's chart payload that the fetcher reads. */
function chartPayload(price: unknown) {
  return { chart: { result: [{ meta: { regularMarketPrice: price } }] } };
}

/** Installs a fake `fetch`; `prices` maps a symbol to a number, 'http-error' or 'throw'. */
function stubFetch(prices: Record<string, number | 'http-error' | 'throw'>) {
  // Second parameter declared so a test can assert on the RequestInit.
  const impl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString();
    const match = Object.keys(prices).find(sym => href.includes(encodeURIComponent(sym)));
    const outcome = match ? prices[match] : undefined;

    if (outcome === 'throw') throw new Error('network down');
    if (outcome === 'http-error' || outcome === undefined) {
      return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => chartPayload(outcome) } as unknown as Response;
  });

  vi.stubGlobal('fetch', impl);
  return impl;
}

const ALL_OK = { 'GC=F': 4321.2, 'SI=F': 64.801, 'PL=F': 1797.7, 'HG=F': 6.766 } as const;

describe('fetchSpotPrices', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('returns gold, silver and platinum per troy ounce, unconverted', async () => {
    stubFetch({ ...ALL_OK });
    const { prices, failed } = await fetchSpotPrices();

    expect(prices.gold).toBe(4321.2);
    expect(prices.silver).toBe(64.8);      // rounded to cents
    expect(prices.platinum).toBe(1797.7);
    expect(failed).toEqual([]);
  });

  it('converts copper from dollars per pound to dollars per troy ounce', async () => {
    stubFetch({ ...ALL_OK });
    const { prices } = await fetchSpotPrices();

    // 1 lb = 453.59237 g, 1 troy oz = 31.1034768 g -> 14.58333 troy oz per lb.
    // 6.766 / 14.58333 = 0.46395...
    const expected = 6.766 / (453.59237 / 31.1034768);
    expect(prices.copper).toBeCloseTo(expected, 4);

    // Copper must not pass through as the raw per-pound quote.
    expect(prices.copper).not.toBeCloseTo(6.766, 2);
    expect(prices.copper).toBeLessThan(1);
  });

  it('reports the metals that failed instead of returning them as zero prices', async () => {
    stubFetch({ 'GC=F': 4321.2, 'SI=F': 'http-error', 'PL=F': 'throw', 'HG=F': 6.766 });
    const { prices, failed } = await fetchSpotPrices();

    expect(prices.gold).toBe(4321.2);
    expect(failed).toContain('silver');
    expect(failed).toContain('platinum');
    // Failed metals stay 0 and are reported.
    expect(prices.silver).toBe(0);
    expect(prices.platinum).toBe(0);
  });

  it('does not let one dead symbol lose the others', async () => {
    stubFetch({ 'GC=F': 'throw', 'SI=F': 64.8, 'PL=F': 1797.7, 'HG=F': 6.766 });
    const { prices, failed } = await fetchSpotPrices();

    expect(failed).toEqual(['gold']);
    expect(prices.silver).toBe(64.8);
    expect(prices.platinum).toBe(1797.7);
    expect(prices.copper).toBeGreaterThan(0);
  });

  it('treats a missing, non-numeric or non-positive price as a failure, not as zero', async () => {
    for (const bad of [undefined, null, 'n/a', 0, -5, NaN]) {
      stubFetch({ 'GC=F': bad as never, 'SI=F': 64.8, 'PL=F': 1797.7, 'HG=F': 6.766 });
      const { failed } = await fetchSpotPrices();
      expect(failed, `price ${String(bad)} should be treated as a failure`).toContain('gold');
    }
  });

  it('never throws, even when every symbol fails', async () => {
    stubFetch({ 'GC=F': 'throw', 'SI=F': 'throw', 'PL=F': 'throw', 'HG=F': 'throw' });

    const result = await fetchSpotPrices();
    expect(result.prices).toEqual({ gold: 0, silver: 0, platinum: 0, copper: 0 });
    expect(result.failed).toHaveLength(4);
  });

  it('requests the COMEX/NYMEX futures symbols and sends a User-Agent', async () => {
    const impl = stubFetch({ ...ALL_OK });
    await fetchSpotPrices();

    const requested = impl.mock.calls.map(c => String(c[0]));
    for (const sym of ['GC=F', 'SI=F', 'PL=F', 'HG=F']) {
      expect(requested.some(u => u.includes(encodeURIComponent(sym)))).toBe(true);
    }

    // Yahoo rejects requests without a recognisable User-Agent.
    const init = impl.mock.calls[0][1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>)['User-Agent']).toBeTruthy();
  });

  it('names the source so the UI can show where the prices came from', async () => {
    stubFetch({ ...ALL_OK });
    const { source } = await fetchSpotPrices();
    expect(source).toMatch(/COMEX/i);
  });
});
