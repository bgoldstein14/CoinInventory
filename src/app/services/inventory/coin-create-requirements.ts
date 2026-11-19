import { CoinRecord } from '../../types/coin.model';
import { hasEnoughCoinDetail } from '../coin-completeness';

 /*
  * "Will POST /api/coins accept this?" A new row is created only when it passes
  * both the 2-of-3 rule (coin-completeness.ts) and the server's own validation
  * (server/routes/coins/writes.ts: `if (!body.denomination)` -> 400). Without
  * the second check, a coin with Year and Coin Type but no denomination would
  * be POSTed and refused on every save while looking saved.
  *
  * - The server's validation is not relaxed.
  * - `hasEnoughCoinDetail` is unchanged (the QIF importer shares it); the extra
  *   requirement applies on the create path only.
  * - The denomination test is `!!denomination`, mirroring the server exactly.
  *   `isCoinDetailPresent` would also reject placeholders like "Other", which the
  *   server accepts.
  */

/** Fields `POST /api/coins` requires regardless of other detail. */
export const SERVER_REQUIRED_CREATE_FIELDS = ['denomination'] as const;

/** Whether the server's validation accepts this record; mirrors `if (!body.denomination)`. */
export function meetsServerCreateRules(coin: Partial<CoinRecord>): boolean {
  return !!coin.denomination;
}

/**
 * Whether a record is worth POSTing: complete enough to be a coin, and
 * acceptable to the endpoint.
 */
export function canCreateCoin(coin: Partial<CoinRecord>): boolean {
  return hasEnoughCoinDetail(coin) && meetsServerCreateRules(coin);
}

/** What a row that passes 2-of-3 still needs for the server; '' when acceptable. */
export function describeMissingServerRequirement(coin: Partial<CoinRecord>): string {
  if (meetsServerCreateRules(coin)) return '';
  return 'Not saved yet. A Denomination is required before this coin can be saved.';
}
