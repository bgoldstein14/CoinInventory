/*
 * In-use counts and removal prompts. Removing a denomination soft-deletes it
 * and clears linked coins' DenominationId; their text is kept and they
 * re-link when a denomination is re-selected. The prompt quotes the count.
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
    // Number and string keys must find the same count. (String() is redundant
    // for plain objects but pins the contract if the index becomes a Map.)
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
    // Zero, not undefined, for missing keys.
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
    // Every usage type must be present, or its badges would always read 0.
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
    // Built by denominationDisplay(), so it matches the grid.
    const plan = planDenominationRemoval({ label: '8 Reales', denominationId: 103 }, 3);
    expect(plan.resultingDisplay).toBe(denominationDisplay(null, '8 Reales'));
    expect(plan.prompt).toContain(plan.resultingDisplay);
  });

  it('says the text is kept and the link can be remade', () => {
    // The prompt says coins can be re-linked.
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
    // Non-denomination removals use different wording: nothing is unlinked.
    const plan = planReferenceRemoval('category', 'Gold', 5);
    expect(plan.prompt.toLowerCase()).not.toContain('re-select');
  });
});
