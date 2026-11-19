/*
 * Tests for the catalogue reference helpers: the seed list stays in step with
 * the image matcher's vocabulary, every catalogue/number combination renders
 * cleanly, reference numbers are preserved as typed, and ids that arrive as
 * strings (from CSV import) still resolve.
 */

import { describe, it, expect } from 'vitest';
import { CATALOG_PREFIXES } from '../services/image-matching/filename-vocabulary';
import {
  CATALOG_NAME_MAX_LENGTH,
  CATALOG_NUMBER_MAX_LENGTH,
  CATALOG_SEED,
  CatalogOption,
  catalogNameById,
  coinCatalogReference,
  formatCatalogReference,
  formatCatalogRefs,
  formatMainCatalogRef,
  mainCatalogRef,
  normalizeCatalogRefs,
  parseCatalogRefs
} from './catalog-reference';

/** A small, realistic lookup list, in the shape the API returns. */
const CATALOGS: CatalogOption[] = [
  { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true },
  { catalogId: 2, name: 'RIC', sortOrder: 2, isActive: true },
  { catalogId: 3, name: 'Hendin', sortOrder: 3, isActive: true },
  { catalogId: 9, name: 'Retired', sortOrder: 9, isActive: false }
];

describe('CATALOG_SEED', () => {
  it('is exactly the matcher vocabulary, expanded, plus Krause', () => {
    // Written out in full so the expansions (`rsc` -> `RSC`) can be checked at a glance.
    expect(CATALOG_SEED).toEqual([
      'Sear', 'RIC', 'Hendin', 'RPC', 'Svoronos', 'BMC', 'SNG', 'Crawford',
      'Sydenham', 'Cohen', 'RSC', 'Meshorer', 'TJC', 'Kraay', 'Krause (KM)'
    ]);
  });

  it('covers every prefix the image matcher knows, in the same order', () => {
    // Case-folded, the seed must start with exactly the matcher's prefixes.
    const seeded = CATALOG_SEED.map(name => name.toLowerCase());
    expect(seeded.slice(0, CATALOG_PREFIXES.length)).toEqual([...CATALOG_PREFIXES]);
  });

  it('adds Krause last, because it is the one that is NOT from the matcher', () => {
    // Krause (world coins) is not a matcher prefix; keeping it last keeps the
    // test above a simple prefix comparison.
    expect(CATALOG_SEED[CATALOG_SEED.length - 1]).toBe('Krause (KM)');
    expect(CATALOG_PREFIXES).not.toContain('krause');
  });

  it('has no duplicates', () => {
    expect(new Set(CATALOG_SEED).size).toBe(CATALOG_SEED.length);
  });

  it('fits the NVARCHAR(60) column it is seeded into', () => {
    expect(CATALOG_NAME_MAX_LENGTH).toBe(60);
    for (const name of CATALOG_SEED) {
      expect(name.length).toBeLessThanOrEqual(CATALOG_NAME_MAX_LENGTH);
    }
  });
});

describe('formatCatalogReference', () => {
  it('joins the catalogue and the number with a single space', () => {
    expect(formatCatalogReference('Sear', '6819')).toBe('Sear 6819');
  });

  it('shows the catalogue alone when no number has been typed yet', () => {
    // Half-entered: the user picked a catalogue but no number yet.
    expect(formatCatalogReference('Sear', '')).toBe('Sear');
    expect(formatCatalogReference('Sear', undefined)).toBe('Sear');
  });

  it('shows the number alone when the catalogue is unknown', () => {
    // Typical of imported coins: a number with no resolvable catalogue.
    expect(formatCatalogReference('', '6819')).toBe('6819');
    expect(formatCatalogReference(undefined, '6819')).toBe('6819');
  });

  it('is empty when there is nothing to say', () => {
    expect(formatCatalogReference('', '')).toBe('');
    expect(formatCatalogReference(undefined, undefined)).toBe('');
    // Whitespace-only counts as empty.
    expect(formatCatalogReference('  ', ' ')).toBe('');
  });

  it('preserves the reference exactly as the catalogues write it', () => {
    // Real reference formats: no case changes or punctuation/space stripping.
    expect(formatCatalogReference('Sear', '1A')).toBe('Sear 1A');
    expect(formatCatalogReference('RIC', 'II.1 234')).toBe('RIC II.1 234');
    expect(formatCatalogReference('Crawford', 'RRC 44/5')).toBe('Crawford RRC 44/5');
    expect(formatCatalogReference('Hendin', '1234')).toBe('Hendin 1234');
  });

  it('trims the outside without touching the inside', () => {
    expect(formatCatalogReference(' Sear ', ' II.1 234 ')).toBe('Sear II.1 234');
  });
});

describe('catalogNameById', () => {
  it('finds the catalogue', () => {
    expect(catalogNameById(CATALOGS, 1)).toBe('Sear');
    expect(catalogNameById(CATALOGS, 3)).toBe('Hendin');
  });

  it('resolves an id that arrived as text', () => {
    // The CSV importer copies cells verbatim, so catalogId can be the string "3".
    expect(catalogNameById(CATALOGS, '3' as unknown as number)).toBe('Hendin');
  });

  it('answers nothing for a coin that has no catalogue', () => {
    expect(catalogNameById(CATALOGS, undefined)).toBe('');
    expect(catalogNameById(CATALOGS, null)).toBe('');
  });

  it('answers nothing for an id the list does not contain', () => {
    // "" makes the reference render as the number alone.
    expect(catalogNameById(CATALOGS, 404)).toBe('');
  });

  it('still names a SOFT-DELETED catalogue', () => {
    // Inactive rows are hidden from the picker, not from display (as with mint marks).
    expect(catalogNameById(CATALOGS, 9)).toBe('Retired');
  });

  it('survives an empty or missing lookup list', () => {
    // The grid can render before /api/catalogs has answered.
    expect(catalogNameById([], 1)).toBe('');
    expect(catalogNameById(undefined, 1)).toBe('');
  });
});

describe('coinCatalogReference', () => {
  it('renders the whole reference from a coin\'s two stored fields', () => {
    expect(coinCatalogReference(CATALOGS, 1, '6819')).toBe('Sear 6819');
  });

  it('falls back to the number when the catalogue cannot be resolved', () => {
    expect(coinCatalogReference(CATALOGS, 404, '6819')).toBe('6819');
    expect(coinCatalogReference(undefined, 1, '6819')).toBe('6819');
  });

  it('is empty for a coin that has no catalogue reference at all', () => {
    // E.g. coins saved before migration 012.
    expect(coinCatalogReference(CATALOGS, undefined, undefined)).toBe('');
  });
});

describe('CATALOG_NUMBER_MAX_LENGTH', () => {
  it('is 50, matching Coins.CatalogNumber NVARCHAR(50)', () => {
    // The editor's maxlength is bound to this; longer input would fail or truncate in SQL Server.
    expect(CATALOG_NUMBER_MAX_LENGTH).toBe(50);
  });
});

describe('multiple references', () => {
  const SEAR = { catalogId: 1, catalogNumber: '6819' };
  const RIC = { catalogId: 2, catalogNumber: '123' };
  const COHEN = { catalogId: 4, catalogNumber: '45' };
  const LIST: CatalogOption[] = [
    ...CATALOGS,
    { catalogId: 4, name: 'Cohen', sortOrder: 4, isActive: true },
    { catalogId: 5, name: 'Krause (KM)', sortOrder: 5, isActive: true },
    { catalogId: 6, name: ' SEAR ', sortOrder: 6, isActive: true }
  ];

  describe('mainCatalogRef', () => {
    it('prefers a Sear reference wherever it is in the list', () => {
      expect(mainCatalogRef(LIST, [RIC, SEAR])).toEqual(SEAR);
    });
    it('falls back to the first reference', () => {
      expect(mainCatalogRef(LIST, [RIC, COHEN])).toEqual(RIC);
    });
    it('takes the first of two Sear references', () => {
      const second = { catalogId: 1, catalogNumber: '7000' };
      expect(mainCatalogRef(LIST, [RIC, SEAR, second])).toEqual(SEAR);
    });
    it('matches the Sear name case-insensitively and trimmed', () => {
      const odd = { catalogId: 6, catalogNumber: '1' };
      expect(mainCatalogRef(LIST, [RIC, odd])).toEqual(odd);
    });
    it('returns null for no references', () => {
      expect(mainCatalogRef(LIST, [])).toBeNull();
      expect(mainCatalogRef(LIST, undefined)).toBeNull();
    });
  });

  describe('formatMainCatalogRef', () => {
    it('shows the main reference and how many others there are', () => {
      expect(formatMainCatalogRef(LIST, [RIC, SEAR, COHEN])).toBe('Sear 6819 (+2)');
    });
    it('has no suffix for a single reference', () => {
      expect(formatMainCatalogRef(LIST, [RIC])).toBe('RIC 123');
    });
    it('shows a number with no catalogue on its own', () => {
      expect(formatMainCatalogRef(LIST, [{ catalogId: null, catalogNumber: '99' }])).toBe('99');
    });
    it('is empty with no references', () => {
      expect(formatMainCatalogRef(LIST, undefined)).toBe('');
    });
    it('does not count a new row that has no number yet, or a duplicate', () => {
      expect(formatMainCatalogRef(LIST, [RIC, { catalogId: null, catalogNumber: '' }])).toBe('RIC 123');
      expect(formatMainCatalogRef(LIST, [{ catalogId: null, catalogNumber: '' }, RIC, RIC])).toBe('RIC 123');
    });
  });

  it('formatCatalogRefs lists every reference in order', () => {
    expect(formatCatalogRefs(LIST, [RIC, SEAR, COHEN])).toBe('RIC 123; Sear 6819; Cohen 45');
    expect(formatCatalogRefs(LIST, [])).toBe('');
  });

  it('normalizeCatalogRefs trims, drops empty numbers and duplicates', () => {
    expect(normalizeCatalogRefs([
      { catalogId: 1, catalogNumber: ' 6819 ' },
      { catalogId: 1, catalogNumber: '6819' },
      { catalogId: 2, catalogNumber: '' },
      { catalogId: null, catalogNumber: '5' },
      { catalogId: null, catalogNumber: '5' }
    ])).toEqual([
      { catalogId: 1, catalogNumber: '6819' },
      { catalogId: null, catalogNumber: '5' }
    ]);
  });

  describe('parseCatalogRefs', () => {
    it('splits a cell and matches catalogue names, longest first', () => {
      expect(parseCatalogRefs(' Sear 6819 ;; RIC 123; Krause (KM) 110; Foo 9 ', LIST)).toEqual([
        { catalogId: 1, catalogNumber: '6819' },
        { catalogId: 2, catalogNumber: '123' },
        { catalogId: 5, catalogNumber: '110' },
        { catalogId: null, catalogNumber: 'Foo 9' }
      ]);
    });
    it('matches inactive catalogues too', () => {
      expect(parseCatalogRefs('Retired 4', LIST)).toEqual([{ catalogId: 9, catalogNumber: '4' }]);
    });
    it('does not treat a name prefix inside a word as a catalogue', () => {
      expect(parseCatalogRefs('Searle 1', LIST)).toEqual([{ catalogId: null, catalogNumber: 'Searle 1' }]);
    });
    it('round-trips with formatCatalogRefs', () => {
      const refs = [RIC, SEAR, { catalogId: null, catalogNumber: '77-A' }];
      expect(parseCatalogRefs(formatCatalogRefs(LIST, refs), LIST)).toEqual(refs);
    });
    it('keeps a bare catalogue name as text rather than dropping it', () => {
      expect(parseCatalogRefs('Sear', LIST)).toEqual([{ catalogId: null, catalogNumber: 'Sear' }]);
    });
    it('prefers an active catalogue when a removed one has the same name', () => {
      const tie: CatalogOption[] = [
        { catalogId: 20, name: 'Sear', sortOrder: 1, isActive: false },
        { catalogId: 21, name: 'Sear', sortOrder: 2, isActive: true }
      ];
      expect(parseCatalogRefs('Sear 1', tie)).toEqual([{ catalogId: 21, catalogNumber: '1' }]);
    });
    it('reads a number typed with its catalogue name as that catalogue', () => {
      // A number-only "RIC 5" exports as text and re-imports attached to RIC.
      expect(parseCatalogRefs('RIC 5', LIST)).toEqual([{ catalogId: 2, catalogNumber: '5' }]);
    });
    it('returns nothing for an empty cell', () => {
      expect(parseCatalogRefs('  ', LIST)).toEqual([]);
    });
  });
});
