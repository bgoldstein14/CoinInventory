/**
 * routes/data/spot-price-source.ts — the one outbound HTTP call in this backend.
 *
 * Fetches live precious-metal prices from COMEX/NYMEX front-month futures.
 *
 * WHY THIS REPLACED metals.live
 * The previous implementation called `https://api.metals.live/v1/spot`. That
 * free API has been discontinued: the hostname still resolves (to a CloudFront
 * address) but the TLS connection is refused, so every fetch failed with
 * "The underlying connection was closed". Because the route deliberately
 * answers 200 with zeroed prices on failure, the app showed no error -- the
 * prices simply stayed at $0 forever, which is what the user saw as
 * "the COMEX PM prices fetch does not work".
 *
 * WHY YAHOO FINANCE
 * These four symbols are the actual COMEX/NYMEX contracts, which is precisely
 * what "COMEX prices" means, and the endpoint needs no API key or signup:
 *
 *   GC=F  Gold      (COMEX)
 *   SI=F  Silver    (COMEX)
 *   PL=F  Platinum  (NYMEX)
 *   HG=F  Copper    (COMEX)
 *
 * It is an undocumented endpoint, so treat it as best-effort: every symbol is
 * fetched independently and a failure on one does not lose the others. The
 * base URL can be overridden with the SPOT_PRICE_BASE_URL environment
 * variable if it ever needs swapping without a code change.
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
  /** Metals we could not retrieve, so the caller can say so honestly. */
  failed: string[];
}

/**
 * Troy ounces in one pound (avoirdupois).
 *
 * 1 lb = 453.59237 g and 1 troy oz = 31.1034768 g, so 1 lb = 14.5833... troy oz.
 *
 * This matters because COMEX quotes copper (HG) in dollars per POUND, while
 * gold, silver and platinum are quoted per TROY OUNCE. The melt-value
 * calculation in the frontend (`inventory-metrics.ts`) divides a coin's gram
 * weight by 31.1035 and multiplies by the spot price, i.e. it assumes every
 * price is per troy ounce. Storing copper per pound would therefore overstate
 * copper melt values by a factor of ~14.6, so we convert here -- at the single
 * point where the unit is known -- rather than leaving it to callers.
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
  // Quoted per pound -- see TROY_OUNCES_PER_POUND above.
  { key: 'copper', symbol: 'HG=F', toPerTroyOunce: 1 / TROY_OUNCES_PER_POUND },
];

/**
 * Minimal shape of the bit of Yahoo's response we actually read. Declared
 * loosely on purpose: this is a third-party payload we do not control, so we
 * validate the one number we need rather than trusting a full schema.
 */
interface YahooChartResponse {
  chart?: {
    result?: Array<{ meta?: { regularMarketPrice?: unknown } }>;
  };
}

/** Fetches one symbol. Returns null rather than throwing, so one dead symbol
 *  cannot take the others down with it. */
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

    // A missing or nonsensical price is treated as a failure, not as zero --
    // zero would silently make every melt value come out at $0, which is the
    // exact failure mode that hid the dead metals.live API for so long.
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
 * Fetches all four metals concurrently, in dollars per troy ounce.
 *
 * Never throws. Metals that could not be retrieved stay at 0 and are listed in
 * `failed`, so the caller can tell the user which ones are missing instead of
 * presenting a zero as though it were a real price.
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
      // Round to sensible precision: copper works out to well under a dollar
      // per troy ounce, so it needs more decimal places than gold.
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
