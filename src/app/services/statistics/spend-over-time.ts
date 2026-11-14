 /*
 * spend-over-time.ts — cumulative money spent, in purchase-date order.
 * ---- WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT ----
 * IT IS: cumulative spend. Every recorded purchase price, added up in the
 * order the coins were bought. That is genuinely derivable from the records
 * on hand, because each coin carries both a price and a date.
 *
 * IT IS NOT: "what the collection has been worth over time", which is the
 * chart every competing product shows and the one a collector actually wants.
 * It cannot be drawn, and this is the reason:
 *
 *     Coins.CurrentValue is ONE COLUMN HOLDING ONE NUMBER. When the owner
 *     re-appraises a coin, the new figure overwrites the old one in place.
 *     No history of it is kept anywhere — not in the Coins table and not in
 *     the JSON export.
 *
 * So a value-over-time line would have to be invented out of the one data
 * point that exists, and the only honest shape it could take is a flat line
 * at today's figure, which tells the reader nothing while looking like it
 * tells them something. It is therefore not drawn at all, and the view says
 * why in a sentence.
 *
 * WHAT WOULD HAVE TO BE STORED to make it real: a `CoinValueHistory` table —
 * (CoinId, AsOfDate, CurrentValue, Source) — written on every save that
 * changes CurrentValue, exactly as `SpotPrices` is already an append-only
 * history table rather than a single row. The spot-price table is the
 * precedent and the pattern; the plumbing to read it back already exists.
 * Until that table exists, this file draws spend and nothing else.
 *
 * ---- WHY THE DATE PARSER IS STRICT ----
 * `purchaseDate` is NVARCHAR(30) and the server stores it verbatim (see
 * `normalizeTextDate` in server/db/value-normalizers.ts). It is USUALLY
 * "YYYY-MM-DD" because the Quicken importer normalises to that, but a CSV
 * import, a JSON import or a hand edit can put any text at all in it.
 *
 * `new Date(text)` is the wrong tool twice over. It accepts "2024-02-31" and
 * silently answers 2 March, putting a coin on the wrong day. And it parses
 * "2019" as midnight on 1 January 2019 UTC, inventing a precision the record
 * does not have. Both failures are invisible on a chart.
 *
 * So the parser recognises exactly two shapes and rejects everything else,
 * and a rejected date does not vanish: the coin is counted in
 * `undatedCoinCount` and its money in `undatedSpend`, which the view prints
 * beneath the chart. A curve that is $900 short of the truth has to say so.
  */

import { CoinRecord } from '../../types/coin.model';

/** "YYYY-MM-DD", optionally followed by a time the record does not need. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

/** "M/D/YYYY" or "MM/DD/YYYY" — what a hand edit or a US CSV produces. */
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * A purchase date as "YYYY-MM-DD", or null when the text cannot be trusted.
 *
 * Validates the calendar as well as the shape: 2024-02-31 is rejected rather
 * than rolled forward to March, because a coin bought on a day that does not
 * exist is bad data and silently moving it is worse than leaving it out.
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
   * THE ROUND TRIP IS THE WHOLE CALENDAR CHECK — DO NOT "HELP" IT.
   *
   * `Date.UTC` does not reject an impossible date, it ROLLS IT OVER:
   *
   *     Date.UTC(2024,  1, 31)  ->  2 March      (31 February)
   *     Date.UTC(2024, 12,  1)  ->  1 Jan 2025   (month 13)
   *     Date.UTC(2024,  0,  0)  ->  31 Dec 2023  (day 0)
   *
   * which is exactly the silent wrongness this parser exists to stop: a coin
   * placed on a day it was not bought. Reading the three components back out
   * and insisting they are the three that went in catches every one of those
   * cases, including all the range ones.
   *
   * Do not add a separate range guard (`month > 12 || day > 31`) above this:
   * the round trip already rejects everything such a guard would, and two
   * calendar checks can disagree where one cannot.
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
  /** One point per distinct purchase date, earliest first. Never unsorted. */
  points: SpendPoint[];
  /** Coins that are on the curve. */
  datedCoinCount: number;
  /** Coins with no usable purchase date. Off the curve, and counted. */
  undatedCoinCount: number;
  /** Money those coins cost, which the curve is therefore short of. */
  undatedSpend: number;
  /** Coins on the curve whose price was never recorded. */
  datedButUnpricedCount: number;
}

/**
 * Cumulative spend, by purchase date.
 *
 * A DATED coin with no price stays ON the curve. Its acquisition is a fact
 * the record states plainly; only its cost is missing. It therefore advances
 * `cumulativeCoins` and not `cumulativeSpend`, and is counted in
 * `datedButUnpricedCount` so the view can say how much of the line is
 * guesswork-free.
 *
 * But a curve made ENTIRELY of unpriced coins is refused outright. Every
 * point would sit at zero, and a flat line along the axis reads as "I have
 * spent nothing on this collection" rather than "nothing was recorded" —
 * which is the same class of lie as a $0.00 melt value.
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
    // Non-positive means "not recorded" — the same reading of a zero that
    // collection-totals.ts makes, for the same reason.
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

  // Lexicographic sort is chronological for "YYYY-MM-DD", which is the whole
  // reason the parser normalises to that shape rather than to a Date.
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
