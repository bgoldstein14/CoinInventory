 /*
  * Tests for the unlinked-denominations census and bulk fix. The risks: a wrong
  * classification sends the user to the wrong fix (e.g. suggesting `__OTHER__`
  * be added to the reference list), and a wrong write rewrites
  * `Coins.Denomination` on many coins at once (§4.1 allows only a label the
  * user chose).
  */

import { describe, expect, it, vi } from 'vitest';

import { CoinRecord, Denomination } from '../../types/coin.model';
import {
  NOTHING_RECORDED_HEADING,
  UNLINKED_FIX_FIELDS,
  censusUnlinkedDenominations,
  describeUnlinkedCensus,
  describeUnlinkedFixOutcome,
  describeUnlinkedFixPlan,
  describeUnlinkedReason,
  onlyUnlinkedFixFields,
  planUnlinkedFix,
  runUnlinkedFix,
} from './unlinked-denominations';

/** A coin with everything blank except the overrides. */
function coin(overrides: Partial<CoinRecord>): CoinRecord {
  return {
    id: 'c1',
    denomination: '',
    denominationId: null,
    year: '',
    coinType: '',
    category: '',
    country: '',
    grade: '',
    certCompany: '',
    certNumber: '',
    variety: '',
    mintMark: '',
    composition: '',
    purchaseDate: '',
    purchasePrice: 0,
    currentValue: 0,
    notes: '',
    imagePaths: [],
    source: 'manual',
    ...overrides,
  };
}

function denomination(overrides: Partial<Denomination> & { denominationId: number; label: string; country: string }): Denomination {
  return {
    sortOrder: overrides.denominationId,
    isActive: true,
    ...overrides,
  };
}

/* A small lookup with the three shapes that matter:
 *   '8 Reales'  under two issuers -> ambiguous
 *   'Quarter'   under one issuer  -> resolvable / linkable
 *   'Penny'     under two issuers -> different ids depending on the coin's country */
const LOOKUP: Denomination[] = [
  denomination({ denominationId: 10, label: '8 Reales', country: 'MX' }),
  denomination({ denominationId: 11, label: '8 Reales', country: 'ES' }),
  denomination({ denominationId: 20, label: 'Quarter', country: 'US' }),
  denomination({ denominationId: 30, label: 'Penny', country: 'GB' }),
  denomination({ denominationId: 31, label: 'Penny', country: 'AU' }),
  denomination({ denominationId: 40, label: 'Denarius', country: 'Roman Empire' }),
  denomination({ denominationId: 50, label: 'Retired Thing', country: 'US', isActive: false }),
];

describe('censusUnlinkedDenominations — which coins need attention, and why', () => {
  it('says nothing at all until the lookup has arrived', () => {
    /* The lookup hasn't loaded yet ([]): the census must not report every coin
     * as unlinked on start-up. */
    const census = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Quarter', denominationId: 20 })],
      []
    );

    expect(census.lookupLoaded).toBe(false);
    expect(census.unlinkedCount).toBe(0);
    expect(census.groups).toEqual([]);
  });

  it('leaves linked coins alone', () => {
    const census = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Quarter', denominationId: 20, country: 'United States' })],
      LOOKUP
    );

    expect(census.totalCoins).toBe(1);
    expect(census.unlinkedCount).toBe(0);
    expect(census.groups).toEqual([]);
  });

  it('lists a coin whose link points at a denomination that is no longer active', () => {
    /* A coin pointing at a soft-deleted row displays `Other (...)` like an
     * unlinked one, so it is included. */
    const census = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Retired Thing', denominationId: 50 })],
      LOOKUP
    );

    expect(census.unlinkedCount).toBe(1);
    expect(census.groups[0].reason).toBe('unknown');
  });

  it('classifies a blank denomination as nothing recorded', () => {
    const census = censusUnlinkedDenominations([coin({ id: 'a', denomination: '   ' })], LOOKUP);

    expect(census.groups).toHaveLength(1);
    expect(census.groups[0].reason).toBe('nothing-recorded');
    expect(census.groups[0].heading).toBe(NOTHING_RECORDED_HEADING);
    expect(census.groups[0].recordedTexts).toEqual([]);
  });

  it('classifies the __OTHER__ sentinel as nothing recorded, NOT as unknown', () => {
    /* The one value migration 014 found on a live database: a Peruvian coin
     * holding `__OTHER__`. The resolver calls it 'unknown'; the screen must treat
     * it as nothing recorded, so it never suggests adding `__OTHER__` to the list. */
    const census = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: '__OTHER__', country: 'Peru' })],
      LOOKUP
    );

    expect(census.groups).toHaveLength(1);
    expect(census.groups[0].reason).toBe('nothing-recorded');
    expect(census.groups[0].recordedTexts).toEqual([]);
  });

  it('puts blanks and sentinels in ONE group, because they are one problem', () => {
    const census = censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: '' }),
        coin({ id: 'b', denomination: '__OTHER__' }),
        coin({ id: 'c', denomination: '  ' }),
      ],
      LOOKUP
    );

    expect(census.groups).toHaveLength(1);
    expect(census.groups[0].coinCount).toBe(3);
  });

  it('groups ambiguous text and offers one choice per issuer', () => {
    const census = censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: '8 Reales', country: 'United States' }),
        coin({ id: 'b', denomination: '8 Reales', country: 'United States' }),
      ],
      LOOKUP
    );

    expect(census.groups).toHaveLength(1);
    const group = census.groups[0];
    expect(group.reason).toBe('ambiguous');
    expect(group.coinCount).toBe(2);
    expect(group.heading).toBe('8 Reales');
    expect(group.countries).toEqual(['United States']);
    expect(group.choices).toEqual([
      { denominationId: 10, label: '8 Reales', issuerName: 'Mexico' },
      { denominationId: 11, label: '8 Reales', issuerName: 'Spain' },
    ]);
  });

  it('classifies text no row names as unknown, with nothing to pick from', () => {
    const census = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Trade Dollar', country: 'United States' })],
      LOOKUP
    );

    expect(census.groups[0].reason).toBe('unknown');
    expect(census.groups[0].heading).toBe('Trade Dollar');
    expect(census.groups[0].choices).toEqual([]);
  });

  it('reports a coin the resolver CAN place as resolvable, with the one answer', () => {
    /* After the user adds the missing issuer (here the Roman Empire), the group
     * is resolvable in one click, not "nothing matches". */
    const census = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Denarius', country: 'Roman Empire' })],
      LOOKUP
    );

    expect(census.groups[0].reason).toBe('resolvable');
    expect(census.groups[0].choices).toEqual([
      { denominationId: 40, label: 'Denarius', issuerName: 'Roman Empire' },
    ]);
  });

  it('never merges coins the same text resolves DIFFERENTLY for', () => {
    /* 'Penny' under Great Britain is id 30, under Australia id 31; grouping by
     * text alone would let one click file the Australian coin under Great Britain.
     * The Australian coin comes first so only the final `key` tie-break can
     * order the two identical-looking groups. */
    const census = censusUnlinkedDenominations(
      [
        coin({ id: 'b', denomination: 'Penny', country: 'Australia' }),
        coin({ id: 'a', denomination: 'Penny', country: 'Great Britain' }),
      ],
      LOOKUP
    );

    expect(census.groups).toHaveLength(2);
    expect(census.groups.map((group) => group.choices.map((choice) => choice.denominationId))).toEqual([
      [30],
      [31],
    ]);
    expect(census.groups.map((group) => group.coins.map((row) => row.coinId))).toEqual([['a'], ['b']]);
  });

  it('folds spellings together through the SAME alias table the editor uses', () => {
    /* '3CS' and 'Three Cent Silver' are one group; the heading names both spellings. */
    const lookup = [denomination({ denominationId: 60, label: '3¢ Silver', country: 'US' })];
    const census = censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: 'Three Cent Silver', country: 'Mexico' }),
        coin({ id: 'b', denomination: '3CS', country: 'Mexico' }),
      ],
      lookup
    );

    expect(census.groups).toHaveLength(1);
    expect(census.groups[0].coinCount).toBe(2);
    expect(census.groups[0].recordedTexts).toEqual(['3CS', 'Three Cent Silver']);
    expect(census.groups[0].heading).toBe('3CS / Three Cent Silver');
  });

  it('skips unsaved drafts and says how many it skipped', () => {
    // Drafts have no database row (a PUT would 404) and are still being typed.
    const census = censusUnlinkedDenominations(
      [coin({ id: 'draft' }), coin({ id: 'saved' })],
      LOOKUP,
      (id) => id === 'draft'
    );

    expect(census.skippedDraftCount).toBe(1);
    expect(census.unlinkedCount).toBe(1);
    expect(census.groups[0].coins.map((row) => row.coinId)).toEqual(['saved']);
  });

  it('orders groups: one-click fixes first, then by how many coins they hold', () => {
    /* Input is in the wrong order for every tie-break, so removing the sort
     * can't leave the expectation satisfied by accident. */
    const census = censusUnlinkedDenominations(
      [
        coin({ id: 'z1', denomination: '' }),
        coin({ id: 'u1', denomination: 'Trade Dollar' }),
        coin({ id: 'a1', denomination: '8 Reales', country: 'United States' }),
        coin({ id: 'r1', denomination: 'Denarius', country: 'Roman Empire' }),
        coin({ id: 'a2', denomination: '8 Reales', country: 'United States' }),
      ],
      LOOKUP
    );

    expect(census.groups.map((group) => `${group.reason}:${group.coinCount}`)).toEqual([
      'resolvable:1',
      'ambiguous:2',
      'unknown:1',
      'nothing-recorded:1',
    ]);
  });

  it('counts by reason, and the counts add up to the total', () => {
    const census = censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: '8 Reales', country: 'United States' }),
        coin({ id: 'b', denomination: 'Trade Dollar' }),
        coin({ id: 'c', denomination: '__OTHER__' }),
        coin({ id: 'd', denomination: 'Denarius', country: 'Roman Empire' }),
        coin({ id: 'e', denomination: 'Quarter', denominationId: 20 }),
      ],
      LOOKUP
    );

    expect(census.countsByReason).toEqual({
      resolvable: 1,
      ambiguous: 1,
      unknown: 1,
      'nothing-recorded': 1,
    });
    const summed = Object.values(census.countsByReason).reduce((a, b) => a + b, 0);
    expect(summed).toBe(census.unlinkedCount);
    expect(census.totalCoins).toBe(5);
  });
});

describe('describeUnlinkedCensus — the count, said out loud, including zero', () => {
  it('says so plainly when there is nothing to fix', () => {
    /* The zero state says so, rather than rendering nothing. */
    const census = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Quarter', denominationId: 20 })],
      LOOKUP
    );

    expect(describeUnlinkedCensus(census)).toBe('Every coin has a denomination. 1 coin checked.');
  });

  it('is singular for one coin', () => {
    const census = censusUnlinkedDenominations([coin({ id: 'a', denomination: '' })], LOOKUP);
    expect(describeUnlinkedCensus(census)).toBe('1 coin has no denomination linked.');
  });

  it('names the number of coins and the number of decisions', () => {
    const census = censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: '8 Reales', country: 'United States' }),
        coin({ id: 'b', denomination: '8 Reales', country: 'United States' }),
        coin({ id: 'c', denomination: 'Trade Dollar' }),
      ],
      LOOKUP
    );

    expect(describeUnlinkedCensus(census)).toBe('3 coins have no denomination linked, in 2 groups.');
  });

  it('says nothing before the lookup has arrived', () => {
    expect(describeUnlinkedCensus(censusUnlinkedDenominations([coin({ id: 'a' })], []))).toBe('');
  });
});

describe('describeUnlinkedReason — telling the user what is wrong, in their words', () => {
  it('explains each reason without using the resolver\'s vocabulary', () => {
    /* Plain-language sentences, not the resolver's terms. */
    const described = (['resolvable', 'ambiguous', 'unknown', 'nothing-recorded'] as const).map(
      (reason) => describeUnlinkedReason(reason)
    );

    for (const sentence of described) {
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence.toLowerCase()).not.toContain('ambiguous');
      expect(sentence.toLowerCase()).not.toContain('resolv');
      expect(sentence.toLowerCase()).not.toContain('null');
    }

    // Four different sentences.
    expect(new Set(described).size).toBe(4);
  });
});

describe('planUnlinkedFix — what the bulk button would write', () => {
  const ambiguous = () =>
    censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: '8 Reales', country: 'United States' }),
        coin({ id: 'b', denomination: '8 Reales', country: 'United States' }),
      ],
      LOOKUP
    ).groups[0];

  it('writes the id and the CHOSEN LABEL to every coin in the group', () => {
    /* Both fields are written and agree: the text is the chosen row's label, not
     * the coin's existing text. */
    const plan = planUnlinkedFix(ambiguous(), 10, LOOKUP);

    expect(plan.refusal).toBe('');
    expect(plan.denominationLabel).toBe('8 Reales');
    expect(plan.issuerName).toBe('Mexico');
    expect(plan.candidates.map((candidate) => candidate.coinId)).toEqual(['a', 'b']);
    for (const candidate of plan.candidates) {
      expect(candidate.updates).toEqual({ denominationId: 10, denomination: '8 Reales' });
    }
  });

  it('writes the label of the row that was chosen, never the recorded text', () => {
    /* The coin's own spelling must not be written back: after a deliberate choice
     * text and id must agree (§4.1). */
    const lookup = [denomination({ denominationId: 60, label: '3¢ Silver', country: 'US' })];
    const group = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Three Cent Silver', country: 'Mexico' })],
      lookup
    ).groups[0];

    const plan = planUnlinkedFix(group, 60, lookup);
    expect(plan.candidates[0].updates.denomination).toBe('3¢ Silver');
  });

  it('refuses, and writes nothing, when no denomination has been chosen', () => {
    const plan = planUnlinkedFix(ambiguous(), null, LOOKUP);

    expect(plan.candidates).toEqual([]);
    expect(plan.refusal).toBe('Choose a denomination first.');
  });

  it('refuses an id the active lookup does not hold', () => {
    /* An id removed or retired since the pane was rendered must not be written. */
    const retired = planUnlinkedFix(ambiguous(), 50, LOOKUP);
    expect(retired.candidates).toEqual([]);
    expect(retired.refusal).toBe('That denomination is no longer in the list.');

    const missing = planUnlinkedFix(ambiguous(), 9999, LOOKUP);
    expect(missing.candidates).toEqual([]);
    expect(missing.refusal).toBe('That denomination is no longer in the list.');
  });

  it('leaves a country the user has already recorded exactly as it is', () => {
    /* The editor's rule (`denominationChoiceUpdates`): a coin's existing country
     * stands, so linking 'United States' 8 Reales to Mexico's row doesn't change it. */
    const plan = planUnlinkedFix(ambiguous(), 10, LOOKUP);
    for (const candidate of plan.candidates) {
      expect(candidate.updates.country).toBeUndefined();
    }
    expect(plan.countryWrites).toBe(0);
  });

  it('fills a BLANK country when exactly one issuer could be meant', () => {
    // Other branch of the same rule: 'Quarter' has one issuer, so a coin with no
    // country gains 'United States'.
    const group = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Quarter', country: '' })],
      LOOKUP
    ).groups[0];

    const plan = planUnlinkedFix(group, 20, LOOKUP);
    expect(plan.candidates[0].updates.country).toBe('United States');
    expect(plan.countryWrites).toBe(1);
  });

  it('sets the country to the chosen issuer when, and only when, asked to', () => {
    /* Opt-in "set the country": overwrites the coin's country with the chosen
     * issuer (country is a display and search field, §4.2). Never the default. */
    const plan = planUnlinkedFix(ambiguous(), 10, LOOKUP, { setCountry: true });

    expect(plan.countryWrites).toBe(2);
    for (const candidate of plan.candidates) {
      expect(candidate.updates).toEqual({
        denominationId: 10,
        denomination: '8 Reales',
        country: 'Mexico',
      });
    }
  });

  it('never sends a field outside the three it is allowed to write', () => {
    /* The payload contains only UNLINKED_FIX_FIELDS (enforced by onlyUnlinkedFixFields). */
    const plan = planUnlinkedFix(ambiguous(), 10, LOOKUP, { setCountry: true });
    for (const candidate of plan.candidates) {
      for (const key of Object.keys(candidate.updates)) {
        expect(UNLINKED_FIX_FIELDS).toContain(key);
      }
    }

    expect(onlyUnlinkedFixFields({ denomination: 'x', grade: 'MS65', notes: 'hi' } as Partial<CoinRecord>))
      .toEqual({ denomination: 'x' });
  });
});

describe('describeUnlinkedFixPlan — the question asked before a bulk write', () => {
  const ambiguous = () =>
    censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: '8 Reales', country: 'United States' }),
        coin({ id: 'b', denomination: '8 Reales', country: 'United States' }),
      ],
      LOOKUP
    ).groups[0];

  it('says the number plainly, and what will be written', () => {
    /* The confirmation states the number of coins. */
    expect(describeUnlinkedFixPlan(planUnlinkedFix(ambiguous(), 10, LOOKUP))).toBe(
      'Link 2 coins to "8 Reales" (Mexico)?\n\n' +
        'Their Denomination text will be set to "8 Reales".'
    );
  });

  it('is singular for one coin', () => {
    const group = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: '8 Reales', country: 'United States' })],
      LOOKUP
    ).groups[0];
    expect(describeUnlinkedFixPlan(planUnlinkedFix(group, 10, LOOKUP))).toContain('Link 1 coin to');
  });

  it('warns separately about the country, because that overwrites real data', () => {
    expect(
      describeUnlinkedFixPlan(planUnlinkedFix(ambiguous(), 10, LOOKUP, { setCountry: true }))
    ).toBe(
      'Link 2 coins to "8 Reales" (Mexico)?\n\n' +
        'Their Denomination text will be set to "8 Reales".\n' +
        'Country will be set to "Mexico" on 2 coins.'
    );
  });

  it('hands back the refusal rather than a question', () => {
    expect(describeUnlinkedFixPlan(planUnlinkedFix(ambiguous(), null, LOOKUP))).toBe(
      'Choose a denomination first.'
    );
  });
});

describe('describeUnlinkedFixOutcome — what happened', () => {
  it('reports a clean run', () => {
    expect(
      describeUnlinkedFixOutcome({ attempted: 4, linked: 4, failed: 0, failures: [] }, '8 Reales')
    ).toBe('Linked 4 coins to "8 Reales".');
  });

  it('reports a partial run with the number that did NOT make it', () => {
    // Partial runs read "4 of 5".
    expect(
      describeUnlinkedFixOutcome(
        { attempted: 5, linked: 4, failed: 1, failures: [{ coinId: 'a', label: '1890', reason: 'locked' }] },
        '8 Reales'
      )
    ).toBe('Linked 4 of 5 coins to "8 Reales". 1 could not be saved: 1890 (locked).');
  });
});

describe('runUnlinkedFix — writing the plan', () => {
  it('writes every coin exactly once, one at a time', async () => {
    const group = censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: '8 Reales', country: 'United States' }),
        coin({ id: 'b', denomination: '8 Reales', country: 'United States' }),
      ],
      LOOKUP
    ).groups[0];
    const plan = planUnlinkedFix(group, 10, LOOKUP);

    let inFlight = 0;
    let maxInFlight = 0;
    const write = vi.fn(async (_id: string, _updates: Partial<CoinRecord>) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    const outcome = await runUnlinkedFix(plan, write);

    expect(write).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(outcome).toEqual({ attempted: 2, linked: 2, failed: 0, failures: [] });
  });

  it('keeps going after a failure and names the coin that failed', async () => {
    const group = censusUnlinkedDenominations(
      [
        coin({ id: 'a', denomination: '8 Reales', country: 'United States', year: '1890' }),
        coin({ id: 'b', denomination: '8 Reales', country: 'United States' }),
      ],
      LOOKUP
    ).groups[0];
    const plan = planUnlinkedFix(group, 10, LOOKUP);

    const write = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('row is locked');
    });

    const outcome = await runUnlinkedFix(plan, write);

    expect(write).toHaveBeenCalledTimes(2);
    expect(outcome.linked).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures).toEqual([{ coinId: 'a', label: '1890 United States', reason: 'row is locked' }]);
  });

  it('writes nothing at all for a refused plan', async () => {
    const group = censusUnlinkedDenominations([coin({ id: 'a', denomination: '' })], LOOKUP).groups[0];
    const write = vi.fn(async () => undefined);

    const outcome = await runUnlinkedFix(planUnlinkedFix(group, null, LOOKUP), write);

    expect(write).not.toHaveBeenCalled();
    expect(outcome.attempted).toBe(0);
  });
});
