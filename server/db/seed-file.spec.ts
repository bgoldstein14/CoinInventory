/**
 * Tests for the seed validator and checks on the real seed JSON.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';

import { validateSeed } from './seed-file';
import { SEED_DATA_PATH } from './seed';

/** A minimal, valid seed in the pinned format. */
const VALID = {
  issuers: [
    {
      key: 'mexico',
      name: 'Mexico',
      isoCode: 'MX',
      kind: 'modern',
      validFrom: 1821,
      validTo: null,
      sortOrder: 100,
    },
    {
      key: 'roman-empire',
      name: 'Roman Empire',
      isoCode: null,
      kind: 'ancient',
      validFrom: -27,
      validTo: 476,
      sortOrder: 900,
    },
  ],
  denominations: [
    { issuer: 'mexico', label: '8 Reales', faceValue: 8, sortOrder: 80 },
    { issuer: 'roman-empire', label: 'Denarius', faceValue: null, sortOrder: 10 },
  ],
};

/** Deep copy, so tests can mutate freely. */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The message of the error a call threw, or '' if it did not throw. */
function refusal(run: () => unknown): string {
  try {
    run();
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

/*
 * Accepted input
  */

describe('the format pinned in the design', () => {
  it('validates the worked example from the design document', () => {
    const seed = validateSeed(clone(VALID));
    expect(seed.issuers).toHaveLength(2);
    expect(seed.denominations).toHaveLength(2);
  });

  it('accepts an issuer with no ISO code, no end date and a BC start', () => {
    // Typical ancient issuer; a negative year is BC.
    const seed = validateSeed(clone(VALID));
    expect(seed.issuers[1]).toMatchObject({ isoCode: null, validFrom: -27, validTo: 476 });
  });

  it('accepts optional fields being absent rather than null', () => {
    const terse = {
      issuers: [{ key: 'mexico', name: 'Mexico', kind: 'modern', sortOrder: 1 }],
      denominations: [{ issuer: 'mexico', label: '8 Reales', sortOrder: 1 }],
    };
    const seed = validateSeed(terse);
    expect(seed.issuers[0].isoCode).toBeNull();
    expect(seed.denominations[0].faceValue).toBeNull();
  });

});

/*
 * Rejected input
  */

describe('a denomination naming an issuer that does not exist', () => {
  it('is refused, naming both the key and the label', () => {
    const seed = clone(VALID);
    seed.denominations[0].issuer = 'mexcio';
    const message = refusal(() => validateSeed(seed));

    expect(message).toContain('mexcio');
    expect(message).toContain('8 Reales');
  });

});

describe('duplicates', () => {
  it('refuses two issuers with the same key', () => {
    const seed = clone(VALID);
    seed.issuers[1].key = 'mexico';
    expect(refusal(() => validateSeed(seed))).toMatch(/duplicate issuer key.*mexico/i);
  });

  it('refuses two issuers with the same name, whatever their keys', () => {
    // Issuers.Name is UNIQUE and 013 joins on it.
    const seed = clone(VALID);
    seed.issuers[1].name = 'Mexico';
    expect(refusal(() => validateSeed(seed))).toMatch(/duplicate issuer name.*Mexico/i);
  });

  it('refuses two issuers whose names differ only in case', () => {
    // Matches SQL Server's case-insensitive default collation.
    const seed = clone(VALID);
    seed.issuers[1].name = 'MEXICO';
    expect(refusal(() => validateSeed(seed))).toMatch(/duplicate issuer name/i);
  });

  it('refuses the same label twice under one issuer', () => {
    // Duplicates make resolution of that label ambiguous (resolves to NULL).
    const seed = clone(VALID);
    seed.denominations.push({ issuer: 'mexico', label: '8 Reales', faceValue: 8, sortOrder: 81 });
    expect(refusal(() => validateSeed(seed))).toMatch(/duplicate denomination.*mexico.*8 Reales/i);
  });

  it('allows the same label under DIFFERENT issuers', () => {
    // e.g. Great Britain and Australia both struck a Crown.
    const seed = clone(VALID);
    seed.denominations.push({ issuer: 'roman-empire', label: '8 Reales', faceValue: 8, sortOrder: 99 });
    expect(() => validateSeed(seed)).not.toThrow();
  });
});

describe('field-level refusals', () => {
  it.each([
    ['a missing issuers array', { denominations: [] }, /issuers/i],
    ['a missing denominations array', { issuers: [] }, /denominations/i],
    ['not an object at all', 'nope', /object/i],
    ['null', null, /object/i],
  ])('refuses %s', (_label, input, pattern) => {
    expect(refusal(() => validateSeed(input))).toMatch(pattern);
  });

  it('refuses a kind that is not one of the three', () => {
    const seed = clone(VALID);
    (seed.issuers[0] as { kind: string }).kind = 'medieval';
    expect(refusal(() => validateSeed(seed))).toMatch(/kind.*medieval/i);
  });

  it('refuses an ISO code that is not two letters', () => {
    const seed = clone(VALID);
    seed.issuers[0].isoCode = 'MEX';
    expect(refusal(() => validateSeed(seed))).toMatch(/isoCode/i);
  });

  it('refuses a name longer than the NVARCHAR(100) column', () => {
    // SQL Server would abort the insert with error 8152.
    const seed = clone(VALID);
    seed.issuers[0].name = 'x'.repeat(101);
    expect(refusal(() => validateSeed(seed))).toMatch(/100/);
  });

  it('refuses a label longer than the NVARCHAR(100) column', () => {
    const seed = clone(VALID);
    seed.denominations[0].label = 'y'.repeat(101);
    expect(refusal(() => validateSeed(seed))).toMatch(/100/);
  });

  it('refuses a blank name, key or label', () => {
    for (const mutate of [
      (s: typeof VALID) => { s.issuers[0].name = '   '; },
      (s: typeof VALID) => { s.issuers[0].key = ''; },
      (s: typeof VALID) => { s.denominations[0].label = ' '; },
    ]) {
      const seed = clone(VALID);
      mutate(seed);
      expect(refusal(() => validateSeed(seed))).not.toBe('');
    }
  });

  it('refuses a non-integer sortOrder or year', () => {
    for (const mutate of [
      (s: typeof VALID) => { (s.issuers[0] as { sortOrder: unknown }).sortOrder = 'first'; },
      (s: typeof VALID) => { (s.issuers[0] as { validFrom: unknown }).validFrom = 1821.5; },
      (s: typeof VALID) => { (s.denominations[0] as { sortOrder: unknown }).sortOrder = null; },
    ]) {
      const seed = clone(VALID);
      mutate(seed);
      expect(refusal(() => validateSeed(seed))).not.toBe('');
    }
  });

  it('refuses an issuer that stopped before it started', () => {
    const seed = clone(VALID);
    seed.issuers[1].validFrom = 476;
    seed.issuers[1].validTo = -27;
    expect(refusal(() => validateSeed(seed))).toMatch(/validTo/i);
  });

  it('reports EVERY problem at once, not just the first', () => {
    const seed = clone(VALID);
    seed.issuers[0].name = '';
    seed.denominations[0].issuer = 'nowhere';
    const message = refusal(() => validateSeed(seed));
    expect(message).toMatch(/nowhere/);
    expect(message.split('\n').length).toBeGreaterThan(2);
  });
});

/*
 * Generated SQL
  */

describe('the British Mandate for Palestine', () => {
  const MANDATE_KEY = 'palestine-mandate';

  interface FullSeedFile {
    issuers: {
      key: string;
      name: string;
      isoCode: string | null;
      kind: string;
      validFrom: number | null;
      validTo: number | null;
      sortOrder: number;
    }[];
    denominations: { issuer: string; label: string; faceValue: number | null; sortOrder: number }[];
  }

  const seed = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf8')) as FullSeedFile;
  const issuer = seed.issuers.find((candidate) => candidate.key === MANDATE_KEY);
  const rows = seed.denominations.filter((row) => row.issuer === MANDATE_KEY);

  it('is in the seed, as a historical issuer with a closed date range', () => {
    expect(issuer).toBeDefined();
    expect(issuer).toMatchObject({
      name: 'British Mandate for Palestine',
      kind: 'historical',
      isoCode: null,
      validFrom: 1927,
      validTo: 1948,
    });
  });

  it('sits in the historical band of SortOrder, after the last entry there', () => {
    // SortOrder bands: modern 100-420, historical 1000-1150, ancient 2000+.
    const historical = seed.issuers.filter((candidate) => candidate.kind === 'historical');

    expect(issuer?.sortOrder).toBeGreaterThanOrEqual(1000);
    expect(issuer?.sortOrder).toBeLessThan(2000);
    expect(issuer?.sortOrder).toBe(Math.max(...historical.map((candidate) => candidate.sortOrder)));
  });

  it('carries exactly the seven circulating denominations', () => {
    expect(rows.map((row) => row.label)).toEqual([
      '1 Mil',
      '2 Mils',
      '5 Mils',
      '10 Mils',
      '20 Mils',
      '50 Mils',
      '100 Mils',
    ]);
  });

  it('prices every one of them in pounds, because a mil is a thousandth', () => {
    // faceValue is in the issuer's main unit (US '1c' is 0.01), so a mil is 0.001.
    for (const row of rows) {
      const mils = Number(/^(\d+) Mils?$/.exec(row.label)?.[1]);
      expect(mils, `could not read a mil count out of ${row.label}`).toBeGreaterThan(0);
      expect(row.faceValue).toBeCloseTo(mils / 1000, 10);
    }
  });

  it('has no coin above 100 mils, because above that they were banknotes', () => {
    const highest = Math.max(...rows.map((row) => row.faceValue ?? 0));
    expect(highest).toBe(0.1);
    expect(rows.some((row) => /pound|lira|500|250/i.test(row.label))).toBe(false);
  });

});

/*
 * Eight ancient issuers (Lydia, Aegina, Athens, Corinth, Syracuse, Carthage,
 * Greco-Bactrian, Hasmonean). Each list holds only denominations a source
 * attests by name for that issuer, so some are deliberately short.
 * Dates are approximate; validTo is the political end of the issuer.
 */

describe('the eight ancient issuers added after the Mandate', () => {
  interface AncientSeedShape {
    issuers: {
      key: string;
      name: string;
      isoCode: string | null;
      kind: string;
      validFrom: number | null;
      validTo: number | null;
      sortOrder: number;
    }[];
    denominations: { issuer: string; label: string; faceValue: number | null; sortOrder: number }[];
  }

  const ancientSeed = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf8')) as AncientSeedShape;

  const ADDED: Record<string, string[]> = {
    lydia: ['1/96 Stater', '1/48 Stater', '1/24 Stater', 'Hekte', 'Trite', 'Silver Stater', 'Gold Stater'],
    aegina: ['Drachm', 'Stater'],
    athens: [
      'Tetartemorion',
      'Hemiobol',
      'Obol',
      'Trihemiobol',
      'Diobol',
      'Triobol',
      'Drachm',
      'Didrachm',
      'Tetradrachm',
    ],
    corinth: ['Obol', 'Drachm', 'Stater'],
    syracuse: ['Tetradrachm', 'Dekadrachm'],
    carthage: ['Tenth Shekel', 'Fifth Shekel', 'Quarter Shekel', 'Half Shekel', 'Shekel', 'Tetradrachm'],
    'greco-bactrian-kingdom': ['Tetradrachm', 'Pentadrachm', 'Stater', '20 Stater'],
    'hasmonean-kingdom': ['Lepton', 'Half Prutah', 'Prutah'],
  };

  it('are all in the seed, as ancient issuers with closed BC spans and no ISO code', () => {
    for (const key of Object.keys(ADDED)) {
      const issuer = ancientSeed.issuers.find((candidate) => candidate.key === key);
      expect(issuer, `${key} is missing from the seed`).toBeDefined();
      expect(issuer?.kind, key).toBe('ancient');
      expect(issuer?.isoCode, key).toBeNull();
      expect(issuer?.validFrom ?? 0, `${key} validFrom`).toBeLessThan(0);
      expect(issuer?.validTo ?? 0, `${key} validTo`).toBeLessThan(0);
      expect(issuer?.validTo ?? 0, `${key} ends after it starts`).toBeGreaterThan(issuer?.validFrom ?? 0);
    }
  });

  it('is consistent with the derivation rule, so none of them needs a stored kind to stay ancient', () => {
    // The UI derives Kind 'ancient' for validFrom below 500.
    for (const key of Object.keys(ADDED)) {
      const issuer = ancientSeed.issuers.find((candidate) => candidate.key === key);
      expect(issuer?.validFrom ?? 0, `${key} must derive as ancient`).toBeLessThan(500);
    }
  });

  it('carries exactly the researched denominations, in ascending value order', () => {
    for (const [key, labels] of Object.entries(ADDED)) {
      const denominationRows = ancientSeed.denominations.filter((row) => row.issuer === key);
      expect(denominationRows.map((row) => row.label), key).toEqual(labels);
      // Smallest first, in steps of ten.
      expect(denominationRows.map((row) => row.sortOrder), `${key} sort order`).toEqual(
        labels.map((_unused, index) => (index + 1) * 10)
      );
    }
  });

  it('prices none of them, because an ancient denomination has no decimal face value', () => {
    for (const key of Object.keys(ADDED)) {
      for (const row of ancientSeed.denominations.filter((candidate) => candidate.issuer === key)) {
        expect(row.faceValue, `${key} / ${row.label}`).toBeNull();
      }
    }
  });

  it('gives no issuer the same label twice, across the whole file', () => {
    // Duplicates make resolution ambiguous (resolves to NULL).
    const seen = new Set<string>();
    for (const row of ancientSeed.denominations) {
      const pair = `${row.issuer}\u0000${row.label.toLowerCase()}`;
      expect(seen.has(pair), `${row.issuer} has '${row.label}' twice`).toBe(false);
      seen.add(pair);
    }
  });

  it('does not reuse a sort order the owner may already have taken', () => {
    // User-added issuers take MAX(SortOrder) + 10 after 2120, so these start at 3000.
    for (const key of Object.keys(ADDED)) {
      const issuer = ancientSeed.issuers.find((candidate) => candidate.key === key);
      expect(issuer?.sortOrder ?? 0, key).toBeGreaterThanOrEqual(3000);
    }
  });

});
