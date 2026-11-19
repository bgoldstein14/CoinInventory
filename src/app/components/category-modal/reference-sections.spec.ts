/*
 * Reference sections: unique ids, a hint for every pane, A-Z order with the
 * diagnostic pane last, and unknown ids resolving to a real pane.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REFERENCE_SECTION,
  REFERENCE_SECTIONS,
  ReferenceSection,
  ReferenceSectionId,
  compareReferenceSections,
  isReferenceSectionId,
  resolveReferenceSection,
} from './reference-sections';

describe('REFERENCE_SECTIONS — the panes the screen offers', () => {
  it('has one entry per maintainable reference type, issuers included', () => {
    // Sidebar order: the lists A-Z by title, then the diagnostic pane.
    const ids = REFERENCE_SECTIONS.map((section) => section.id);
    expect(ids).toEqual([
      'catalogues',
      'categories',
      'coin-sets',
      'denominations',
      'issuers',
      'metal-content',
      'mint-marks',
      'unlinked',
    ]);
  });

  it('maintains metal content here, and not in Settings', () => {
    // Metal content must have a pane; it is not edited anywhere else.
    const ids: string[] = REFERENCE_SECTIONS.map((section) => section.id);
    expect(ids).toContain('metal-content');
  });

  it('lists the reference lists A-Z by the title the sidebar shows', () => {
    // Sorted by title, since titles are what the sidebar shows.
    const titles = REFERENCE_SECTIONS.filter((section) => section.kind === 'list').map(
      (section) => section.title
    );
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'en')));
    expect(titles[0]).toBe('Catalogues');
  });

  it('puts the diagnostic pane last, after every reference list', () => {
    // Unlinked Coins is a diagnostic pane and goes after the lists.
    const kinds = REFERENCE_SECTIONS.map((section) => section.kind);
    expect(kinds.lastIndexOf('list')).toBeLessThan(kinds.indexOf('diagnostic'));
    expect(REFERENCE_SECTIONS[REFERENCE_SECTIONS.length - 1].id).toBe('unlinked');
  });

  it('keeps the diagnostic last by KIND, not by the letter it starts with', () => {
    // Pinned by kind, not by its title happening to start with U.
    const renamed: ReferenceSection = {
      id: 'unlinked',
      title: 'Coins Needing Attention',
      hint: 'Whatever the wording, this is still the diagnostic.',
      kind: 'diagnostic',
    };
    const catalogues = REFERENCE_SECTIONS.find((section) => section.id === 'catalogues');
    expect(catalogues).toBeDefined();

    expect(compareReferenceSections(renamed, catalogues!)).toBeGreaterThan(0);
    expect(compareReferenceSections(catalogues!, renamed)).toBeLessThan(0);
  });

  it('says which kind every section is', () => {
    for (const section of REFERENCE_SECTIONS) {
      expect(['list', 'diagnostic']).toContain(section.kind);
    }
    expect(REFERENCE_SECTIONS.filter((section) => section.kind === 'diagnostic')).toHaveLength(1);
  });

  it('gives every section a unique id', () => {
    const ids = REFERENCE_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every section a title and a hint', () => {
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
    // A stale or mistyped id falls back rather than rendering an empty pane.
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
