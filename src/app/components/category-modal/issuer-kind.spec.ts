/*
 * Issuer kind derivation, checked against the real seed file and against the
 * server's copy of the rule (read as text).
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
const SEED_PATH = resolve(HERE, '../../../../server/db/seed-data/issuers-denominations.json');
const SERVER_RULE_PATH = resolve(HERE, '../../../../server/routes/lookups/issuer-kind.ts');

describe('deriveIssuerKind', () => {
  it('calls anything that began before 500 ancient', () => {
    expect(deriveIssuerKind(-509, -27)).toBe('ancient');
    expect(deriveIssuerKind(-300, null)).toBe('ancient');
    expect(deriveIssuerKind(224, 651)).toBe('ancient');
  });

  it('tests ancient BEFORE historical, which is what the Byzantines need', () => {
    // 491-1453: has an end year but is ancient, so ancient must be tested first.
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
    // Not folded into 'modern', so editing keeps a curated kind.
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

/* ----- Against the seed ----- */
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
    // Guards against the seed path silently resolving to nothing.
    expect(seed.issuers.length).toBeGreaterThanOrEqual(70);
    expect(seed.issuers.some((issuer) => issuer.name === 'Byzantine Empire')).toBe(true);
    expect(seed.issuers.some((issuer) => issuer.name === 'British Colonial')).toBe(true);
  });
});

/*
 * ----- Parity with the server copy -----
 * The rule exists in src/ and server/ (neither can import the other). The
 * server file is read as text, since it is outside this vitest root, and its
 * thresholds and branch order are compared.
 */

const serverSource = readFileSync(SERVER_RULE_PATH, 'utf8');

/** Strip comments, so a threshold quoted in prose is not mistaken for code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const serverCode = withoutComments(serverSource);

describe('the server copy of the derivation rule', () => {
  it('was actually read, and is not an empty string passing vacuously', () => {
    expect(serverSource.length).toBeGreaterThan(500);
    expect(serverCode).toContain('export function deriveIssuerKind');
    expect(serverCode).toContain('export function resolveIssuerKind');
  });

  it('uses the same ancient threshold', () => {
    const match = /export const ANCIENT_BEFORE_YEAR = (-?\d+);/.exec(serverCode);
    expect(match, 'ANCIENT_BEFORE_YEAR not found in the server rule').not.toBeNull();
    expect(Number(match?.[1])).toBe(ANCIENT_BEFORE_YEAR);
  });

  it('defaults an undated issuer the same way', () => {
    const match = /export const UNDATED_ISSUER_KIND: IssuerKind = '([a-z]+)';/.exec(serverCode);
    expect(match, 'UNDATED_ISSUER_KIND not found in the server rule').not.toBeNull();
    expect(match?.[1]).toBe(UNDATED_ISSUER_KIND);
  });

  it('tests ancient before historical, in that order', () => {
    // Swapped branches would mislabel the Byzantine Empire.
    const ancientAt = serverCode.indexOf("return 'ancient'");
    const historicalAt = serverCode.indexOf("return 'historical'");
    expect(ancientAt).toBeGreaterThan(-1);
    expect(historicalAt).toBeGreaterThan(-1);
    expect(ancientAt).toBeLessThan(historicalAt);
  });

  it('returns null for the empty span rather than falling through to modern', () => {
    // An empty span returns null on the server too (British Colonial).
    expect(serverCode).toMatch(/return null;\s*}/);
    expect(deriveIssuerKind(null, null)).toBeNull();
  });

  it('agrees branch for branch on a table of spans', () => {
    // Re-reads the server's three conditions from its text.
    const fromText = /if \(validFrom !== null && validFrom < ANCIENT_BEFORE_YEAR\) return 'ancient';/;
    const toText = /if \(validTo !== null\) return 'historical';/;
    const modernText = /if \(validFrom !== null\) return 'modern';/;

    expect(serverCode, 'the ancient branch has changed shape').toMatch(fromText);
    expect(serverCode, 'the historical branch has changed shape').toMatch(toText);
    expect(serverCode, 'the modern branch has changed shape').toMatch(modernText);

    expect(deriveIssuerKind(499, 1000)).toBe('ancient');
    expect(deriveIssuerKind(1000, 1200)).toBe('historical');
    expect(deriveIssuerKind(1000, null)).toBe('modern');
    expect(deriveIssuerKind(null, null)).toBeNull();
  });
});
