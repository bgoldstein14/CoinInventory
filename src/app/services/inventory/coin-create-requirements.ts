import { CoinRecord } from '../../types/coin.model';
import { hasEnoughCoinDetail } from '../coin-completeness';

 /*
 * Coin create requirements — "will POST /api/coins actually accept this?"
 *
 * ---- THE BUG THIS FIXES ----
 * Two rules decide whether a brand-new row reaches the database, and they did
 * not agree:
 *
 *   the CLIENT  (services/coin-completeness.ts) said "at least 2 of Year /
 *               Coin Type / Denomination" — the 2-of-3 rule, shared with the
 *               QIF importer,
 *   the SERVER  (server/routes/coins/writes.ts, first lines of POST /) says
 *               `if (!body.denomination) -> 400 denomination is required`.
 *
 * A coin with a Year and a Coin Type and NO denomination satisfies the first
 * and is refused by the second. What the user saw was a row that stayed on
 * screen looking like every other row while every save attempt earned a
 * silent 400 (silent because the create-failure toast is de-duplicated per
 * coin, so only the very first one is ever shown), and a grid thumbnail
 * request for a coin the database had never heard of:
 *
 *   22:55:22 [ERROR] Failed to create coin 423f9821-... | 400 denomination is required
 *   22:56:14 [WARN]  No thumbnail available for coin 423f9821-...
 *
 * ---- THE FIX ----
 * The draft registry now asks THIS function instead of the 2-of-3 rule alone,
 * so a POST that the server is guaranteed to refuse is never sent. The row
 * stays an honest, visibly-unsaved draft and the hint on it says exactly what
 * is missing.
 *
 * ---- WHAT IS DELIBERATELY *NOT* DONE HERE ----
 *
 * 1. The server's validation is NOT relaxed. It predates the SQLite move and
 *    is not a regression; a coin with no denomination is not a coin.
 *
 * 2. `hasEnoughCoinDetail` (the 2-of-3 rule) is NOT changed. It is shared
 *    with the QIF importer, where it decides which parsed rows become coins
 *    and which become exceptions — tightening it there would silently move
 *    rows out of a real import of the owner's Quicken file. The extra
 *    requirement is added HERE, on the create path only.
 *
 * 3. The denomination test below is `!!denomination`, NOT
 *    `isCoinDetailPresent(denomination)`. It mirrors the server's own
 *    truthiness check character for character and nothing more. The stricter
 *    helper rejects placeholder text such as "Other" and "Unknown", which the
 *    server accepts quite happily — using it here would stop coins saving
 *    that save perfectly well today, which is a regression dressed as a fix.
  */

/**
 * The fields `POST /api/coins` rejects a body for outright, independent of
 * how much detail the record otherwise carries. Exactly one today.
 */
export const SERVER_REQUIRED_CREATE_FIELDS = ['denomination'] as const;

/**
 * Does the server's own validation accept this record?
 *
 * Kept as its own function so the mirror of
 * `if (!body.denomination)` in server/routes/coins/writes.ts is one readable
 * line that can be compared with the original by eye.
 */
export function meetsServerCreateRules(coin: Partial<CoinRecord>): boolean {
  return !!coin.denomination;
}

/**
 * Is this record worth POSTing — i.e. complete enough to be a coin AND
 * acceptable to the endpoint that would store it?
 *
 * Both halves are needed. The first stops a fragment being saved; the second
 * stops a request being sent that can only come back 400.
 */
export function canCreateCoin(coin: Partial<CoinRecord>): boolean {
  return hasEnoughCoinDetail(coin) && meetsServerCreateRules(coin);
}

/**
 * What to tell the user about a row that passes the 2-of-3 rule but that the
 * server would still refuse. Empty string when the server would accept it.
 */
export function describeMissingServerRequirement(coin: Partial<CoinRecord>): string {
  if (meetsServerCreateRules(coin)) return '';
  return 'Not saved yet. A Denomination is required before this coin can be saved.';
}
