/**
 * Tests for the editor's automatic alloy / weight fill. Mostly about what it
 * refuses to do: overwrite a value without asking, ask when nothing would
 * change, ask more than once per coin, write anything after a declined
 * prompt, or overwrite the field just edited. The inference itself is tested
 * elsewhere; here only that it is reached through pm-fill.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../types/coin.model';
import {
  AUTOFILL_KEY_FIELDS,
  PmAutofillPlan,
  describePmAutofillConflicts,
  isAutofillKeyField,
  planPmAutofill,
  pmAutofillWrites
} from './pm-autofill';
import { PM_FIELD_KEYS, inferPmFields } from './pm-fill';

/*
 * Pass-through mock: the real inference runs, but calls are observable, so a
 * test can assert the inference didn't run at all.
 */
vi.mock('./pm-fill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pm-fill')>();
  return { ...actual, inferPmFields: vi.fn(actual.inferPmFields) };
});

/** A coin with nothing filled in except the overrides. */
function coin(overrides: Partial<CoinRecord>): CoinRecord {
  return {
    id: 'c1',
    denomination: '',
    year: '',
    coinType: '',
    category: '',
    country: 'United States',
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
    ...overrides
  };
}

/** A 1964 Kennedy half: unambiguous in the table, answers all five fields. */
const HALF_1964 = { denomination: '50¢', year: '1964', country: 'United States' };
const HALF_1964_ANSWER = {
  metalContent: 'Silver',
  composition: '90% Silver, 10% Copper',
  pmPercent: 90,
  pmWeightGrams: 11.25,
  weight: 12.5
};

/** A fully recorded 1879 Morgan dollar: the "before" of the $1 -> $20 case. */
const MORGAN_1879: Partial<CoinRecord> = {
  denomination: '$1',
  year: '1879',
  country: 'United States',
  metalContent: 'Silver',
  composition: '90% Silver, 10% Copper',
  pmPercent: 90,
  pmWeightGrams: 24.06,
  weight: 26.73
};

function conflictOn(plan: PmAutofillPlan, field: string) {
  return plan.conflicts.find((c) => c.field === field);
}

beforeEach(() => {
  vi.mocked(inferPmFields).mockClear();
});

/* 1. Blanks fill silently */

describe('blank fields', () => {
  it('fills every blank alloy field once the denomination is committed', () => {
    const plan = planPmAutofill(coin(HALF_1964), { changed: ['denomination'] });

    expect(plan.conflicts).toEqual([]);
    expect(plan.needsConfirmation).toBe(false);
    expect(plan.fills).toEqual(HALF_1964_ANSWER);
    // Nothing to ask, so the writes are the fills regardless of the answer.
    expect(pmAutofillWrites(plan, false)).toEqual(HALF_1964_ANSWER);
  });

  it('fills blanks with no key change at all, for a coin that is merely incomplete', () => {
    const plan = planPmAutofill(coin({ ...HALF_1964, metalContent: 'Silver' }));

    expect(plan.needsConfirmation).toBe(false);
    expect(plan.fills).toEqual({
      composition: '90% Silver, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 11.25,
      weight: 12.5
    });
  });

  it('writes only keys from PM_FIELD_KEYS — never a column the user was editing', () => {
    const plan = planPmAutofill(coin(HALF_1964), { changed: ['denomination'] });
    const allowed = new Set<string>(PM_FIELD_KEYS);
    for (const key of Object.keys(pmAutofillWrites(plan, true))) {
      expect(allowed.has(key)).toBe(true);
    }
  });
});

 /*
  * 1b. Nothing is invented. When only the coarse fallback places a coin, it
  * answers the metal alone. Assertions use `Object.keys` because `toEqual`
  * ignores undefined properties; without the "skip undefined" guard an unknown
  * value would also be raised as a conflict against the user's own weight.
  */

describe('a coin only the coarse metal fallback can place', () => {
  // No country, so no table row; the fallback only knows a "$20" is gold.
  const COARSE_ONLY = { denomination: '$20', year: '1879', country: '' };

  it('fills the metal and introduces no other keys', () => {
    const plan = planPmAutofill(coin(COARSE_ONLY), { changed: ['denomination'] });

    expect(Object.keys(plan.fills)).toEqual(['metalContent']);
    expect(plan.fills).toStrictEqual({ metalContent: 'Gold' });
    expect(Object.keys(pmAutofillWrites(plan, true))).toEqual(['metalContent']);
  });

  it('raises no conflict about the facts it does not have', () => {
    const plan = planPmAutofill(coin({ ...COARSE_ONLY, weight: 33.0, pmPercent: 92 }), {
      changed: ['denomination']
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.needsConfirmation).toBe(false);
    expect(Object.keys(plan.fills)).toEqual(['metalContent']);
  });
});

/* 2. Nothing to say, so say nothing */

describe('when the inference agrees with the record', () => {
  it('neither prompts nor writes when every inferred value is already there', () => {
    const plan = planPmAutofill(coin({ ...HALF_1964, ...HALF_1964_ANSWER }), {
      changed: ['year']
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.fills).toEqual({});
    expect(plan.needsConfirmation).toBe(false);
    expect(plan.hasWork).toBe(false);
    expect(pmAutofillWrites(plan, true)).toEqual({});
  });

  it('does not prompt over a difference smaller than the stored precision', () => {
    // Database rounding (Weight DECIMAL(12,5), PM % DECIMAL(5,2)) isn't a disagreement.
    const plan = planPmAutofill(
      coin({ ...HALF_1964, ...HALF_1964_ANSWER, weight: 12.500002, pmPercent: 90.001 }),
      { changed: ['year'] }
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.hasWork).toBe(false);
  });

  it('does not prompt over letter case or stray spaces in a text field', () => {
    const plan = planPmAutofill(
      coin({ ...HALF_1964, ...HALF_1964_ANSWER, metalContent: '  silver ' }),
      { changed: ['year'] }
    );

    expect(conflictOn(plan, 'metalContent')).toBeUndefined();
  });

  it('DOES prompt over a difference the user would see', () => {
    const plan = planPmAutofill(coin({ ...HALF_1964, ...HALF_1964_ANSWER, weight: 12.4 }), {
      changed: ['year']
    });

    expect(plan.conflicts.map((c) => c.field)).toEqual(['weight']);
  });
});

/* 3. Conflicts */

describe('conflicts', () => {
  it('reports the field, the current value and the proposed one', () => {
    const plan = planPmAutofill(
      coin({ ...HALF_1964, ...HALF_1964_ANSWER, weight: 12.4, metalContent: 'Gold' }),
      { changed: ['year'] }
    );

    expect(plan.needsConfirmation).toBe(true);
    expect(conflictOn(plan, 'weight')).toMatchObject({
      field: 'weight',
      label: 'Weight (g)',
      current: 12.4,
      proposed: 12.5
    });
    expect(conflictOn(plan, 'metalContent')).toMatchObject({
      current: 'Gold',
      proposed: 'Silver'
    });
  });

  it('asks ONE question covering every conflicting field', () => {
    const plan = planPmAutofill({ ...coin({}), ...MORGAN_1879, denomination: '$20' }, {
      changed: ['denomination']
    });

    const message = describePmAutofillConflicts(plan.conflicts);

    // One string naming every conflicting field.
    expect(typeof message).toBe('string');
    for (const conflict of plan.conflicts) {
      expect(message).toContain(conflict.label);
      expect(message).toContain(String(conflict.current));
      expect(message).toContain(String(conflict.proposed));
    }
    expect(plan.conflicts.length).toBeGreaterThan(1);
  });

  it('writes nothing at all when the prompt is declined — not even the uncontested fields', () => {
    const plan = planPmAutofill(
      coin({ ...HALF_1964, weight: 12.4 }), // weight hand-typed, the other four blank
      { changed: ['year'] }
    );

    expect(Object.keys(plan.fills).length).toBeGreaterThan(0);
    expect(plan.conflicts.map((c) => c.field)).toEqual(['weight']);
    expect(pmAutofillWrites(plan, false)).toEqual({});
  });

  it('writes the blanks AND the conflicts when the prompt is accepted', () => {
    const plan = planPmAutofill(coin({ ...HALF_1964, weight: 12.4 }), { changed: ['year'] });

    expect(pmAutofillWrites(plan, true)).toEqual(HALF_1964_ANSWER);
  });

  it('never silently overwrites a hand-typed weight', () => {
    const plan = planPmAutofill(coin({ ...HALF_1964, weight: 12.4 }), { changed: ['year'] });

    // A question, never a silent fill.
    expect(plan.fills).not.toHaveProperty('weight');
    expect(plan.needsConfirmation).toBe(true);
  });
});

/* 4. A key field changed */

describe('a key field changing', () => {
  it('corrects the stale weight when the denomination goes from $1 to $20', () => {
    const plan = planPmAutofill({ ...coin({}), ...MORGAN_1879, denomination: '$20' }, {
      changed: ['denomination']
    });

    expect(conflictOn(plan, 'weight')).toMatchObject({ current: 26.73, proposed: 33.436 });
    expect(conflictOn(plan, 'pmWeightGrams')).toMatchObject({ current: 24.06, proposed: 30.09 });
    expect(conflictOn(plan, 'metalContent')).toMatchObject({
      current: 'Silver',
      proposed: 'Gold'
    });
    // 90% either way, so not part of the question.
    expect(conflictOn(plan, 'pmPercent')).toBeUndefined();

    expect(pmAutofillWrites(plan, true)).toMatchObject({
      metalContent: 'Gold',
      pmWeightGrams: 30.09,
      weight: 33.436
    });
  });

  it('does not let the coin’s own stale metal veto the new answer', () => {
    /*
     * With the stale "Silver" as a hint no $20 row matches and the old 26.73 g
     * would remain, so the first attempt must ignore the recorded metal.
     */
    expect(inferPmFields({ ...MORGAN_1879, denomination: '$20' })).toEqual({
      metalContent: 'Silver'
    });
    expect(
      inferPmFields({ ...MORGAN_1879, denomination: '$20' }, { useRecordedMetalAsHint: false })
    ).toMatchObject({ metalContent: 'Gold', weight: 33.436 });
  });

  it('still uses the recorded metal when nothing else can break the tie', () => {
    // An 1855 "$1" is a silver or a gold dollar; the recorded metal decides.
    const plan = planPmAutofill(
      coin({ denomination: '$1', year: '1855', country: 'United States', metalContent: 'Gold' }),
      { changed: ['metalContent'] }
    );

    expect(plan.fills).toMatchObject({ pmWeightGrams: 1.5, weight: 1.672 });
  });

  it('never argues with the field the user has just edited', () => {
    // The user's own Composition is kept; the rest may be filled.
    const plan = planPmAutofill(
      coin({ ...HALF_1964, composition: 'mostly silver I think' }),
      { changed: ['composition'] }
    );

    expect(plan.fills).not.toHaveProperty('composition');
    expect(conflictOn(plan, 'composition')).toBeUndefined();
    expect(plan.fills).toMatchObject({ metalContent: 'Silver', weight: 12.5 });
  });
});

/* 5. Not enough information */

describe('insufficient information', () => {
  it('does nothing for a coin with a year and nothing else', () => {
    const plan = planPmAutofill(coin({ year: '1879' }), { changed: ['year'] });

    expect(plan.hasWork).toBe(false);
    expect(plan.fills).toEqual({});
    expect(plan.conflicts).toEqual([]);
  });

  it('does nothing where the reference table deliberately refuses to choose', () => {
    // 1942 nickel: cupronickel and 35% silver were both struck.
    const plan = planPmAutofill(
      coin({ denomination: '5¢', year: '1942', country: 'United States' }),
      { changed: ['denomination'] }
    );

    expect(plan.hasWork).toBe(false);
  });

  it('does nothing for a half-typed country', () => {
    const plan = planPmAutofill(coin({ denomination: '$20', year: '1879', country: 'U' }), {
      changed: ['country']
    });

    expect(plan.hasWork).toBe(false);
  });
});

/* 6. Nothing to reconsider */

describe('when there is nothing to reconsider', () => {
  it('does not run the inference at all for a complete coin with no key change', () => {
    const complete = coin({ ...HALF_1964, ...HALF_1964_ANSWER });

    const plan = planPmAutofill(complete);

    expect(plan.hasWork).toBe(false);
    expect(vi.mocked(inferPmFields)).not.toHaveBeenCalled();
  });

  it('DOES run it for a complete coin when a key field changed', () => {
    const complete = coin({ ...HALF_1964, ...HALF_1964_ANSWER });

    planPmAutofill(complete, { changed: ['denomination'] });

    expect(vi.mocked(inferPmFields)).toHaveBeenCalled();
  });
});

/* 7. The trigger set */

describe('AUTOFILL_KEY_FIELDS', () => {
  it('is exactly the set of coin fields the inference reads', () => {
    // Must equal `inferPmFields`'s inputs, or edits stop re-running the inference.
    expect([...AUTOFILL_KEY_FIELDS].sort()).toEqual(
      ['coinType', 'composition', 'country', 'denomination', 'metalContent', 'year'].sort()
    );
  });

  it('recognises its own members and nothing else', () => {
    expect(isAutofillKeyField('denomination')).toBe(true);
    expect(isAutofillKeyField('grade')).toBe(false);
    expect(isAutofillKeyField('notes')).toBe(false);
  });
});

/* 8. The message */

describe('describePmAutofillConflicts', () => {
  it('returns an empty string when there is nothing to ask about', () => {
    expect(describePmAutofillConflicts([])).toBe('');
  });

  it('shows the current value and the proposed one for each field', () => {
    const message = describePmAutofillConflicts([
      { field: 'weight', label: 'Weight (g)', current: 26.73, proposed: 33.436 }
    ]);

    expect(message).toContain('Weight (g)');
    expect(message).toContain('26.73');
    expect(message).toContain('33.436');
  });

  it('shows (blank) rather than nothing for an empty current value', () => {
    const message = describePmAutofillConflicts([
      { field: 'composition', label: 'Composition', current: '', proposed: '90% Silver' }
    ]);

    expect(message).toContain('(blank)');
  });
});
