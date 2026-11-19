 /*
  * What the unlinked-denominations cleanup screen shows for a real collection:
  * the real importer over the corpus in testing/qif-corpus/, censused against
  * the real seed, with every group the pane renders named with its count.
  *
  * Each group is a correct outcome for the user to decide:
  *   `8 Reales`  four coins; six issuers struck one. One issuer pick fixes all four.
  *   `5s`        one coin; the parser's spelling of a crown (GB, Australia, NZ).
  *   (nothing)   three securities with no denomination read.
  * Counts change when the corpus is regenerated; any other change needs explaining.
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
 * The corpus as it would be after migration 014: each coin gets the id the
 * import path would assign (via `resolveDenominationId`). Without this every
 * coin would count as unlinked.
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
    /* Non-vacuity: if the fixture stops producing coins, every count is trivially zero. */
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
    // The review list; each entry is explained in the file header.
    expect(
      CENSUS.groups.map((group) => `${group.reason} | ${group.heading} | ${group.coinCount}`)
    ).toEqual([
      'ambiguous | 8 Reales | 4',
      'ambiguous | 5s | 1',
      'nothing-recorded | Nothing recorded | 3',
    ]);
  });

  it('counts by reason, and nothing in this collection is unknown', () => {
    /* No 'unknown': the seed names every denomination here; the two groups above
     * are ambiguous, not missing. */
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
    /* Four coins, one decision: the reason the screen groups rather than lists. */
    const reales = CENSUS.groups[0];
    const mexico = reales.choices.find((choice) => choice.issuerName === 'Mexico');
    const plan = planUnlinkedFix(reales, mexico?.denominationId ?? null, SEED_DENOMINATIONS);

    expect(plan.refusal).toBe('');
    expect(plan.candidates).toHaveLength(4);
    expect(plan.denominationLabel).toBe('8 Reales');
    for (const candidate of plan.candidates) {
      // The id and the label, not the country: the user hasn't asked to change it.
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

/*
 * The one unresolved value migration 014 found on a live database: a Peruvian
 * coin holding the literal `__OTHER__` (residue from a fixed editor bug; typed
 * in, so not in the QIF corpus). It must never be offered as a group to add to
 * the reference list.
 */
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

    // Not offered as a group inviting the user to add `__OTHER__` to the list.
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
