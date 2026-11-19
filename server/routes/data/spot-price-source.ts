/**
 * Fetches live precious-metal prices from COMEX/NYMEX front-month futures via
 * Yahoo Finance (no API key needed):
 *
 *   GC=F  Gold      (COMEX)
 *   SI=F  Silver    (COMEX)
 *   PL=F  Platinum  (NYMEX)
 *   HG=F  Copper    (COMEX)
 *
 * The endpoint is undocumented, so it's best-effort: each symbol is fetched
 * independently, failures are reported per metal (a dead upstream otherwise
 * just shows $0), and SPOT_PRICE_BASE_URL can override the base URL.
 */

import { logInfo, logWarn } from '../../logger';

/** The shape the frontend expects: US dollars per troy ounce. */
export interface SpotPriceSet {
  gold: number;
  silver: number;
  platinum: number;
  copper: number;
}

export interface SpotPriceFetchResult {
  prices: SpotPriceSet;
  source: string;
  /** Metals that couldn't be retrieved. */
  failed: string[];
}

/**
 * Troy ounces per avoirdupois pound (453.59237 g / 31.1034768 g). COMEX quotes
 * copper per pound and the others per troy ounce; the frontend's melt value
 * assumes troy ounces, so copper is converted here.
 */
const TROY_OUNCES_PER_POUND = 453.59237 / 31.1034768;

const BASE_URL =
  process.env['SPOT_PRICE_BASE_URL'] ?? 'https://query1.finance.yahoo.com/v8/finance/chart';

/** How long to wait for any single symbol before giving up on it. */
const REQUEST_TIMEOUT_MS = 10_000;

interface MetalSpec {
  key: keyof SpotPriceSet;
  symbol: string;
  /** Multiply the quoted price by this to get dollars per troy ounce. */
  toPerTroyOunce: number;
}

const METALS: MetalSpec[] = [
  { key: 'gold', symbol: 'GC=F', toPerTroyOunce: 1 },
  { key: 'silver', symbol: 'SI=F', toPerTroyOunce: 1 },
  { key: 'platinum', symbol: 'PL=F', toPerTroyOunce: 1 },
  // Quoted per pound.
  { key: 'copper', symbol: 'HG=F', toPerTroyOunce: 1 / TROY_OUNCES_PER_POUND },
];

/** The part of Yahoo's response we read. Loose on purpose: only the one number is validated. */
interface YahooChartResponse {
  chart?: {
    result?: Array<{ meta?: { regularMarketPrice?: unknown } }>;
  };
}

/** Fetches one symbol; returns null rather than throwing so one failure doesn't affect the others. */
async function fetchOne(spec: MetalSpec): Promise<number | null> {
  const url = `${BASE_URL}/${encodeURIComponent(spec.symbol)}?interval=1d&range=1d`;

  try {
    const response = await fetch(url, {
      // Yahoo rejects requests with no recognisable User-Agent.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CoinInventory/1.0)' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      logWarn(`Spot price fetch for ${spec.key} (${spec.symbol}) returned HTTP ${response.status}`);
      return null;
    }

    const body = (await response.json()) as YahooChartResponse;
    const raw = body.chart?.result?.[0]?.meta?.regularMarketPrice;

    // Missing or non-positive is a failure, not zero (zero would give $0 melt values).
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      logWarn(`Spot price fetch for ${spec.key} (${spec.symbol}) returned no usable price`);
      return null;
    }

    return raw * spec.toPerTroyOunce;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`Spot price fetch for ${spec.key} (${spec.symbol}) failed: ${message}`);
    return null;
  }
}

/**
 * Fetches all four metals concurrently, in dollars per troy ounce. Never
 * throws; failed metals stay 0 and are listed in `failed`.
 */
export async function fetchSpotPrices(): Promise<SpotPriceFetchResult> {
  logInfo('Fetching spot prices from COMEX/NYMEX futures...');

  const prices: SpotPriceSet = { gold: 0, silver: 0, platinum: 0, copper: 0 };
  const failed: string[] = [];

  const results = await Promise.all(
    METALS.map(async (spec) => ({ spec, value: await fetchOne(spec) }))
  );

  for (const { spec, value } of results) {
    if (value === null) {
      failed.push(spec.key);
    } else {
      // Copper is well under $1 per troy ounce, so it gets more decimals.
      prices[spec.key] = spec.key === 'copper'
        ? Math.round(value * 10_000) / 10_000
        : Math.round(value * 100) / 100;
    }
  }

  logInfo(
    `Spot prices fetched: Au=$${prices.gold} Ag=$${prices.silver} ` +
    `Pt=$${prices.platinum} Cu=$${prices.copper}/ozt` +
    (failed.length ? ` (failed: ${failed.join(', ')})` : '')
  );

  return { prices, source: 'COMEX/NYMEX futures via Yahoo Finance', failed };
}
