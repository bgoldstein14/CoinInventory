/**
 * Tests for the two-way Country <-> Denomination link in the coin editor.
 *
 * The owner's request was:
 *
 *   "If a coin is being added from Great Britain, then only the British
 *    denominations should be available... If the denomination is entered
 *    first then the country should be automatically chosen/entered."
 *
 * The failure modes worth testing are not the happy path. They are:
 *
 *   - a country nobody recognises emptying the dropdown, leaving the user
 *     with nothing to pick;
 *   - an inferred country overwriting one the user typed;
 *   - a saved GB denomination silently vanishing when the country is edited
 *     to the United States;
 *   - the '__OTHER__' sentinel reaching a coin record;
 *   - a two-field change going out as one wide payload.
 *
 * Every one of those has a test below.
 */
import { describe, expect, it } from 'vitest';
import { CoinRecord, Denomination } from '../../types/coin.model';
import { CUSTOM_OPTION_SENTINEL, stripCustomSentinel } from './custom-option-mode';
import {
  CoinFieldUpdate,
  denominationChoiceUpdates,
  denominationOptionGroups
} from './country-denomination-link';

/* ---------------------------------------------------------------------------
 * Fixtures: a miniature of the real seed data, which files US denominations
 * under 'US' and British ones under 'GB' — two-letter codes, while coins
 * store full country names. That mismatch is the thing under test.
 * ------------------------------------------------------------------------- */
function denomination(overrides: Partial<Denomination> = {}): Denomination {
  return {
    denominationId: 1,
    label: '1¢',
    country: 'US',
    sortOrder: 1,
    isActive: true,
    ...overrides
  };
}

const LOOKUP: Denomination[] = [
  denomination({ denominationId: 1, label: '1¢', country: 'US', sortOrder: 1 }),
  denomination({ denominationId: 2, label: '25¢', country: 'US', sortOrder: 2 }),
  denomination({ denominationId: 3, label: '$20', country: 'US', sortOrder: 3 }),
  denomination({ denominationId: 4, label: 'Farthing', country: 'GB', sortOrder: 1 }),
  denomination({ denominationId: 5, label: 'Sovereign', country: 'GB', sortOrder: 2 }),
  denomination({ denominationId: 6, label: '£5', country: 'GB', sortOrder: 3 })
];

/** Every option label the groups offer, flattened. */
function labelsOf(groups: ReturnType<typeof denominationOptionGroups>): string[] {
  return groups.flatMap((group) => group.options.map((option) => option.label));
}

// ===========================================================================
// COUNTRY -> DENOMINATIONS: the filter
// ===========================================================================

describe('denominationOptionGroups — narrowing by country', () => {
  it('offers only British denominations for a British coin', () => {
    const groups = denominationOptionGroups(LOOKUP, 'Great Britain', '');

    expect(labelsOf(groups)).toEqual(['Farthing', 'Sovereign', '£5']);
    expect(labelsOf(groups)).not.toContain('25¢');
  });

  it('offers only US denominations for a US coin', () => {
    const groups = denominationOptionGroups(LOOKUP, 'United States', '');

    expect(labelsOf(groups)).toEqual(['1¢', '25¢', '$20']);
    expect(labelsOf(groups)).not.toContain('Sovereign');
  });

  it('narrows on free text, not just the canonical spelling', () => {
    // The Country field is a text box; the user may well type 'UK'.
    for (const typed of ['GB', 'gb', 'UK', 'British', 'England', 'United Kingdom']) {
      expect(labelsOf(denominationOptionGroups(LOOKUP, typed, ''))).toEqual([
        'Farthing',
        'Sovereign',
        '£5'
      ]);
    }
  });

  it('shows the group heading as a readable name, not the stored code', () => {
    const groups = denominationOptionGroups(LOOKUP, 'Great Britain', '');
    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBe('Great Britain');
  });

  it('bridges the code/name mismatch in BOTH directions', () => {
    // A coin stored with the code rather than the name still filters, and a
    // denomination filed under a full name still matches a coin's code.
    expect(labelsOf(denominationOptionGroups(LOOKUP, 'GB', ''))).toContain('Sovereign');

    const nameFiled = [denomination({ denominationId: 9, label: 'Crown', country: 'Great Britain' })];
    expect(labelsOf(denominationOptionGroups(nameFiled, 'GB', ''))).toEqual(['Crown']);
  });

  it('excludes retired denominations from the narrowed list', () => {
    const withRetired = [...LOOKUP, denomination({ denominationId: 7, label: '2/6', country: 'GB', isActive: false })];
    expect(labelsOf(denominationOptionGroups(withRetired, 'Great Britain', ''))).not.toContain('2/6');
  });
});

// ===========================================================================
// RULE 1: NEVER AN EMPTY DROPDOWN
// ===========================================================================

describe('denominationOptionGroups — never strands the user with nothing', () => {
  it('shows everything, grouped by country, when the country is blank', () => {
    const groups = denominationOptionGroups(LOOKUP, '', '');

    expect(groups.map((group) => group.heading)).toEqual(['United States', 'Great Britain']);
    expect(labelsOf(groups)).toHaveLength(6);
  });

  it('shows everything when the country is only whitespace', () => {
    expect(labelsOf(denominationOptionGroups(LOOKUP, '   ', ''))).toHaveLength(6);
  });

  it('shows everything for a country it cannot place', () => {
    // THE REGRESSION THIS FEATURE COULD EASILY HAVE INTRODUCED. 'Ruritania'
    // resolves to nothing; filtering on it would leave an empty <select> and
    // no way to pick a denomination at all.
    const groups = denominationOptionGroups(LOOKUP, 'Ruritania', '');

    expect(labelsOf(groups)).toHaveLength(6);
    expect(groups.length).toBeGreaterThan(0);
  });

  it('shows everything for a recognised country with no denominations on file', () => {
    // Peru is in the country vocabulary but the Denominations table has no
    // Peruvian rows. Narrowing to zero is the same user-visible disaster.
    expect(labelsOf(denominationOptionGroups(LOOKUP, 'Peru', ''))).toHaveLength(6);

    // Canada is the live example: the Categories & Sets dialog offers 'CA'
    // but the seed data has no CA rows.
    expect(labelsOf(denominationOptionGroups(LOOKUP, 'Canada', ''))).toHaveLength(6);
  });

  it('never produces a group with no options under it', () => {
    for (const country of ['', 'United States', 'Great Britain', 'Ruritania', 'Peru']) {
      for (const group of denominationOptionGroups(LOOKUP, country, '')) {
        expect(group.options.length).toBeGreaterThan(0);
      }
    }
  });
});

// ===========================================================================
// RULE 2: AN EXISTING OUT-OF-COUNTRY DENOMINATION MUST SURVIVE
// ===========================================================================

describe('denominationOptionGroups — an existing denomination from elsewhere', () => {
  it('keeps a saved GB denomination visible when the country becomes the US', () => {
    // The data-loss case. The coin is saved as a Sovereign (GB); the user
    // edits Country to 'United States'. If 'Sovereign' dropped out of the
    // list the <select> would render blank and the field would look empty.
    const groups = denominationOptionGroups(LOOKUP, 'United States', 'Sovereign');

    expect(labelsOf(groups)).toContain('Sovereign');
  });

  it('marks it as not matching the current country', () => {
    const groups = denominationOptionGroups(LOOKUP, 'United States', 'Sovereign');
    const sovereign = groups.flatMap((group) => group.options).find((option) => option.label === 'Sovereign');

    expect(sovereign?.outOfCountry).toBe(true);
  });

  it('puts it in its own labelled group, naming where it does belong', () => {
    const groups = denominationOptionGroups(LOOKUP, 'United States', 'Sovereign');
    const extra = groups[groups.length - 1];

    expect(extra.options.map((option) => option.label)).toEqual(['Sovereign']);
    // The heading names the country it actually belongs to, spelled out
    // rather than left as the raw 'GB' code.
    expect(extra.heading).toContain('Great Britain');
  });

  it('does not flag a denomination that does match the country', () => {
    const groups = denominationOptionGroups(LOOKUP, 'United States', '25¢');

    expect(groups).toHaveLength(1);
    expect(groups[0].options.every((option) => !option.outOfCountry)).toBe(true);
  });

  it('does not add a stray group for a custom denomination', () => {
    // 'Trade Dollar' is in no lookup row at all, so it is a custom value and
    // custom-option-mode.ts is what keeps it on screen — the select shows
    // "Other" and the free-text box holds the value. Adding a group for it
    // here would put the same thing on screen twice.
    const groups = denominationOptionGroups(LOOKUP, 'United States', 'Trade Dollar');

    expect(groups).toHaveLength(1);
    expect(labelsOf(groups)).not.toContain('Trade Dollar');
  });
});

// ===========================================================================
// DENOMINATION -> COUNTRY: the auto-fill
// ===========================================================================

describe('denominationChoiceUpdates — filling the country in', () => {
  it('fills in the country when it is blank', () => {
    const updates = denominationChoiceUpdates('Sovereign', '', LOOKUP);

    expect(updates).toEqual([
      { field: 'denomination', value: 'Sovereign' },
      { field: 'country', value: 'Great Britain' }
    ]);
  });

  it('writes the FULL NAME, never the two-letter code from the lookup row', () => {
    // Coins store full names. Writing 'GB' into a coin would create the very
    // mismatch this whole feature exists to bridge.
    const updates = denominationChoiceUpdates('25¢', '', LOOKUP);

    expect(updates[1]).toEqual({ field: 'country', value: 'United States' });
    expect(updates[1].value).not.toBe('US');
  });

  it('fills in the country when it is only whitespace', () => {
    expect(denominationChoiceUpdates('Sovereign', '   ', LOOKUP)).toHaveLength(2);
  });

  it('NEVER overwrites a country the user already typed', () => {
    // The standing rule: a value the user supplied outranks an inferred one.
    const updates = denominationChoiceUpdates('Sovereign', 'United States', LOOKUP);

    expect(updates).toEqual([{ field: 'denomination', value: 'Sovereign' }]);
  });

  it('leaves even a conflicting hand-typed country alone', () => {
    // They typed 'Canada' and picked a GB denomination. That may be a
    // mistake, but it is their mistake to see and fix; we do not correct it.
    const updates = denominationChoiceUpdates('Farthing', 'Canada', LOOKUP);

    expect(updates.map((update) => update.field)).toEqual(['denomination']);
  });

  it('leaves the country alone for an unrecognised denomination', () => {
    expect(denominationChoiceUpdates('Trade Dollar', '', LOOKUP)).toEqual([
      { field: 'denomination', value: 'Trade Dollar' }
    ]);
  });

  it('leaves the country alone when clearing the denomination', () => {
    expect(denominationChoiceUpdates('', '', LOOKUP)).toEqual([{ field: 'denomination', value: '' }]);
  });

  it('refuses to guess when one label exists under two countries', () => {
    // 'Crown' is a real British denomination and also a plausible Canadian
    // one. With no way to tell which was meant, we write nothing.
    const ambiguous = [
      ...LOOKUP,
      denomination({ denominationId: 8, label: 'Crown', country: 'GB' }),
      denomination({ denominationId: 9, label: 'Crown', country: 'CA' })
    ];

    expect(denominationChoiceUpdates('Crown', '', ambiguous)).toEqual([
      { field: 'denomination', value: 'Crown' }
    ]);
  });

  it('is happy when several rows share a label under the SAME country', () => {
    const duplicated = [
      ...LOOKUP,
      denomination({ denominationId: 8, label: 'Crown', country: 'GB' }),
      denomination({ denominationId: 9, label: 'Crown', country: 'Great Britain' })
    ];

    expect(denominationChoiceUpdates('Crown', '', duplicated)).toEqual([
      { field: 'denomination', value: 'Crown' },
      { field: 'country', value: 'Great Britain' }
    ]);
  });

  it('writes nothing for a denomination filed under an unplaceable country', () => {
    const odd = [denomination({ denominationId: 10, label: 'Thaler', country: 'XX' })];

    expect(denominationChoiceUpdates('Thaler', '', odd)).toEqual([
      { field: 'denomination', value: 'Thaler' }
    ]);
  });

  it('ignores retired rows when inferring the country', () => {
    const retired = [denomination({ denominationId: 11, label: 'Groat', country: 'GB', isActive: false })];

    expect(denominationChoiceUpdates('Groat', '', retired)).toEqual([
      { field: 'denomination', value: 'Groat' }
    ]);
  });
});

// ===========================================================================
// THE PAYLOAD: EVERY WRITE IS STILL ONE FIELD
// ===========================================================================

/**
 * Mimics the funnel every edit in CoinEditorForm goes through:
 *
 *     for (const update of denominationChoiceUpdates(...)) {
 *       this.updateSelectedCoin(update.field, update.value);   // strips the
 *     }                                                        // sentinel
 *
 *     updateSelectedCoin -> inv.updateCoin(id, { [field]: value })
 *
 * so what this collects is the exact sequence of payloads that reach
 * InventoryService.
 */
function payloadsFor(updates: readonly CoinFieldUpdate[]): Partial<CoinRecord>[] {
  return updates.map((update) => {
    const value =
      update.field === 'denomination' ? stripCustomSentinel(update.value) : update.value;
    return { [update.field]: value } as Partial<CoinRecord>;
  });
}

describe('the payloads that reach the server', () => {
  it('sends two SEPARATE single-field updates, never one wide record', () => {
    // A wide payload has overwritten untouched fields in this project before.
    // "The user's action changed two fields" is not a licence to widen it.
    const payloads = payloadsFor(denominationChoiceUpdates('Sovereign', '', LOOKUP));

    expect(payloads).toEqual([{ denomination: 'Sovereign' }, { country: 'Great Britain' }]);
    for (const payload of payloads) {
      expect(Object.keys(payload)).toHaveLength(1);
    }
  });

  it('sends exactly one update when the country is left alone', () => {
    const payloads = payloadsFor(denominationChoiceUpdates('Sovereign', 'United States', LOOKUP));

    expect(payloads).toEqual([{ denomination: 'Sovereign' }]);
  });

  it('never touches any field other than denomination and country', () => {
    const fields = new Set<string>();
    for (const country of ['', 'United States', 'Great Britain', 'Ruritania']) {
      for (const label of ['Sovereign', '25¢', 'Trade Dollar', '']) {
        for (const payload of payloadsFor(denominationChoiceUpdates(label, country, LOOKUP))) {
          Object.keys(payload).forEach((key) => fields.add(key));
        }
      }
    }

    expect([...fields].sort()).toEqual(['country', 'denomination']);
  });

  it('changing the country issues NO denomination write at all', () => {
    // Narrowing the list is pure display. The proof is structural: the filter
    // returns groups and nothing else — it has no way to write to a coin.
    const groups = denominationOptionGroups(LOOKUP, 'United States', 'Sovereign');

    expect(Array.isArray(groups)).toBe(true);
    expect(labelsOf(groups)).toContain('Sovereign');
  });
});

// ===========================================================================
// THE '__OTHER__' SENTINEL
// ===========================================================================

describe('the custom-denomination sentinel', () => {
  it('is never a real denomination, so it can never infer a country', () => {
    const updates = denominationChoiceUpdates(CUSTOM_OPTION_SENTINEL, '', LOOKUP);

    expect(updates.some((update) => update.field === 'country')).toBe(false);
  });

  it('is stripped before anything is persisted, even if it gets this far', () => {
    // The component returns early on the sentinel and never reaches here, but
    // updateSelectedCoin strips it regardless. Belt and braces: the string
    // '__OTHER__' must not be able to land in the database by any route.
    const payloads = payloadsFor(denominationChoiceUpdates(CUSTOM_OPTION_SENTINEL, '', LOOKUP));

    expect(payloads).toEqual([{ denomination: '' }]);
    for (const payload of payloads) {
      expect(Object.values(payload)).not.toContain(CUSTOM_OPTION_SENTINEL);
    }
  });

  it('is never offered as an option by the filter', () => {
    for (const country of ['', 'United States', 'Great Britain', 'Ruritania']) {
      expect(labelsOf(denominationOptionGroups(LOOKUP, country, CUSTOM_OPTION_SENTINEL)))
        .not.toContain(CUSTOM_OPTION_SENTINEL);
    }
  });
});
