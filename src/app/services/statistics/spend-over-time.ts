 /*
  * Cumulative spend in purchase-date order: every recorded purchase price added
  * up in the order coins were bought.
  *
  * Not a value-over-time chart: `Coins.CurrentValue` is a single column
  * overwritten on re-appraisal, so no value history exists. That would need a
  * `CoinValueHistory` table (CoinId, AsOfDate, CurrentValue, Source), written on
  * every save that changes CurrentValue, like the append-only `SpotPrices` table.
  *
  * `purchaseDate` is free text (NVARCHAR(30), stored verbatim). Usually
  * "YYYY-MM-DD" from the Quicken importer, but CSV/JSON imports or hand edits
  * can hold anything. `new Date(text)` rolls invalid dates forward and invents
  * precision ("2019" becomes 1 January), so the parser accepts exactly two
  * shapes. Coins with rejected dates are counted in `undatedCoinCount` and
  * `undatedSpend`, which the view shows under the chart.
  */

import { CoinRecord } from '../../types/coin.model';

/** "YYYY-MM-DD", optionally followed by a time (ignored). */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

/** "M/D/YYYY" or "MM/DD/YYYY" (hand edits, US CSVs). */
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * A purchase date as "YYYY-MM-DD", or null if it can't be trusted. Validates
 * the calendar too: 2024-02-31 is rejected, not rolled into March.
 */
export function parsePurchaseDate(value: string): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;

  let year: number;
  let month: number;
  let day: number;

  const iso = ISO_DATE.exec(text);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    const us = US_DATE.exec(text);
    if (!us) return null;
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
  }

   /*
    * Calendar check by round trip: Date.UTC rolls impossible dates over
    * (31 Feb -> 2 Mar, month 13 -> January, day 0 -> previous month's last day),
    * so the components read back must equal those passed in. This also covers
    * range checks; no separate guard is needed.
    */
  const stamp = Date.UTC(year, month - 1, day);
  const back = new Date(stamp);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }

  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

export interface SpendPoint {
  /** "YYYY-MM-DD". */
  date: string;
  /** The same day as a UTC timestamp, for the x-axis. */
  time: number;
  /** Recorded spend on that day. */
  spend: number;
  /** Coins acquired on that day, priced or not. */
  coins: number;
  cumulativeSpend: number;
  cumulativeCoins: number;
}

export interface SpendOverTime {
  /** One point per distinct purchase date, earliest first. */
  points: SpendPoint[];
  /** Coins that are on the curve. */
  datedCoinCount: number;
  /** Coins with no usable purchase date (off the curve, but counted). */
  undatedCoinCount: number;
  /** What those coins cost (missing from the curve). */
  undatedSpend: number;
  /** Coins on the curve whose price was never recorded. */
  datedButUnpricedCount: number;
}

/**
 * Cumulative spend by purchase date. A dated coin with no price stays on the
 * curve (advances the coin count, not spend) and is counted in
 * `datedButUnpricedCount`. A curve made entirely of unpriced coins is not drawn.
 */
export function computeSpendOverTime(coins: readonly CoinRecord[]): SpendOverTime {
  const byDate = new Map<string, { spend: number; coins: number }>();
  let datedCoinCount = 0;
  let undatedCoinCount = 0;
  let undatedSpend = 0;
  let datedButUnpricedCount = 0;
  let anySpend = false;

  for (const coin of coins) {
    const price = coin.purchasePrice;
    // Non-positive means "not recorded", as in collection-totals.ts.
    const spend = typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : 0;

    const date = parsePurchaseDate(coin.purchaseDate);
    if (date === null) {
      undatedCoinCount++;
      undatedSpend += spend;
      continue;
    }

    datedCoinCount++;
    if (spend > 0) {
      anySpend = true;
    } else {
      datedButUnpricedCount++;
    }

    const day = byDate.get(date) ?? { spend: 0, coins: 0 };
    day.spend += spend;
    day.coins++;
    byDate.set(date, day);
  }

  if (!anySpend) {
    return {
      points: [],
      datedCoinCount,
      undatedCoinCount,
      undatedSpend,
      datedButUnpricedCount
    };
  }

  // Lexicographic sort is chronological for "YYYY-MM-DD".
  const dates = [...byDate.keys()].sort();

  let cumulativeSpend = 0;
  let cumulativeCoins = 0;
  const points: SpendPoint[] = dates.map(date => {
    const day = byDate.get(date)!;
    cumulativeSpend += day.spend;
    cumulativeCoins += day.coins;
    return {
      date,
      time: Date.parse(`${date}T00:00:00.000Z`),
      spend: day.spend,
      coins: day.coins,
      cumulativeSpend,
      cumulativeCoins
    };
  });

  return { points, datedCoinCount, undatedCoinCount, undatedSpend, datedButUnpricedCount };
}
