/*
 * routes/lookups/issuer-kind.spec.ts — the derivation rule, and the
 * measurement the rule was chosen from.
 *
 * The last test here is the important one. It reads the REAL seed off disk
 * and re-derives all 62 kinds, so the claim "this reproduces 61 of 62" is
 * not a comment that was true once. If somebody adds a seeded issuer whose
 * kind the rule gets wrong, that test says so and names it.
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
    // An open-ended ancient is still ancient: nothing about the missing end
    // date makes the Roman Republic modern.
    expect(deriveIssuerKind(-300, null)).toBe('ancient');
  });

  it('tests ancient BEFORE historical, which is what the Byzantines need', () => {
    // 491-1453. It has an end year, so a rule that asked "is there a
    // validTo?" first would file the Byzantine Empire as historical. The
    // seed says ancient and so does every collector.
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
    // 500 exactly is NOT ancient. The threshold is strict, and it is the
    // one the Byzantine entry fixed.
    expect(deriveIssuerKind(500, null)).toBe('modern');
  });

  it('answers NULL when both years are blank, instead of guessing', () => {
    // Not 'modern'. The empty span carries no information, and folding it
    // into the modern branch is exactly what would rewrite British
    // Colonial's curated 'historical' on save.
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
    // 12 of the seed's 13 undated issuers are modern. A user who types a
    // name and no years is adding a present-day country.
    expect(resolveIssuerKind(null, null)).toBe(UNDATED_ISSUER_KIND);
    expect(resolveIssuerKind(null, null)).toBe('modern');
  });

  it('keeps the stored kind of an undated issuer that already exists', () => {
    // *** BRITISH COLONIAL. *** No dates, filed as historical by the seed,
    // and the one issuer the rule does not reproduce. Editing it must not
    // silently reclassify it.
    expect(resolveIssuerKind(null, null, 'historical')).toBe('historical');
    expect(resolveIssuerKind(null, null, 'ancient')).toBe('ancient');
  });

  it('prefers the derived kind over the stored one when they disagree', () => {
    // Giving British Colonial a date range is the user saying something
    // new about it, and the rule should then be believed.
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

/*
 * THE MEASUREMENT, AGAINST THE REAL SEED
 */
describe('the rule, measured against the seeded issuers', () => {
  const SEED_PATH = path.join(__dirname, '..', '..', 'migrations', 'seed-data', 'issuers-denominations.json');
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')) as {
    issuers: { name: string; kind: string; validFrom: number | null; validTo: number | null }[];
  };

  it('reproduces every seeded kind except British Colonial', () => {
    // CREATE semantics on purpose: no stored kind, so an undated issuer
    // comes out modern. That is the branch British Colonial fails, and it
    // is the reason PUT passes the stored value in.
    const wrong = seed.issuers
      .filter((issuer) => resolveIssuerKind(issuer.validFrom ?? null, issuer.validTo ?? null) !== issuer.kind)
      .map((issuer) => issuer.name);

    expect(wrong).toEqual(['British Colonial']);
  });

  it('reproduces ALL of them once the stored kind is available, as PUT has it', () => {
    // The same 62 rows through the UPDATE path. Nothing is reclassified,
    // which is the property that matters for a live database.
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
    // A tripwire on the premise rather than on the rule: if a second
    // undated historical issuer is ever seeded, the "one miss" story above
    // is out of date and somebody should read it again.
    const undatedNonModern = seed.issuers
      .filter((issuer) => (issuer.validFrom ?? null) === null && (issuer.validTo ?? null) === null)
      .filter((issuer) => issuer.kind !== 'modern')
      .map((issuer) => issuer.name);

    expect(undatedNonModern).toEqual(['British Colonial']);
  });
});
