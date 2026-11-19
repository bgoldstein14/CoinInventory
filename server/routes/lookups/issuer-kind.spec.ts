/*
 * The issuer kind rule. The last block re-derives every seeded issuer's kind
 * from the real seed file, so the "all but one" claim stays true.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  ANCIENT_BEFORE_YEAR,
  UNDATED_ISSUER_KIND,
  deriveIssuerKind,
  isIssuerKind,
  resolveIssuerKind,
} from './issuer-kind';

describe('deriveIssuerKind', () => {
  it('calls an issuer that began before 500 ancient', () => {
    expect(deriveIssuerKind(-509, -27)).toBe('ancient');
    expect(deriveIssuerKind(224, 651)).toBe('ancient');
    // An open-ended ancient is still ancient.
    expect(deriveIssuerKind(-300, null)).toBe('ancient');
  });

  it('tests ancient BEFORE historical, which is what the Byzantines need', () => {
    // Has an end year, but ancient is checked first.
    expect(deriveIssuerKind(491, 1453)).toBe('ancient');
    expect(ANCIENT_BEFORE_YEAR).toBe(500);
  });

  it('calls an issuer with an end year historical', () => {
    expect(deriveIssuerKind(1871, 1918)).toBe('historical');
    expect(deriveIssuerKind(1927, 1948)).toBe('historical');
    // Prussia: no start year recorded, but it ended in 1871.
    expect(deriveIssuerKind(null, 1871)).toBe('historical');
  });

  it('calls a dated issuer that has not ended modern', () => {
    expect(deriveIssuerKind(1792, null)).toBe('modern');
    expect(deriveIssuerKind(1948, null)).toBe('modern');
    // The threshold is strict.
    expect(deriveIssuerKind(500, null)).toBe('modern');
  });

  it('answers NULL when both years are blank, instead of guessing', () => {
    // Empty span gives null, not 'modern' (see British Colonial).
    expect(deriveIssuerKind(null, null)).toBeNull();
  });
});

describe('resolveIssuerKind', () => {
  it('uses the derived kind whenever the years say anything at all', () => {
    expect(resolveIssuerKind(-509, -27, 'modern')).toBe('ancient');
    expect(resolveIssuerKind(1871, 1918, 'modern')).toBe('historical');
    expect(resolveIssuerKind(1792, null, 'ancient')).toBe('modern');
  });

  it('creates an undated issuer as modern', () => {
    // Most undated seeded issuers are modern.
    expect(resolveIssuerKind(null, null)).toBe(UNDATED_ISSUER_KIND);
    expect(resolveIssuerKind(null, null)).toBe('modern');
  });

  it('keeps the stored kind of an undated issuer that already exists', () => {
    // British Colonial: undated, curated 'historical'; editing must keep it.
    expect(resolveIssuerKind(null, null, 'historical')).toBe('historical');
    expect(resolveIssuerKind(null, null, 'ancient')).toBe('ancient');
  });

  it('prefers the derived kind over the stored one when they disagree', () => {
    // Once it has a span, the span decides.
    expect(resolveIssuerKind(1607, 1997, 'historical')).toBe('historical');
    expect(resolveIssuerKind(-200, null, 'historical')).toBe('ancient');
  });
});

describe('isIssuerKind', () => {
  it('accepts the three and refuses everything else', () => {
    expect(isIssuerKind('modern')).toBe(true);
    expect(isIssuerKind('historical')).toBe(true);
    expect(isIssuerKind('ancient')).toBe(true);
    for (const value of ['imaginary', '', 'Modern', null, undefined, 7, {}]) {
      expect(isIssuerKind(value), `${JSON.stringify(value)} is not a kind`).toBe(false);
    }
  });
});

/* Against the real seed. */
describe('the rule, measured against the seeded issuers', () => {
  const SEED_PATH = path.join(__dirname, '..', '..', 'db', 'seed-data', 'issuers-denominations.json');
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')) as {
    issuers: { name: string; kind: string; validFrom: number | null; validTo: number | null }[];
  };

  it('reproduces every seeded kind except British Colonial', () => {
    // Create semantics (no stored kind): British Colonial is the one miss.
    const wrong = seed.issuers
      .filter((issuer) => resolveIssuerKind(issuer.validFrom ?? null, issuer.validTo ?? null) !== issuer.kind)
      .map((issuer) => issuer.name);

    expect(wrong).toEqual(['British Colonial']);
  });

  it('reproduces ALL of them once the stored kind is available, as PUT has it', () => {
    // Update semantics: nothing is reclassified.
    const wrong = seed.issuers
      .filter(
        (issuer) =>
          resolveIssuerKind(
            issuer.validFrom ?? null,
            issuer.validTo ?? null,
            issuer.kind as 'modern' | 'historical' | 'ancient'
          ) !== issuer.kind
      )
      .map((issuer) => issuer.name);

    expect(wrong).toEqual([]);
  });

  it('still has exactly one seeded issuer with no dates and a non-modern kind', () => {
    // Tripwire: a second undated non-modern issuer would make the notes above stale.
    const undatedNonModern = seed.issuers
      .filter((issuer) => (issuer.validFrom ?? null) === null && (issuer.validTo ?? null) === null)
      .filter((issuer) => issuer.kind !== 'modern')
      .map((issuer) => issuer.name);

    expect(undatedNonModern).toEqual(['British Colonial']);
  });
});
