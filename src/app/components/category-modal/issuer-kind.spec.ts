/*
 * issuer-kind.spec.ts — the rule the issuer form stopped asking about.
 *
 * The last block reads the REAL seed off disk and re-derives all of its
 * kinds, so "this reproduces all but one of them" is a measurement that
 * re-runs rather than a comment that was true once.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ISSUER_KINDS, IssuerKind } from '../../types/reference-data.model';
import {
  ANCIENT_BEFORE_YEAR,
  UNDATED_ISSUER_KIND,
  deriveIssuerKind,
  resolveIssuerKind,
} from './issuer-kind';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(HERE, '../../../../server/migrations/seed-data/issuers-denominations.json');

describe('deriveIssuerKind', () => {
  it('calls anything that began before 500 ancient', () => {
    expect(deriveIssuerKind(-509, -27)).toBe('ancient');
    expect(deriveIssuerKind(-300, null)).toBe('ancient');
    expect(deriveIssuerKind(224, 651)).toBe('ancient');
  });

  it('tests ancient BEFORE historical, which is what the Byzantines need', () => {
    // 491-1453. It has an end year, so a historical-first rule would
    // mislabel it. The seed says ancient and so would any collector.
    expect(deriveIssuerKind(491, 1453)).toBe('ancient');
    expect(ANCIENT_BEFORE_YEAR).toBe(500);
    // Strict: 500 itself is not ancient.
    expect(deriveIssuerKind(500, 1453)).toBe('historical');
  });

  it('calls anything with an end year historical', () => {
    expect(deriveIssuerKind(1871, 1918)).toBe('historical');
    expect(deriveIssuerKind(null, 1871)).toBe('historical');
  });

  it('calls a dated issuer that has not ended modern', () => {
    expect(deriveIssuerKind(1792, null)).toBe('modern');
    expect(deriveIssuerKind(500, null)).toBe('modern');
  });

  it('answers NULL for an empty span instead of guessing', () => {
    // Deliberately NOT folded into 'modern'. Folding it is exactly what
    // would overwrite British Colonial's curated 'historical' on save.
    expect(deriveIssuerKind(null, null)).toBeNull();
  });

  it('only ever answers with a value the column accepts', () => {
    const years = [null, -1000, -1, 0, 499, 500, 1500, 2026];
    for (const from of years) {
      for (const to of years) {
        const derived = deriveIssuerKind(from, to);
        if (derived === null) continue;
        expect(ISSUER_KINDS, `${from}..${to}`).toContain(derived);
      }
    }
  });
});

describe('resolveIssuerKind', () => {
  it('believes the years whenever they say anything', () => {
    expect(resolveIssuerKind(-509, -27, 'modern')).toBe('ancient');
    expect(resolveIssuerKind(1871, 1918, 'ancient')).toBe('historical');
    expect(resolveIssuerKind(1792, null, 'ancient')).toBe('modern');
  });

  it('creates an undated issuer as modern', () => {
    expect(resolveIssuerKind(null, null)).toBe(UNDATED_ISSUER_KIND);
    expect(UNDATED_ISSUER_KIND).toBe('modern');
  });

  it('keeps the stored kind of an undated issuer that already exists', () => {
    expect(resolveIssuerKind(null, null, 'historical')).toBe('historical');
  });
});

/*
 * THE MEASUREMENT
 */
describe('the rule against the 70 seeded issuers', () => {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as {
    issuers: { name: string; kind: IssuerKind; validFrom: number | null; validTo: number | null }[];
  };

  it('reproduces every seeded kind but British Colonial, which has no dates', () => {
    const wrong = seed.issuers
      .filter((issuer) => resolveIssuerKind(issuer.validFrom ?? null, issuer.validTo ?? null) !== issuer.kind)
      .map((issuer) => issuer.name);

    expect(wrong).toEqual(['British Colonial']);
  });

  it('reproduces ALL of them when the stored kind is available, as editing one is', () => {
    const wrong = seed.issuers
      .filter(
        (issuer) =>
          resolveIssuerKind(issuer.validFrom ?? null, issuer.validTo ?? null, issuer.kind) !== issuer.kind
      )
      .map((issuer) => issuer.name);

    expect(wrong).toEqual([]);
  });

  it('is measured against a seed that really is the size it claims', () => {
    // Guards the describe() above from quietly becoming vacuous if the
    // path ever stops resolving to the real file.
    expect(seed.issuers.length).toBeGreaterThanOrEqual(70);
    expect(seed.issuers.some((issuer) => issuer.name === 'Byzantine Empire')).toBe(true);
    expect(seed.issuers.some((issuer) => issuer.name === 'British Colonial')).toBe(true);
  });
});
