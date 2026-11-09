/*
 * issuer-draft.spec.ts — adding an issuer by hand.
 *
 * The form must not be able to produce a row the database will reject or
 * silently mangle. Every rule below maps to a column on `Issuers`:
 *
 *   Name       NVARCHAR(100) NOT NULL, CONSTRAINT UQ_Issuers_Name UNIQUE
 *   IsoCode    CHAR(2) NULL        -- fixed width: three letters TRUNCATE
 *   Kind       NVARCHAR(20) NOT NULL, one of three values the UI switches on
 *   ValidFrom  INT NULL
 *   ValidTo    INT NULL
 */

import { describe, expect, it } from 'vitest';

import {
  ISSUER_KINDS,
  ISSUER_NAME_MAX_LENGTH,
  blankIssuerDraft,
  describeIssuerRemoval,
  validateIssuerDraft,
} from './issuer-draft';

function draft(overrides: Partial<ReturnType<typeof blankIssuerDraft>> = {}) {
  return { ...blankIssuerDraft(), name: 'Burma', ...overrides };
}

describe('blankIssuerDraft', () => {
  it('starts on a kind the form can show, so the picker is never unset', () => {
    expect(ISSUER_KINDS).toContain(blankIssuerDraft().kind);
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
    // The minimum viable issuer. Everything else is optional, because the
    // user who has just discovered their Burmese coin has nowhere to live
    // should not have to research an ISO code first.
    const result = validateIssuerDraft(draft(), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issuer).toEqual({
      name: 'Burma',
      isoCode: null,
      kind: 'modern',
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
    // THE BUG THIS PREVENTS: a "years must be positive" rule looks sensible
    // and excludes the Roman Republic. Negative years mean BC, and ancient
    // issuers are first-class citizens of this table.
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
    // UQ_Issuers_Name is a UNIQUE constraint, so the alternative to this
    // check is a 500 from the server with a SQL message in it. Worse, the
    // seed script matches issuers BY NAME: a second 'Mexico' would make its
    // join multiply rows rather than fail.
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
    // IsoCode is CHAR(2). 'MMR' is TRUNCATED to 'MM' by SQL Server without
    // complaint, and 'M' is PADDED to 'M '. Both store something the user
    // did not type, and neither is visible afterwards.
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

  it('refuses a kind the schema does not define', () => {
    const result = validateIssuerDraft(draft({ kind: 'imaginary' }), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('imaginary');
  });

  it('offers exactly the three kinds the column documents', () => {
    expect([...ISSUER_KINDS]).toEqual(['modern', 'historical', 'ancient']);
  });
});

describe('describeIssuerRemoval', () => {
  it('allows removing an issuer that has no denominations', () => {
    const outcome = describeIssuerRemoval('Burma', 0);
    expect(outcome.allowed).toBe(true);
    expect(outcome.message).toContain('Burma');
  });

  it('refuses while denominations still point at it, and says how many', () => {
    // THE BUG THIS PREVENTS: soft-deleting the issuer leaves its
    // denominations pointing at a row that is no longer returned, so they
    // all silently fall into the "no issuer yet" group — a mess the user did
    // not ask for and cannot undo with one click. Making them move or
    // remove the denominations first keeps the decision explicit.
    const outcome = describeIssuerRemoval('Mexico', 23);
    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('23 denominations');
  });

  it('gets the singular right', () => {
    const outcome = describeIssuerRemoval('Mexico', 1);
    expect(outcome.message).toContain('1 denomination ');
    expect(outcome.message).not.toContain('1 denominations');
  });
});
