/*
 * reference-sections.spec.ts — the maintenance screen's table of contents.
 *
 * The set of types is DATA, and these tests pin the properties the screen
 * depends on: ids are unique (two panes answering to one id means the sidebar
 * highlights one and shows the other), every pane has something to say about
 * itself, and an id that is not in the list resolves to one that is rather
 * than rendering a blank body.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REFERENCE_SECTION,
  REFERENCE_SECTIONS,
  ReferenceSectionId,
  isReferenceSectionId,
  resolveReferenceSection,
} from './reference-sections';

describe('REFERENCE_SECTIONS — the panes the screen offers', () => {
  it('has one entry per maintainable reference type, issuers included', () => {
    // A denomination cannot be added without an issuer, so if issuers are
    // not maintainable the user hits a wall the moment the reference data
    // is missing their country.
    const ids = REFERENCE_SECTIONS.map((section) => section.id);
    expect(ids).toEqual([
      'categories',
      'coin-sets',
      'issuers',
      'denominations',
      'unlinked',
      'mint-marks',
      'metal-content',
      'catalogues',
    ]);
  });

  it('maintains metal content here, and not in Settings', () => {
    /* The Settings dialog used to carry its own chip editor for metals.
     * It was the ONE list with no pane here, so it could not simply be
     * deleted with the duplicated ones — it had to be moved. A pane
     * missing from this list is a list the user can no longer edit at
     * all, which is why this is pinned by id rather than only by the
     * order assertion above. */
    const ids: string[] = REFERENCE_SECTIONS.map((section) => section.id);
    expect(ids).toContain('metal-content');
  });

  it('puts the unlinked-coins pane immediately after denominations', () => {
    /* The three denomination panes read as one story in sidebar order:
     * an issuer, the denominations filed under it, and then the coins that
     * could not be filed under any of them. Putting the cleanup pane at the
     * bottom of the list, below mint marks and catalogues, would separate it
     * from the two panes its own fixes send the user to. */
    const ids: string[] = REFERENCE_SECTIONS.map((section) => section.id);
    expect(ids.indexOf('unlinked')).toBe(ids.indexOf('denominations') + 1);
  });

  it('puts issuers before denominations', () => {
    // Reading order is teaching order: you choose an issuer to add a
    // denomination, so the issuer pane has to be the one you have already
    // walked past.
    const ids: string[] = REFERENCE_SECTIONS.map((section) => section.id);
    expect(ids.indexOf('issuers')).toBeLessThan(ids.indexOf('denominations'));
  });

  it('gives every section a unique id', () => {
    const ids = REFERENCE_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every section a title and a hint', () => {
    // The hint is the only thing that says what each list is FOR. A pane
    // without one is tidier and less useful.
    for (const section of REFERENCE_SECTIONS) {
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.hint.trim().length).toBeGreaterThan(10);
    }
  });

  it('names a default that is actually one of the sections', () => {
    const ids: string[] = REFERENCE_SECTIONS.map((section) => section.id);
    expect(ids).toContain(DEFAULT_REFERENCE_SECTION);
  });
});

describe('resolveReferenceSection — never render an empty pane', () => {
  it('returns a known id unchanged', () => {
    expect(resolveReferenceSection('denominations')).toBe('denominations');
    expect(resolveReferenceSection('catalogues')).toBe('catalogues');
  });

  it('falls back to the default for anything it does not recognise', () => {
    // A stale id can arrive from a remembered preference or a typo in a
    // caller. Rendering nothing at all would look like the dialog had broken.
    expect(resolveReferenceSection('metals')).toBe(DEFAULT_REFERENCE_SECTION);
    expect(resolveReferenceSection('')).toBe(DEFAULT_REFERENCE_SECTION);
    expect(resolveReferenceSection(null)).toBe(DEFAULT_REFERENCE_SECTION);
    expect(resolveReferenceSection(undefined)).toBe(DEFAULT_REFERENCE_SECTION);
  });

  it('is case- and whitespace-tolerant', () => {
    expect(resolveReferenceSection('  Denominations ')).toBe('denominations');
  });
});

describe('isReferenceSectionId', () => {
  it('accepts every declared id and rejects everything else', () => {
    for (const section of REFERENCE_SECTIONS) {
      expect(isReferenceSectionId(section.id)).toBe(true);
    }
    expect(isReferenceSectionId('denomination')).toBe(false);
    expect(isReferenceSectionId('')).toBe(false);
  });

  it('narrows the type, so a bad id cannot reach the switch', () => {
    const candidate: string = 'issuers';
    if (isReferenceSectionId(candidate)) {
      const narrowed: ReferenceSectionId = candidate;
      expect(narrowed).toBe('issuers');
    } else {
      expect.unreachable('issuers is a declared section id');
    }
  });
});
