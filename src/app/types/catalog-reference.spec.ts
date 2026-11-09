/*
 * catalog-reference.spec.ts — the catalogue reference, tested as pure data.
 * These tests run under Node with no jsdom, which is why every rule they
 * check lives in a pure module rather than in the editor component. The
 * component is a view over these functions and has no logic of its own.
 *
 * WHAT IS ACTUALLY AT RISK HERE, test by test:
 *
 *   - THE SEED DRIFTING FROM THE MATCHER'S VOCABULARY. The catalogue list is
 *     not a wish list: it is the set of catalogues this collection already
 *     uses, and the matcher reads the same set out of
 *     image-matching/filename-vocabulary.ts. If somebody adds `peus` to the
 *     matcher and not here, a filename the matcher understands cannot be
 *     recorded on a coin. The first describe block ties the two together so
 *     that divergence is a build failure rather than a slow puzzle.
 *
 *   - A REFERENCE RENDERING AS "undefined 6819" or "Sear undefined". Every
 *     coin saved before migration 012 has neither field, and a coin can
 *     legitimately have a number with no catalogue (imported text) or a
 *     catalogue with no number (half-entered). All four combinations are
 *     pinned.
 *
 *   - THE NUMBER BEING "TIDIED". `II.1 234`, `RRC 44/5` and `1A` are real
 *     reference formats. Anything that upper-cases, strips punctuation or
 *     collapses spaces would silently rewrite the user's data.
 *
 *   - A STRING ID FAILING TO RESOLVE. The CSV importer copies cells verbatim,
 *     so `catalogId` can arrive as the STRING "3" rather than the number 3.
 *     A strict === lookup would then show no catalogue name at all for every
 *     imported coin, which is the quiet kind of wrong this project keeps
 *     being bitten by.
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
  formatCatalogReference
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
    // The design (§4.5) names this list and says where it comes from. Writing
    // it out in full is the point: a reviewer can check the expansions
    // (`rsc` -> `RSC`, not `Rsc`) by reading one line.
    expect(CATALOG_SEED).toEqual([
      'Sear', 'RIC', 'Hendin', 'RPC', 'Svoronos', 'BMC', 'SNG', 'Crawford',
      'Sydenham', 'Cohen', 'RSC', 'Meshorer', 'TJC', 'Kraay', 'Krause (KM)'
    ]);
  });

  it('covers every prefix the image matcher knows, in the same order', () => {
    // THE drift test. CATALOG_PREFIXES is lower-case and abbreviated; this
    // list is what a human sees in a dropdown. Comparing them case-folded
    // proves the expansion is a presentation change and nothing more -- no
    // prefix silently dropped, no catalogue invented.
    const seeded = CATALOG_SEED.map(name => name.toLowerCase());
    expect(seeded.slice(0, CATALOG_PREFIXES.length)).toEqual([...CATALOG_PREFIXES]);
  });

  it('adds Krause last, because it is the one that is NOT from the matcher', () => {
    // Krause/KM is world-coin numbering. No filename in this collection says
    // it, so it is not in CATALOG_PREFIXES -- it is here because the owner
    // asked for it. Keeping it at the end is what makes the test above a
    // clean prefix comparison instead of a set difference.
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
    // Half-entered is a real state: the user picks Sear, then tabs. Showing
    // "Sear" is honest; showing "Sear undefined" is a bug report.
    expect(formatCatalogReference('Sear', '')).toBe('Sear');
    expect(formatCatalogReference('Sear', undefined)).toBe('Sear');
  });

  it('shows the number alone when the catalogue is unknown', () => {
    // This is what an imported coin looks like: a reference the sheet gave us
    // with no catalogue we could resolve it to. The number is still the
    // user's data and must not disappear.
    expect(formatCatalogReference('', '6819')).toBe('6819');
    expect(formatCatalogReference(undefined, '6819')).toBe('6819');
  });

  it('is empty when there is nothing to say', () => {
    expect(formatCatalogReference('', '')).toBe('');
    expect(formatCatalogReference(undefined, undefined)).toBe('');
    // Whitespace is nothing, not something. Otherwise a cell that holds one
    // space renders as a blank-looking value the user cannot find or clear.
    expect(formatCatalogReference('  ', ' ')).toBe('');
  });

  it('preserves the reference exactly as the catalogues write it', () => {
    // These four are the formats named in the design. Nothing here may
    // upper-case, strip the dot, the slash or the internal space, or trim
    // anything but the outer edges.
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
    // The CSV importer writes cells verbatim, so an exported-and-reimported
    // coin carries catalogId as the string "3". A === lookup would answer
    // nothing and the grid would quietly lose every imported catalogue.
    expect(catalogNameById(CATALOGS, '3' as unknown as number)).toBe('Hendin');
  });

  it('answers nothing for a coin that has no catalogue', () => {
    expect(catalogNameById(CATALOGS, undefined)).toBe('');
    expect(catalogNameById(CATALOGS, null)).toBe('');
  });

  it('answers nothing for an id the list does not contain', () => {
    // A soft-deleted catalogue removed from the local list, a row from
    // another database, a hand-edited record. "" renders as the number
    // alone, which is more honest than inventing a name.
    expect(catalogNameById(CATALOGS, 404)).toBe('');
  });

  it('still names a SOFT-DELETED catalogue', () => {
    // Deleting a catalogue sets IsActive = 0; coins keep pointing at it.
    // Hiding the name here would make those coins read as a bare number for
    // no reason the user could see. Inactive rows are excluded from the
    // PICKER, not from display -- the same rule mint marks already follow.
    expect(catalogNameById(CATALOGS, 9)).toBe('Retired');
  });

  it('survives an empty or missing lookup list', () => {
    // Hydration order: the grid renders before /api/catalogs has answered.
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
    // Every coin that existed before migration 012. There are a lot of them.
    expect(coinCatalogReference(CATALOGS, undefined, undefined)).toBe('');
  });
});

describe('CATALOG_NUMBER_MAX_LENGTH', () => {
  it('is 50, matching Coins.CatalogNumber NVARCHAR(50)', () => {
    // The editor's maxlength is bound to this. A larger input would let the
    // user type a reference that SQL Server refuses (error 8152) or that the
    // mssql driver silently truncates, depending on which end is wrong.
    expect(CATALOG_NUMBER_MAX_LENGTH).toBe(50);
  });
});
