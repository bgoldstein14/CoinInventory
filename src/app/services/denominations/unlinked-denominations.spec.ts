 /*
 * unlinked-denominations.spec.ts — the cleanup screen's whole brain
 *
 * WHAT IS BEING PROTECTED HERE
 *
 * This module decides which coins are shown as "needs a denomination", why,
 * and -- when the button is pressed -- what gets written to
 * every coin in a group at once. Two of those are dangerous:
 *
 *   * A WRONG CLASSIFICATION sends him to the wrong fix. Telling him nothing
 *     in the reference list matches `__OTHER__` invites him to ADD
 *     `__OTHER__` to the reference list, which would be a real denomination
 *     row named after a UI sentinel, for ever.
 *   * A WRONG WRITE rewrites `Coins.Denomination` on several coins at once.
 *     Design §4.1 is explicit that nothing may write that column except a
 *     label the user explicitly chose, and this is the only bulk writer of it
 *     in the application.
 *
 * So most of what follows is about refusals and about exactness.
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

/** A coin with everything blank EXCEPT whatever the test overrides. */
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

/* A deliberately small lookup with the three shapes that matter:
 *   '8 Reales'  under TWO issuers  -> ambiguous
 *   'Quarter'   under ONE issuer   -> resolvable / linkable
 *   'Penny'     under TWO issuers  -> resolvable to DIFFERENT ids depending
 *                                     on the coin's own country            */
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
    /* THE BUG THIS PREVENTS, and it would have been the first thing the owner
     * saw on every start-up: `GET /api/denominations` has not landed yet, so
     * the lookup is []. Every coin in the collection then fails to resolve,
     * and a naive census reports "105 coins have no denomination" one second
     * before they all link. The banner would flash on every launch and the
     * pane would be wrong for anyone who opened it quickly. */
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
    /* §4.4 nulls the id when a denomination is deleted, so this state is not
     * supposed to happen — but "not supposed to" is not "cannot", and a coin
     * pointing at a soft-deleted row renders `Other (...)` exactly like an
     * unlinked one. The screen's contract is "every coin that does not show a
     * real denomination", so it must catch this too. */
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
    /* *** THE OWNER'S ONE REAL CASE. ***
     * Migration 014 reported exactly one unresolved value across his whole
     * collection: a Peruvian coin holding the literal string `__OTHER__`,
     * residue from a fixed editor bug. `denominationDisplay` already renders
     * that coin as `—`, i.e. "nothing recorded".
     *
     * `resolveDenomination` cannot know that: it sees text, finds no row
     * naming it, and answers 'unknown'. If this screen repeated the
     * resolver's verdict it would tell him "nothing in the reference list
     * resolver's verdict it would say "nothing in the reference list
     * matches __OTHER__ -- add it to the list", which would put a
     * denomination named after a UI sentinel into the database permanently. */
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
    /* How a user reaches this state: a coin reads 'Denarius', the Roman
     * Empire was not in the reference list when it was imported, and they
     * have just added it on the Denominations pane. Reporting that group as
     * "nothing matches" afterwards would be a lie, and the fix is one click. */
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
    /* *** THE BULK-WRITE SAFETY PROPERTY. ***
     * 'Penny' under Great Britain is id 30; under Australia it is id 31. If
     * the grouping keyed on the text alone, one group would hold both coins
     * and one click would file the Australian penny under Great Britain --
     * silently, on a screen whose whole purpose is to fix exactly that kind
     * of mistake. */
    /* THE AUSTRALIAN COIN IS FIRST ON PURPOSE. The two groups are identical
     * on every tie-break the sort applies -- same reason, same coin count,
     * same heading 'Penny' -- so the only thing separating them is the final
     * comparison on `key`. Feeding them in id order would leave the expected
     * output equal to the INSERTION order, and deleting that last tie-break
     * would then be a no-op the test could not see. */
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
    /* '3CS' and 'Three Cent Silver' are one denomination. Two groups would
     * mean two decisions for one answer, which is the thing that makes people
     * abandon a cleanup. The heading names both spellings so the user can see
     * what is in the group before acting on it. */
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
    // A draft has no database row, so a PUT would 404. It is also a coin the
    // user is typing right now, which is not a cleanup candidate.
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
    /* The input below is deliberately in the WRONG order for every tie-break
     * at once -- nothing-recorded first, the 1-coin ambiguous group before the
     * 2-coin one -- so that removing the sort cannot leave the expectation
     * accidentally satisfied. */
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
    /* "Every coin has a denomination" is a useful thing to be told. A screen
     * that renders nothing is indistinguishable from a broken one. */
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
    /* 'ambiguous' and 'any-issuer' are the RESOLVER'S words and they are the
     * right words inside the code. On screen they are jargon in front of
     * somebody who just wants their coin to say "8 Reales". */
    const described = (['resolvable', 'ambiguous', 'unknown', 'nothing-recorded'] as const).map(
      (reason) => describeUnlinkedReason(reason)
    );

    for (const sentence of described) {
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence.toLowerCase()).not.toContain('ambiguous');
      expect(sentence.toLowerCase()).not.toContain('resolv');
      expect(sentence.toLowerCase()).not.toContain('null');
    }

    // And they are four DIFFERENT sentences, not one sentence four times.
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
    /* §4.1's write rule, applied to a group: both fields, and they agree from
     * then on. The text written is the label of the row the user picked --
     * NOT the text the coin happened to be carrying. */
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
    /* The coin says 'Three Cent Silver'; the reference row is '3¢ Silver'.
     * Writing the coin's own spelling back would leave the text and the id
     * disagreeing on a DELIBERATE action, which is precisely the divergence
     * §4.1 allows only for imports and deletions. */
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
    /* Belt and braces over the UI. An id that has been removed or retired
     * since the pane was rendered must not become a write -- the server would
     * accept the FK and the coin would point at a row nothing can display. */
    const retired = planUnlinkedFix(ambiguous(), 50, LOOKUP);
    expect(retired.candidates).toEqual([]);
    expect(retired.refusal).toBe('That denomination is no longer in the list.');

    const missing = planUnlinkedFix(ambiguous(), 9999, LOOKUP);
    expect(missing.candidates).toEqual([]);
    expect(missing.refusal).toBe('That denomination is no longer in the list.');
  });

  it('leaves a country the user has already recorded exactly as it is', () => {
    /* The editor's rule (`denominationChoiceUpdates`), reused rather than
     * restated: the user has said what country this is, and their answer
     * stands. '8 Reales' coins often say 'United States'; linking them
     * to Mexico's row must not quietly rewrite that. */
    const plan = planUnlinkedFix(ambiguous(), 10, LOOKUP);
    for (const candidate of plan.candidates) {
      expect(candidate.updates.country).toBeUndefined();
    }
    expect(plan.countryWrites).toBe(0);
  });

  it('fills a BLANK country when exactly one issuer could be meant', () => {
    // Same editor rule, other branch: 'Quarter' exists under one issuer only,
    // so a coin with no country gains 'United States'.
    const group = censusUnlinkedDenominations(
      [coin({ id: 'a', denomination: 'Quarter', country: '' })],
      LOOKUP
    ).groups[0];

    const plan = planUnlinkedFix(group, 20, LOOKUP);
    expect(plan.candidates[0].updates.country).toBe('United States');
    expect(plan.countryWrites).toBe(1);
  });

  it('sets the country to the chosen issuer when, and only when, asked to', () => {
    /* The second half of the ambiguous fix: "pick the issuer, OR set the
     * country". Picking Mexico's 8 Reales for a coin filed under the United
     * States links it correctly but leaves the country wrong, and the country
     * is a display and search field (§4.2). So the user may opt in -- and
     * because it overwrites a value they typed, it is opt-IN, never default. */
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
    /* This project has a history of whole-record writes blanking columns the
     * user never touched. `onlyUnlinkedFixFields` is the enforcement and this
     * is the test that names the same list. */
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
    /* §4.4's rule for the delete dialog applies just as much to a bulk
     * write: say the number. "Link these coins?" with no figure is how a
     * user ends up rewriting forty rows meaning to rewrite four. */
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
    // "4 of 5" is the honest form. "Linked 4 coins" after asking about 5
    // would leave one silently unfixed on a screen the user is about to
    // close.
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
