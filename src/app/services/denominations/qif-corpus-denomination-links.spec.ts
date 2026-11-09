 /*
 * qif-corpus-denomination-links.spec.ts
 * HOW MUCH OF A REAL COLLECTION ACTUALLY LINKS, AND WHAT DOES NOT
 *
 * WHAT THIS FILE IS
 *
 * Every other spec for this change asks whether a rule is implemented. This
 * one asks what the rule DOES to a collection, and the answer is a number
 * that is evidence rather than decoration:
 *
 *   - the REAL importer (`QuickenImportService.parse`, via
 *     `testing/qif-accounts.fixture.ts`) is run over all seven coin accounts
 *     of the structurally faithful corpus in `testing/qif-corpus/`;
 *   - every coin it produces is resolved against the REAL authored seed --
 *     1,161 denominations under 61 issuers -- exactly as the import path
 *     does it, through the same `resolveDenominationId`;
 *   - the links are counted, and every distinct value that does NOT link is
 *     named below with its count.
 *
 * That last list is the point. It is the same artefact migration 014's
 * report produces for the database, for the same reason: design §5 says
 * "report, do not assume". A number with no list behind it cannot be
 * reviewed, and "98% resolve" hides whether the 2% is three blank rows or
 * every British coin in the collection.
 *
 * AN UNRESOLVED VALUE IS NOT A FAILING TEST
 *
 * *** READ THIS BEFORE "FIXING" THE LIST AT THE BOTTOM. ***
 * A coin that imports with its text and no link is a CORRECT outcome (§4.1),
 * reads `Other (8 Reales)`, and keeps the only surviving record of what the
 * file said. The three entries below are each right:
 *
 *   `8 Reales`  six issuers struck one and the coin says 'United States'.
 *               Guessing Mexico would file four coins under an issuer the
 *               owner never chose, invisibly and for good.
 *   `5s`        the QIF parser's spelling of a crown; Great Britain,
 *               Australia and New Zealand all struck one.
 *   (blank)     three securities the parser could read a year and a type out
 *               of but no denomination. Nothing was recorded, so there is
 *               nothing to resolve -- outcome 'empty', which deliberately
 *               does NOT belong in a review report.
 *
 * The way to move one of these is to give the coin a country in the editor,
 * or to add the issuer's row to the seed. It is NOT to loosen a rule here.
 *
 * WHY THE NUMBERS ARE ASSERTED EXACTLY
 *
 * Because a floor ("at least 300 link") goes on passing through the kind of
 * regression this is written to catch. The counts moved once already during
 * this work -- 397 to 449 -- when the client's reconstruction of the Issuers
 * table was found to be renaming the Confederate States onto the United
 * States and taking every US 1¢ and 50¢ down with it (see
 * denomination-index.ts). A floor of 300 would have hidden that completely.
 *
 * If you regenerate the corpus, these numbers move with it; that is expected
 * and the fixture's own header says so. Changing them for any OTHER reason
 * is a finding that wants explaining in the commit message.
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
  /** '<text> / <country>' -> count, for everything that did not link. */
  unlinked: Map<string, number>;
  /** Coins linked to an issuer the coin's own country does not name. */
  crossIssuer: string[];
}

/**
 * Run the real importer over the corpus and resolve what it produces.
 *
 * `inventoryFor` wraps each distinct security in a one-share purchase so the
 * net-quantity rule keeps all of them, which is deliberate: the sold coins
 * are real strings somebody typed and they make the sample both larger and
 * denser. See the fixture's header.
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

      // EXACTLY what the import path does: the coin's own text, the coin's
      // own country. Not a constant, and not the file's.
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
    // Non-vacuity. If the fixture ever stops producing coins -- a decode
    // change, a corpus regeneration gone wrong -- every count below becomes
    // zero and every assertion about them becomes trivially satisfiable.
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
    // THE REVIEW ARTEFACT. Each of these is explained in the file header.
    expect([...CORPUS.unlinked].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['(blank) / United States', 3],
      ['5s / United States', 1],
      ['8 Reales / United States', 4]
    ]);
  });

  it('records why, in the resolver\'s own words', () => {
    expect([...CORPUS.outcomes].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      // Five coins the table could not choose between, three with nothing
      // recorded at all, and no 'unknown' -- the seed names every other
      // denomination this collection holds.
      ['ambiguous', 5],
      ['empty', 3],
      ['in-country', 449]
    ]);
  });

  it('never files a coin under an issuer its own country does not name', () => {
    /* The strongest property here, and the one worth keeping if the counts
     * above ever get in the way.
     *
     * Widening past the coin's country is REQUIRED (design §5) and it is
     * implemented, but every widening is a chance to file a coin under an
     * issuer nobody chose. On this collection it never fires: every
     * one of the 449 links is in-country, so nothing is being guessed.
     *
     * A future corpus may legitimately break this -- a Mexican coin stored
     * as 'United States' that only Mexico struck SHOULD widen and link. If
     * that happens, do not delete this test: list the crossings, so the
     * review is of the actual coins rather than of a count. */
    expect(CORPUS.crossIssuer).toEqual([]);
  });
});
