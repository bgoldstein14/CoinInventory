/*
 * reference-usage.spec.ts — "how many coins use this?", and what Remove does.
 *
 * Removing a denomination, in order:
 *
 *   1. Count the coins using it. Say the number PLAINLY.
 *   2. If confirmed: soft-delete, and null those coins' DenominationId.
 *   3. Coins.Denomination TEXT is NEVER touched, so they read the unresolved
 *      display form.
 *   4. Re-selecting a denomination re-links them. Nothing is lost.
 *
 * The count has to be on screen BEFORE the dialog, and the dialog has to
 * repeat it: "are you sure?" with no number in it is a question the user has
 * no way to answer.
 *
 * NOTE ON THE WORDING of the "what those coins will read afterwards" string:
 * it is built by denominationDisplay() and nowhere else. That is enforced by
 * a grep in services/denominations/denomination-display.spec.ts, and it is
 * the reason this module imports a function to produce what looks like a
 * two-line template.
 */

import { describe, expect, it } from 'vitest';

import { denominationDisplay } from '../../services/denominations/denomination-display';
import {
  EMPTY_REFERENCE_USAGE,
  buildUsageIndex,
  describeUsage,
  planDenominationRemoval,
  planReferenceRemoval,
  usageCount,
} from './reference-usage';

describe('buildUsageIndex', () => {
  it('turns count rows into a key -> number lookup', () => {
    expect(buildUsageIndex([{ key: 'Gold', count: 4 }, { key: 'Silver', count: 1 }])).toEqual({
      Gold: 4,
      Silver: 1,
    });
  });

  it('keys numeric ids as strings, so an id from JSON and an id from a template agree', () => {
    // THE BUG THIS GUARDS: a count keyed by the number 103 and looked up
    // with the string '103' reading 0, so the screen offers to delete a
    // denomination three coins are using while promising none are.
    //
    // HONESTY NOTE, because the next person to mutation-test this will find
    // it: in JavaScript the explicit String() calls in buildUsageIndex and
    // usageCount are belt-and-braces. Object property keys are coerced to
    // strings on assignment AND on read, so removing either call leaves
    // this test green — verified. The call stays because the TYPE says
    // Record<string, number> and a reader must not have to know the
    // coercion rule to trust it; what this test actually pins is the
    // CONTRACT — both spellings answer 3 — which would break the moment the
    // index became a Map, where no coercion happens.
    const index = buildUsageIndex([{ key: 103, count: 3 }]);
    expect(index['103']).toBe(3);
    expect(usageCount(index, 103)).toBe(3);
    expect(usageCount(index, '103')).toBe(3);
  });

  it('coerces a count that arrived as a string', () => {
    expect(buildUsageIndex([{ key: 'Gold', count: '4' }])['Gold']).toBe(4);
  });

  it('drops rows with no key rather than inventing an "undefined" bucket', () => {
    expect(buildUsageIndex([{ key: null, count: 9 }, { key: '', count: 9 }])).toEqual({});
  });

  it('reads a count it cannot make sense of as zero', () => {
    expect(buildUsageIndex([{ key: 'Gold', count: null }])['Gold']).toBe(0);
    expect(buildUsageIndex([{ key: 'Gold', count: 'many' }])['Gold']).toBe(0);
  });
});

describe('usageCount', () => {
  it('answers zero for a key nobody counted', () => {
    // Zero, not undefined. An undefined reaching the template renders as a
    // blank where a number belongs, which reads as "unknown" — and the whole
    // point of this screen is that the consequence is KNOWN before the
    // dialog appears.
    expect(usageCount({ Gold: 3 }, 'Silver')).toBe(0);
  });

  it('answers zero for a missing index or a missing key', () => {
    expect(usageCount(undefined, 'Gold')).toBe(0);
    expect(usageCount({ Gold: 3 }, null)).toBe(0);
    expect(usageCount({ Gold: 3 }, undefined)).toBe(0);
  });

  it('starts out empty across every reference type', () => {
    expect(usageCount(EMPTY_REFERENCE_USAGE.denominations, 1)).toBe(0);
    expect(usageCount(EMPTY_REFERENCE_USAGE.categories, 'Gold')).toBe(0);
    expect(usageCount(EMPTY_REFERENCE_USAGE.coinSets, 'Morgan Set')).toBe(0);
    expect(usageCount(EMPTY_REFERENCE_USAGE.mintMarks, 1)).toBe(0);
    expect(usageCount(EMPTY_REFERENCE_USAGE.catalogs, 1)).toBe(0);
    expect(usageCount(EMPTY_REFERENCE_USAGE.metalContents, '90% Silver')).toBe(0);
  });

  it('has an index for every type the endpoint returns, and no more', () => {
    /* A type added to ReferenceUsageCounts but forgotten here would be
     * `undefined` on this object, and `usageCount` would answer 0 for it
     * for ever — a pane whose badges all read "Not used by any coin" even
     * when every entry is in use, which is the one wrong answer this
     * screen must never give. */
    expect(Object.keys(EMPTY_REFERENCE_USAGE).sort()).toEqual([
      'catalogs',
      'categories',
      'coinSets',
      'denominations',
      'metalContents',
      'mintMarks',
    ]);
  });
});

describe('describeUsage — the number, said plainly', () => {
  it('says nothing is using it', () => {
    expect(describeUsage(0)).toBe('Not used by any coin');
  });

  it('gets the singular right', () => {
    // "Used by 1 coins" on a screen whose whole job is to be trusted about
    // numbers is a small thing that costs trust.
    expect(describeUsage(1)).toBe('Used by 1 coin');
  });

  it('says the plural number', () => {
    expect(describeUsage(12)).toBe('Used by 12 coins');
  });

  it('never shows a negative or a fractional count', () => {
    expect(describeUsage(-3)).toBe('Not used by any coin');
    expect(describeUsage(Number.NaN)).toBe('Not used by any coin');
  });
});

describe('planDenominationRemoval — §4.4 steps 1 to 4', () => {
  it('states the count in the prompt when coins are using it', () => {
    const plan = planDenominationRemoval({ label: '8 Reales', denominationId: 103 }, 3);
    expect(plan.coinCount).toBe(3);
    expect(plan.prompt).toContain('3 coins');
    expect(plan.prompt).toContain('8 Reales');
  });

  it('promises exactly what those coins will read afterwards, via denominationDisplay', () => {
    // The unresolved display form, and the only legal way to produce it. If
    // this ever disagrees with the grid, the dialog is promising one
    // spelling while the grid shows another.
    const plan = planDenominationRemoval({ label: '8 Reales', denominationId: 103 }, 3);
    expect(plan.resultingDisplay).toBe(denominationDisplay(null, '8 Reales'));
    expect(plan.prompt).toContain(plan.resultingDisplay);
  });

  it('says the text is kept and the link can be remade', () => {
    // Step 4 is the reassurance that makes step 2 acceptable. If the prompt
    // only said "3 coins will lose their denomination" the honest user
    // cancels, and the mess stays.
    const plan = planDenominationRemoval({ label: '8 Reales', denominationId: 103 }, 3);
    expect(plan.prompt.toLowerCase()).toContain('re-select');
  });

  it('does not threaten anything when no coin uses it', () => {
    const plan = planDenominationRemoval({ label: 'Onza', denominationId: 7 }, 0);
    expect(plan.coinCount).toBe(0);
    expect(plan.prompt).toContain('No coins use it');
    expect(plan.prompt).not.toContain('re-select');
  });

  it('gets the singular right here too', () => {
    const plan = planDenominationRemoval({ label: 'Denarius', denominationId: 106 }, 1);
    expect(plan.prompt).toContain('1 coin ');
    expect(plan.prompt).not.toContain('1 coins');
  });

  it('carries the id through untouched, so the caller deletes what it asked about', () => {
    expect(planDenominationRemoval({ label: 'Denarius', denominationId: 106 }, 1).denominationId).toBe(106);
  });
});

describe('planReferenceRemoval — the other five types', () => {
  it('names the type and the entry and states the count', () => {
    const plan = planReferenceRemoval('category', 'Gold', 5);
    expect(plan.prompt).toContain('category');
    expect(plan.prompt).toContain('Gold');
    expect(plan.prompt).toContain('5 coins');
  });

  it('says plainly when nothing uses it', () => {
    expect(planReferenceRemoval('mint mark', 'CC', 0).prompt).toContain('No coins use it');
  });

  it('does NOT promise the denomination re-link wording', () => {
    // Removing a category does not null a column on five coins and leave a
    // recoverable text behind — it is a different consequence and borrowing
    // the reassuring sentence would be a lie.
    const plan = planReferenceRemoval('category', 'Gold', 5);
    expect(plan.prompt.toLowerCase()).not.toContain('re-select');
  });
});
