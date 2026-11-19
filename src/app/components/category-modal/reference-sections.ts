/*
 * The panes of the reference-data screen, as data: the sidebar loops over
 * them, so adding a type is one entry here plus one `@case` in the template.
 * The sidebar order is computed (`compareReferenceSections`).
 */

/**
 * The reference types this screen maintains. Kebab-case because they are also
 * used as DOM ids for the aria-controls / aria-labelledby pairing.
 */
export type ReferenceSectionId =
  | 'categories'
  | 'coin-sets'
  | 'issuers'
  | 'denominations'
  | 'unlinked'
  | 'mint-marks'
  | 'metal-content'
  | 'catalogues';

/**
 * 'list' panes maintain reference rows; 'diagnostic' panes (Unlinked Coins)
 * list coins needing attention. Used only for sidebar ordering.
 */
export type ReferenceSectionKind = 'list' | 'diagnostic';

export interface ReferenceSection {
  readonly id: ReferenceSectionId;
  /** What the sidebar entry and the pane heading say. */
  readonly title: string;
  /** The sentence under the heading explaining what the list is for. */
  readonly hint: string;
  /** Decides only where the sort puts it. */
  readonly kind: ReferenceSectionKind;
}

/** The panes, in any order; `REFERENCE_SECTIONS` sorts them. */
const DECLARED_SECTIONS: readonly ReferenceSection[] = [
  {
    id: 'categories',
    kind: 'list',
    title: 'Categories',
    hint: "The choices offered in every coin's Category dropdown.",
  },
  {
    id: 'coin-sets',
    kind: 'list',
    title: 'Collection Sets',
    hint: 'Named sets, albums and collections. Assign coins to one from the detail panel.',
  },
  {
    id: 'issuers',
    kind: 'list',
    title: 'Issuers',
    hint:
      'Who struck the coin. Countries, but also the Roman Empire, the Papal States and the ' +
      'German states — which is why this is not called "Country". Every denomination belongs to one.',
  },
  {
    id: 'denominations',
    kind: 'list',
    title: 'Denominations',
    hint:
      'Grouped by issuer, because there are over a thousand of them. Search finds one wherever ' +
      'it lives.',
  },
  // Lists coins rather than reference rows; the inventory screen's banner links here (see app.html).
  {
    id: 'unlinked',
    kind: 'diagnostic',
    title: 'Unlinked Coins',
    hint:
      // Avoids spelling out the unresolved display form, which only denomination-display may build.
      'Coins the grid shows as Other, because their denomination could not be matched to this ' +
      'list. Grouped by what they say, so one choice fixes every coin that says it.',
  },
  {
    id: 'mint-marks',
    kind: 'list',
    title: 'Mint Marks',
    hint: 'The mint letters offered in the coin editor — D for Denver, S for San Francisco.',
  },
  {
    id: 'metal-content',
    kind: 'list',
    title: 'Metal Content',
    hint:
      'What a coin is made of — the choices in the editor’s Metal dropdown, and what the ' +
      'melt-value calculation reads. Removing one leaves the metal already recorded on each coin.',
  },
  {
    id: 'catalogues',
    kind: 'list',
    title: 'Catalogues',
    hint:
      'The reference works a coin can be attributed in — Sear, RIC, Hendin, Krause. With the ' +
      'number beside it in the editor these read as "Sear 6819".',
  },
] as const;

/**
 * Sidebar order: list panes A-Z, then diagnostic panes. Pinned by `kind`
 * rather than title so a renamed diagnostic pane stays last. Locale is pinned
 * to 'en' so the order is the same on every machine.
 */
export function compareReferenceSections(left: ReferenceSection, right: ReferenceSection): number {
  const leftIsDiagnostic = left.kind === 'diagnostic' ? 1 : 0;
  const rightIsDiagnostic = right.kind === 'diagnostic' ? 1 : 0;
  if (leftIsDiagnostic !== rightIsDiagnostic) return leftIsDiagnostic - rightIsDiagnostic;
  return left.title.localeCompare(right.title, 'en', { sensitivity: 'accent' });
}

/** The panes in sidebar order (a sorted copy). */
export const REFERENCE_SECTIONS: readonly ReferenceSection[] =
  [...DECLARED_SECTIONS].sort(compareReferenceSections);

/** The pane the screen opens on; Categories rather than the large Denominations pane. */
export const DEFAULT_REFERENCE_SECTION: ReferenceSectionId = 'categories';

const SECTION_IDS: ReadonlySet<string> = new Set(REFERENCE_SECTIONS.map((section) => section.id));

/** Type guard for section ids. */
export function isReferenceSectionId(value: string): value is ReferenceSectionId {
  return SECTION_IDS.has(value);
}

/**
 * Resolve any input to an existing section, falling back to the default so
 * an unknown id never renders an empty pane.
 */
export function resolveReferenceSection(requested: string | null | undefined): ReferenceSectionId {
  const candidate = String(requested ?? '').trim().toLowerCase();
  return isReferenceSectionId(candidate) ? candidate : DEFAULT_REFERENCE_SECTION;
}
