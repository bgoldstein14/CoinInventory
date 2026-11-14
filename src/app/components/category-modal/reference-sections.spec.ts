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
  ReferenceSection,
  ReferenceSectionId,
  compareReferenceSections,
  isReferenceSectionId,
  resolveReferenceSection,
} from './reference-sections';

describe('REFERENCE_SECTIONS — the panes the screen offers', () => {
  it('has one entry per maintainable reference type, issuers included', () => {
    // A denomination cannot be added without an issuer, so if issuers are
    // not maintainable the user hits a wall the moment the reference data
    // is missing their country.
    //
    // The order is the sidebar's: the seven lists A-Z by title, then the
    // one diagnostic. It replaced a curated reading order (issuers before
    // denominations, unlinked coins straight after) that was a teaching
    // aid on the first visit and an obstacle on every one after.
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
    /* The Settings dialog used to carry its own chip editor for metals.
     * It was the ONE list with no pane here, so it could not simply be
     * deleted with the duplicated ones — it had to be moved. A pane
     * missing from this list is a list the user can no longer edit at
     * all, which is why this is pinned by id rather than only by the
     * order assertion above. */
    const ids: string[] = REFERENCE_SECTIONS.map((section) => section.id);
    expect(ids).toContain('metal-content');
  });

  it('lists the reference lists A-Z by the title the sidebar shows', () => {
    /* By TITLE and not by id: the sidebar renders titles, and 'coin-sets'
     * sorts nowhere near 'Collection Sets'. An A-Z menu whose labels are
     * not in A-Z order is worse than no sort at all, because the user
     * stops scanning once they believe the order. */
    const titles = REFERENCE_SECTIONS.filter((section) => section.kind === 'list').map(
      (section) => section.title
    );
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'en')));
    expect(titles[0]).toBe('Catalogues');
  });

  it('puts the diagnostic pane last, after every reference list', () => {
    /* `Unlinked Coins` is not a list the user maintains: it lists COINS
     * that need attention and it is EMPTY on a healthy database. A pane
     * that is usually empty, sorted into the middle of seven that never
     * are, is a dead end between two live lists.
     *
     * Its discoverability does not depend on this position — the inventory
     * screen raises a banner whenever the count is non-zero, and that
     * banner opens the pane directly. */
    const kinds = REFERENCE_SECTIONS.map((section) => section.kind);
    expect(kinds.lastIndexOf('list')).toBeLessThan(kinds.indexOf('diagnostic'));
    expect(REFERENCE_SECTIONS[REFERENCE_SECTIONS.length - 1].id).toBe('unlinked');
  });

  it('keeps the diagnostic last by KIND, not by the letter it starts with', () => {
    /* 'Unlinked Coins' sorts last under a pure A-Z today purely by the
     * accident of its initial. Renaming it — 'Coins Needing Attention' has
     * been suggested, because nobody knows what "unlinked" means — would
     * drop it between Catalogues and Collection Sets under a pure sort.
     * The rule is about what the pane IS. */
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
