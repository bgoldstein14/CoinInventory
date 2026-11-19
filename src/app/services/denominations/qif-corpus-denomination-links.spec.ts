 /*
  * How much of a real collection links to a denomination, and what doesn't.
  *
  * Runs the real importer (`QuickenImportService.parse` via
  * testing/qif-accounts.fixture.ts) over the seven coin accounts in
  * testing/qif-corpus/, resolves every coin against the real seed (1,161
  * denominations, 61 issuers) through `resolveDenominationId`, and names every
  * unlinked value with its count.
  *
  * Unlinked values are correct outcomes, not failures (they display as
  * `Other (8 Reales)`):
  *   `8 Reales`  six issuers struck one and the coins say 'United States'
  *   `5s`        the parser's spelling of a crown; GB, Australia and NZ all struck one
  *   (blank)     no denomination was read; outcome 'empty'
  * Fix these by setting the coin's country or adding a seed row, not by
  * loosening a rule.
  *
  * Counts are asserted exactly, so a regression can't hide behind a floor. They
  * change when the corpus is regenerated; any other change needs explaining.
  */

import { describe, expect, it } from 'vitest';

import { QIF_ACCOUNTS, inventoryFor } from '../../testing/qif-accounts.fixture';
import { SEED_DENOMINATIONS } from '../../testing/seed-denominations.fixture';
import { denominationIndexFor, resolveIndexedDenomination } from './denomination-index';
import type { DenominationMatchOutcome } from './denomination-resolution';

interface CorpusCensus {
  total: number;
  linked: number;
  perAccount: Map<string, { total: number; linked: number }>;
  outcomes: Map<DenominationMatchOutcome, number>;
  /** '<text> / <country>' -> count, for everything that didn't link. */
  unlinked: Map<string, number>;
  /** Coins linked to an issuer the coin's own country does not name. */
  crossIssuer: string[];
}

/**
 * Runs the real importer over the corpus and resolves the result.
 * `inventoryFor` wraps each security in a one-share purchase so the
 * net-quantity rule keeps all of them, sold coins included.
 */
function census(): CorpusCensus {
  const index = denominationIndexFor(SEED_DENOMINATIONS);
  const result: CorpusCensus = {
    total: 0,
    linked: 0,
    perAccount: new Map(),
    outcomes: new Map(),
    unlinked: new Map(),
    crossIssuer: []
  };

  for (const account of QIF_ACCOUNTS) {
    const coins = inventoryFor(account);
    let linkedHere = 0;

    for (const coin of coins) {
      result.total += 1;

      // As the import path does: the coin's own text and own country.
      const match = resolveIndexedDenomination(coin.denomination, coin.country, index);
      result.outcomes.set(match.outcome, (result.outcomes.get(match.outcome) ?? 0) + 1);

      if (match.denominationId === null) {
        const key = `${coin.denomination || '(blank)'} / ${coin.country}`;
        result.unlinked.set(key, (result.unlinked.get(key) ?? 0) + 1);
        continue;
      }

      linkedHere += 1;
      result.linked += 1;

      const row = index.activeById.get(match.denominationId);
      if (match.outcome !== 'in-country') {
        result.crossIssuer.push(
          `${coin.denomination} / ${coin.country} -> ${row?.label} (${row?.country})`
        );
      }
    }

    result.perAccount.set(account.account, { total: coins.length, linked: linkedHere });
  }

  return result;
}

const CORPUS = census();

describe('the QIF corpus, resolved against the authored seed', () => {
  it('is a sample worth measuring', () => {
    // Non-vacuity: if the fixture stops producing coins, every count is trivially zero.
    expect(CORPUS.total).toBe(457);
    expect(QIF_ACCOUNTS).toHaveLength(7);
  });

  it('links 449 of 457 coins', () => {
    expect(CORPUS.linked).toBe(449);
  });

  it('links them account by account', () => {
    expect([...CORPUS.perAccount].map(([name, counts]) => `${name} ${counts.linked}/${counts.total}`))
      .toEqual([
        'Early Proofs 59/59',
        '2-3-20-cent Collection 112/112',
        'Odd Type Set 12/13',
        'Type Coins 94/96',
        '20th Cent. Type 22/22',
        'Gold Coins 44/44',
        'Misc. Coins 106/111'
      ]);
  });

  it('names every value that did not link, with its count', () => {
    // The review list; each entry is explained in the file header.
    expect([...CORPUS.unlinked].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['(blank) / United States', 3],
      ['5s / United States', 1],
      ['8 Reales / United States', 4]
    ]);
  });

  it('records why, in the resolver\'s own words', () => {
    expect([...CORPUS.outcomes].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      // Five ambiguous, three with nothing recorded, no 'unknown'.
      ['ambiguous', 5],
      ['empty', 3],
      ['in-country', 449]
    ]);
  });

  it('never files a coin under an issuer its own country does not name', () => {
    /* Every link is in-country, so nothing was guessed by widening. A future
     * corpus may legitimately cross issuers (e.g. a Mexican-only coin stored as
     * 'United States'); if so, list the crossings rather than delete this test. */
    expect(CORPUS.crossIssuer).toEqual([]);
  });
});
