 /*
 * qif-corpus-unlinked-view.spec.ts
 * WHAT THE CLEANUP SCREEN ACTUALLY SHOWS
 *
 * WHAT THIS FILE IS
 *
 * `unlinked-denominations.spec.ts` asks whether each rule is implemented.
 * This one asks what the screen WOULD SAY to the person it was built for,
 * and the answer is evidence rather than decoration:
 *
 *   - the REAL importer is run over all seven coin accounts of the
 *     structurally faithful corpus in `testing/qif-corpus/`;
 *   - every coin it produces is censused against the REAL authored seed --
 *     1,161 denominations under 61 issuers;
 *   - every group the pane would render is named below, with its count.
 *
 * It is the same artefact migration 014 prints, which is the point: design
 * §5 says "report, do not assume", and this is the in-app report measured
 * against real data instead of a fixture built to make it look good.
 *
 * A GROUP IN THIS LIST IS NOT A FAILING TEST
 *
 * *** READ THIS BEFORE "FIXING" THE EXPECTATIONS BELOW. ***
 * A coin that imported with its text and no link is a CORRECT outcome
 * (§4.1). The groups here are each right, and each is exactly the decision
 * the screen exists to put in front of a user:
 *
 *   `8 Reales`  four coins. Six issuers struck one and the coins say
 *               'United States', so the resolver refuses to guess. ONE pick
 *               of an issuer fixes all four -- which is the whole reason
 *               this screen groups rather than lists.
 *   `5s`        one coin. The QIF parser's spelling of a crown; Great
 *               Britain, Australia and New Zealand all struck one.
 *   (nothing)   three securities the parser could read a year and a type out
 *               of, but no denomination at all.
 *
 * The way to move one of these is to pick an issuer on the screen, or to add
 * a row to the seed. It is NOT to loosen a rule.
 *
 * If you regenerate the corpus these numbers move with it; the fixture's own
 * header says so. Changing them for any OTHER reason is a finding that wants
 * explaining in the commit message.
  */

import { describe, expect, it } from 'vitest';

import { QIF_ACCOUNTS, inventoryFor } from '../../testing/qif-accounts.fixture';
import { SEED_DENOMINATIONS } from '../../testing/seed-denominations.fixture';
import { CoinRecord } from '../../types/coin.model';
import { resolveDenominationId } from './denomination-index';
import {
  censusUnlinkedDenominations,
  describeUnlinkedCensus,
  planUnlinkedFix,
} from './unlinked-denominations';

/**
 * The corpus as it would sit in the database AFTER migration 014.
 *
 * That last part matters and is easy to get wrong: the migration links what
 * it can, so a census run over the raw import would report every coin as
 * unlinked and measure nothing. Each coin is given the id the import path
 * would have given it, through the same `resolveDenominationId`, and only
 * then handed to the screen.
 */
function migratedCorpus(): CoinRecord[] {
  const coins: CoinRecord[] = [];
  for (const account of QIF_ACCOUNTS) {
    for (const coin of inventoryFor(account)) {
      coins.push({
        ...coin,
        denominationId: resolveDenominationId(coin.denomination, coin.country, SEED_DENOMINATIONS),
      });
    }
  }
  return coins;
}

const CORPUS = migratedCorpus();
const CENSUS = censusUnlinkedDenominations(CORPUS, SEED_DENOMINATIONS);

describe('the cleanup screen, against the real corpus and the real seed', () => {
  it('is a sample worth measuring', () => {
    /* Non-vacuity. If the fixture ever stops producing coins -- a decode
     * change, a corpus regeneration gone wrong -- every count below becomes
     * zero and every assertion about them becomes trivially satisfiable. */
    expect(CORPUS).toHaveLength(457);
    expect(SEED_DENOMINATIONS.length).toBeGreaterThan(1000);
    expect(CENSUS.lookupLoaded).toBe(true);
  });

  it('shows the owner eight coins, and tells him so in one sentence', () => {
    expect(CENSUS.totalCoins).toBe(457);
    expect(CENSUS.unlinkedCount).toBe(8);
    expect(describeUnlinkedCensus(CENSUS)).toBe(
      '8 coins have no denomination linked, in 3 groups.'
    );
  });

  it('renders exactly three groups, in cleanup order', () => {
    // THE REVIEW ARTEFACT. Each entry is explained in the file header.
    expect(
      CENSUS.groups.map((group) => `${group.reason} | ${group.heading} | ${group.coinCount}`)
    ).toEqual([
      'ambiguous | 8 Reales | 4',
      'ambiguous | 5s | 1',
      'nothing-recorded | Nothing recorded | 3',
    ]);
  });

  it('counts by reason, and nothing in this collection is unknown', () => {
    /* No 'unknown' is itself a finding: the authored seed names every
     * denomination this collection holds except the two spellings above,
     * both of which it DOES name and simply cannot choose between. */
    expect(CENSUS.countsByReason).toEqual({
      resolvable: 0,
      ambiguous: 5,
      unknown: 0,
      'nothing-recorded': 3,
    });
  });

  it('offers the six issuers who struck an 8 Reales, and nothing else', () => {
    const reales = CENSUS.groups[0];
    expect(reales.countries).toEqual(['United States']);
    expect(reales.choices.map((choice) => `${choice.issuerName}: ${choice.label}`)).toEqual([
      'Chile: 8 Reales',
      'Colombia: 8 Reales',
      'Mexico: 8 Reales',
      'Peru: 8 Reales',
      'Spain: 8 Reales',
      'Spanish Colonial: 8 Reales',
    ]);
  });

  it('fixes all four 8 Reales coins from ONE choice', () => {
    /* *** THE REASON THIS SCREEN EXISTS. *** Four coins, one decision --
     * four separate edits become one pick of an issuer. */
    const reales = CENSUS.groups[0];
    const mexico = reales.choices.find((choice) => choice.issuerName === 'Mexico');
    const plan = planUnlinkedFix(reales, mexico?.denominationId ?? null, SEED_DENOMINATIONS);

    expect(plan.refusal).toBe('');
    expect(plan.candidates).toHaveLength(4);
    expect(plan.denominationLabel).toBe('8 Reales');
    for (const candidate of plan.candidates) {
      // The id and the label, and NOT the country: these coins already say
      // 'United States' and the user has not asked for that to change.
      expect(candidate.updates).toEqual({
        denominationId: mexico?.denominationId,
        denomination: '8 Reales',
      });
    }
    expect(plan.countryWrites).toBe(0);
  });

  it('rewrites the country on all four only when explicitly asked', () => {
    const reales = CENSUS.groups[0];
    const mexico = reales.choices.find((choice) => choice.issuerName === 'Mexico');
    const plan = planUnlinkedFix(reales, mexico?.denominationId ?? null, SEED_DENOMINATIONS, {
      setCountry: true,
    });

    expect(plan.countryWrites).toBe(4);
    for (const candidate of plan.candidates) {
      expect(candidate.updates.country).toBe('Mexico');
    }
  });

  it('offers nothing to pick for the three coins with nothing recorded', () => {
    const blank = CENSUS.groups[2];
    expect(blank.recordedTexts).toEqual([]);
    expect(blank.choices).toEqual([]);
    expect(blank.coins.map((coin) => coin.label)).toEqual([
      '1957 Proof Set United States',
      '1971 Proof Set United States',
      '1982 Lincoln United States',
    ]);
  });
});

/* ===========================================================================
 * THE ONE REAL UNRESOLVED VALUE
 * ---------------------------------------------------------------------------
 * Migration 014 reported exactly one on a live database: a Peruvian coin
 * holding the literal string `__OTHER__`, residue from a fixed editor bug.
 * It is not in the QIF corpus -- it was typed in, not imported -- so it is
 * It is not in the QIF corpus -- it was typed in, not imported -- so it is
 * reproduced here, because it is the single most important row this screen
 * has to get right and getting it wrong would push a UI sentinel into the
 * reference list for ever.
 * =========================================================================== */
describe("the owner's __OTHER__ coin, which is what migration 014 actually found", () => {
  const peruvian: CoinRecord = {
    ...CORPUS[0],
    id: 'peru-1',
    denomination: '__OTHER__',
    denominationId: null,
    country: 'Peru',
    year: '1935',
    coinType: 'Sol',
    mintMark: '',
  };

  const census = censusUnlinkedDenominations([...CORPUS, peruvian], SEED_DENOMINATIONS);

  it('files it under "nothing recorded", not under "nothing matches"', () => {
    const blank = census.groups.find((group) => group.reason === 'nothing-recorded');
    expect(blank?.coinCount).toBe(4);
    expect(blank?.coins.some((coin) => coin.coinId === 'peru-1')).toBe(true);

    // And emphatically NOT as a group inviting him to add `__OTHER__` to the
    // reference list.
    expect(census.countsByReason.unknown).toBe(0);
    expect(census.groups.flatMap((group) => group.recordedTexts)).not.toContain('__OTHER__');
  });

  it('still lets him pick a denomination for it outright', () => {
    const blank = census.groups.find((group) => group.reason === 'nothing-recorded')!;
    const sol = SEED_DENOMINATIONS.find(
      (row) => row.issuerName === 'Peru' && row.label === '1 Sol'
    );
    expect(sol).toBeDefined();

    const plan = planUnlinkedFix(blank, sol!.denominationId, SEED_DENOMINATIONS);
    expect(plan.refusal).toBe('');
    expect(plan.denominationLabel).toBe('1 Sol');
    expect(plan.candidates).toHaveLength(4);
  });
});
