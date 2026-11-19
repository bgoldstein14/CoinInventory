/*
 * Validation for adding an issuer. Rules map to the `Issuers` columns:
 * unique Name (max 100), IsoCode CHAR(2), integer ValidFrom/ValidTo.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOOK_UP_ONLINE,
  ISSUER_KINDS,
  ISSUER_NAME_MAX_LENGTH,
  blankIssuerDraft,
  describeIssuerRemoval,
  describeIssuerRevived,
  describeLookupSkippedForRevival,
  previewIssuerKind,
  validateIssuerDraft,
} from './issuer-draft';

function draft(overrides: Partial<ReturnType<typeof blankIssuerDraft>> = {}) {
  return { ...blankIssuerDraft(), name: 'Burma', ...overrides };
}

describe('blankIssuerDraft', () => {
  it('has NO kind at all, because the form stopped asking for one', () => {
    // Kind is derived from the year span on save.
    expect('kind' in blankIssuerDraft()).toBe(false);
  });

  it('turns the online lookup ON unless the caller says otherwise', () => {
    expect(blankIssuerDraft().lookUpOnline).toBe(DEFAULT_LOOK_UP_ONLINE);
    expect(DEFAULT_LOOK_UP_ONLINE).toBe(true);
  });

  it('carries a refusal across a clear, so a cleared form does not re-tick it', () => {
    // The lookup preference is carried across form resets.
    expect(blankIssuerDraft(false).lookUpOnline).toBe(false);
    expect(blankIssuerDraft(true).lookUpOnline).toBe(true);
  });

  it('starts with every text field empty', () => {
    const empty = blankIssuerDraft();
    expect(empty.name).toBe('');
    expect(empty.isoCode).toBe('');
    expect(empty.validFrom).toBe('');
    expect(empty.validTo).toBe('');
  });
});

describe('validateIssuerDraft — the happy path', () => {
  it('accepts a name alone', () => {
    // Only the name is required.
    const result = validateIssuerDraft(draft(), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issuer).toEqual({
      name: 'Burma',
      isoCode: null,
      validFrom: null,
      validTo: null,
    });
  });

  it('trims the name and upper-cases the ISO code', () => {
    const result = validateIssuerDraft(draft({ name: '  Burma  ', isoCode: ' mm ' }), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issuer.name).toBe('Burma');
    expect(result.issuer.isoCode).toBe('MM');
  });

  it('accepts the years of a historical state', () => {
    const result = validateIssuerDraft(
      draft({ name: 'Papal States', kind: 'historical', validFrom: '756', validTo: '1870' }),
      []
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issuer.validFrom).toBe(756);
    expect(result.issuer.validTo).toBe(1870);
  });

  it('accepts BC years as negative numbers', () => {
    // Negative years mean BC.
    const result = validateIssuerDraft(
      draft({ name: 'Roman Republic', kind: 'ancient', validFrom: '-509', validTo: '-27' }),
      []
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issuer.validFrom).toBe(-509);
    expect(result.issuer.validTo).toBe(-27);
  });

  it('accepts an open-ended end year', () => {
    const result = validateIssuerDraft(draft({ validFrom: '1948', validTo: '' }), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issuer.validTo).toBeNull();
  });
});

describe('validateIssuerDraft — what it refuses, and why', () => {
  it('refuses a blank name', () => {
    const result = validateIssuerDraft(draft({ name: '   ' }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('name');
  });

  it('refuses a duplicate name, ignoring case and surrounding space', () => {
    // Names are unique (UQ_Issuers_Name), and seeding matches issuers by name.
    const result = validateIssuerDraft(draft({ name: ' mexico ' }), ['Mexico', 'Burma']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Mexico');
  });

  it('refuses a name longer than the column', () => {
    const result = validateIssuerDraft(draft({ name: 'x'.repeat(ISSUER_NAME_MAX_LENGTH + 1) }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(String(ISSUER_NAME_MAX_LENGTH));
  });

  it('accepts a name exactly as long as the column', () => {
    expect(validateIssuerDraft(draft({ name: 'x'.repeat(ISSUER_NAME_MAX_LENGTH) }), []).ok).toBe(true);
  });

  it('refuses an ISO code that is not two letters', () => {
    // CHAR(2) silently truncates 'MMR' and pads 'M'.
    for (const bad of ['M', 'MMR', '1M', 'M-']) {
      const result = validateIssuerDraft(draft({ isoCode: bad }), []);
      expect(result.ok, `expected ${bad} to be refused`).toBe(false);
    }
  });

  it('refuses a year that is not a whole number', () => {
    expect(validateIssuerDraft(draft({ validFrom: '17th century' }), []).ok).toBe(false);
    expect(validateIssuerDraft(draft({ validTo: '1870.5' }), []).ok).toBe(false);
  });

  it('refuses an end year before the start year', () => {
    const result = validateIssuerDraft(draft({ validFrom: '1870', validTo: '756' }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain('before');
  });

  it('allows a start and end in the same year', () => {
    expect(validateIssuerDraft(draft({ validFrom: '1849', validTo: '1849' }), []).ok).toBe(true);
  });

  it('still documents exactly the three values the column may hold', () => {
    // The column's domain is unchanged even though there is no picker.
    expect([...ISSUER_KINDS]).toEqual(['modern', 'historical', 'ancient']);
  });
});

describe('previewIssuerKind', () => {
  it('shows the kind the typed years imply, so dropping the picker hides nothing', () => {
    expect(previewIssuerKind(draft({ validFrom: '-247', validTo: '224' }))).toBe('ancient');
    expect(previewIssuerKind(draft({ validFrom: '1871', validTo: '1918' }))).toBe('historical');
    expect(previewIssuerKind(draft({ validFrom: '1948' }))).toBe('modern');
  });

  it('defaults an empty form to modern rather than going blank', () => {
    expect(previewIssuerKind(draft())).toBe('modern');
  });

  it('treats a half-typed year as absent instead of refusing to show anything', () => {
    // Mid-keystroke input ('-') is treated as absent, not an error.
    expect(previewIssuerKind(draft({ validFrom: '-' }))).toBe('modern');
    expect(previewIssuerKind(draft({ validFrom: '18x' , validTo: '1918' }))).toBe('historical');
  });

  it('agrees with what the form will actually send', () => {
    // The preview reads the same fields as the payload.
    const form = draft({ validFrom: '491', validTo: '1453' });
    const validated = validateIssuerDraft(form, []);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.issuer.validFrom).toBe(491);
    expect(validated.issuer.validTo).toBe(1453);
    expect(previewIssuerKind(form)).toBe('ancient');
  });
});

/*
 * describeIssuerRemoval: removal cascades, so these test the confirmation
 * wording at both severities.
 */
describe('describeIssuerRemoval', () => {
  it('is routine for an issuer with nothing filed under it', () => {
    const plan = describeIssuerRemoval('Burma', 0, 0);
    expect(plan.severity).toBe('routine');
    expect(plan.message).toContain('Burma');
    expect(plan.message).toContain('no denominations');
  });

  it('is still routine when denominations go but no coin depends on them', () => {
    const plan = describeIssuerRemoval('Burma', 3, 0);
    expect(plan.severity).toBe('routine');
    expect(plan.message).toContain('3 denominations');
    expect(plan.message).toContain('No coin uses');
    expect(plan.message).toContain('nothing else changes');
  });

  it('escalates once coins depend on it, and SAYS THE NUMBER', () => {
    // The serious warning must quote the coin count.
    const plan = describeIssuerRemoval('Mexico', 23, 43);
    expect(plan.severity).toBe('serious');
    expect(plan.message).toContain('43 coins');
    expect(plan.message).toContain('all 23 of its denominations');
  });

  it('promises, in the serious case, that no coin is deleted and each keeps its text', () => {
    // States that coins can be re-linked, not lost.
    const plan = describeIssuerRemoval('Mexico', 23, 43);
    expect(plan.message).toContain('No coin is deleted');
    expect(plan.message).toContain('keeps the denomination text');
    expect(plan.message).toContain('re-links them');
    expect(plan.message).toContain('read as Other');
    expect(plan.message).toContain('cannot be undone in one step');
  });

  it('says two visibly different things at the two magnitudes', () => {
    const routine = describeIssuerRemoval('Mexico', 23, 0);
    const serious = describeIssuerRemoval('Mexico', 23, 43);
    expect(routine.message).not.toBe(serious.message);
    expect(routine.message).not.toContain('cannot be undone');
    expect(serious.message.length).toBeGreaterThan(routine.message.length);
  });

  it('never puts a sentinel in front of the user', () => {
    // "Other" is the null-link display, not a stored value.
    for (const plan of [
      describeIssuerRemoval('Mexico', 0, 0),
      describeIssuerRemoval('Mexico', 3, 0),
      describeIssuerRemoval('Mexico', 3, 9),
    ]) {
      expect(plan.message).not.toContain('__OTHER__');
    }
  });

  it('gets the singular right on both counts', () => {
    const one = describeIssuerRemoval('Mexico', 1, 1);
    expect(one.message).toContain('its 1 denomination?');
    expect(one.message).toContain('1 coin uses it');
    expect(one.message).not.toContain('1 denominations');
    expect(one.message).not.toContain('1 coins');

    const oneDenomination = describeIssuerRemoval('Mexico', 1, 0);
    expect(oneDenomination.message).toContain('Its 1 denomination goes with it');
  });

  it('reports the counts it was given, clamped to whole non-negative numbers', () => {
    // Counts are clamped to whole non-negative numbers.
    const plan = describeIssuerRemoval('Mexico', 2.7, -4);
    expect(plan.denominationCount).toBe(2);
    expect(plan.coinCount).toBe(0);
    expect(plan.severity).toBe('routine');
  });
});

/* ----- Messages for a revived (soft-deleted) issuer ----- */
describe('describeIssuerRevived', () => {
  it('says RESTORED, not added, and quotes the number that came back', () => {
    // Says "Restored", with the count.
    const said = describeIssuerRevived('Burma', 3);

    expect(said).toContain('Restored');
    expect(said).not.toContain('Added');
    expect(said).toContain('Burma');
    expect(said).toContain('3');
  });

  it('gets the singular right', () => {
    const said = describeIssuerRevived('Burma', 1);
    expect(said).toContain('its 1 denomination');
    expect(said).not.toContain('denominations');
  });

  it('does NOT claim the coins were re-linked, because they were not', () => {
    // Reviving labels does not re-link coins, so the message must not imply it.
    const said = describeIssuerRevived('Burma', 3);

    expect(said).toContain('re-select');
    expect(said.toLowerCase()).toContain('other');
  });

  it('has its OWN sentence for a revival that brought nothing back', () => {
    // Zero gets its own wording.
    const said = describeIssuerRevived('Burma', 0);

    expect(said).toContain('Restored');
    expect(said).toContain('no denominations');
    expect(said).not.toContain('0');
  });

  it('treats a missing or nonsense count as none rather than printing it', () => {
    expect(describeIssuerRevived('Burma', Number.NaN)).toContain('no denominations');
    expect(describeIssuerRevived('Burma', -2)).toContain('no denominations');
  });
});

describe('describeLookupSkippedForRevival', () => {
  it('says nothing left the machine, which is the promise the checkbox made', () => {
    // Confirms nothing was sent.
    const said = describeLookupSkippedForRevival('Burma', 3);

    expect(said).toContain('nothing left this machine');
    expect(said).toContain('Burma');
    expect(said).toContain('3');
  });

  it('still points at the manual route, like every other lookup message', () => {
    expect(describeLookupSkippedForRevival('Burma', 3)).toContain('below');
  });
});
