/*
 * reference-sections.ts — the maintenance screen's table of contents.
 *
 * WHY A SIDEBAR AND NOT TABS. The labels are long ("Collection Sets /
 * Albums", "Denominations") and will not fit one row inside a modal, so a tab
 * strip would either wrap — a stack again, with worse affordances — or scroll
 * sideways and hide the types the user came for. Each entry also carries a
 * second line of text ("how many entries, how many coins"), which tabs have
 * no room for. At a narrow viewport the sidebar degrades into a horizontal
 * scroll strip above the pane (see category-modal.scss): the tab layout as a
 * FALLBACK rather than the default.
 *
 * WHY THE SECTIONS ARE DATA. The sidebar is `@for (section of sections; ...)`.
 * Adding another type is one entry here plus one `@case` in the pane, and
 * the navigation, the highlighting and the keyboard handling come for free
 * and cannot drift from each other. Metal Content was added exactly that
 * way when it moved off the Settings dialog; nothing else had to change.
 *
 * Pure, dependency-free and DOM-free so it is testable under Node without
 * jsdom, like every other piece of logic in this project.
 */

/**
 * The reference types this screen maintains.
 *
 * Kebab-case because these ids are also used as DOM ids for the
 * aria-controls / aria-labelledby pairing between a sidebar button and its
 * pane.
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

export interface ReferenceSection {
  readonly id: ReferenceSectionId;
  /** What the sidebar entry and the pane heading say. */
  readonly title: string;
  /** The sentence under the heading — the only explanation of what the list is FOR. */
  readonly hint: string;
}

export const REFERENCE_SECTIONS: readonly ReferenceSection[] = [
  {
    id: 'categories',
    title: 'Categories',
    hint: "The choices offered in every coin's Category dropdown.",
  },
  {
    id: 'coin-sets',
    title: 'Collection Sets',
    hint: 'Named sets, albums and collections. Assign coins to one from the detail panel.',
  },
  {
    id: 'issuers',
    title: 'Issuers',
    hint:
      'Who struck the coin. Countries, but also the Roman Empire, the Papal States and the ' +
      'German states — which is why this is not called "Country". Every denomination belongs to one.',
  },
  {
    id: 'denominations',
    title: 'Denominations',
    hint:
      'Grouped by issuer, because there are over a thousand of them. Search finds one wherever ' +
      'it lives.',
  },
  /*
   * The one pane that lists COINS rather than reference rows. It lives here
   * because every fix it offers is a reference-data fix — pick an issuer,
   * pick a denomination, or add the missing denomination — and those panes
   * are the two directly above it.
   *
   * Nobody would find it here on their own, so the shell raises a banner on
   * the inventory screen whenever the count is non-zero and that banner opens
   * this pane directly (see app.html). Discoverability is the banner's job;
   * the fixing is this pane's.
   */
  {
    id: 'unlinked',
    title: 'Unlinked Coins',
    hint:
      /* The wording deliberately avoids spelling out the unresolved display
       * form, which denomination-display.spec.ts forbids any other file from
       * building — a second copy of that string is a fork, not a duplicate. */
      'Coins the grid shows as Other, because their denomination could not be matched to this ' +
      'list. Grouped by what they say, so one choice fixes every coin that says it.',
  },
  {
    id: 'mint-marks',
    title: 'Mint Marks',
    hint: 'The mint letters offered in the coin editor — D for Denver, S for San Francisco.',
  },
  /*
   * Metal content. It sits beside mint marks because it is the same kind of
   * list — a plain string the coin records as TEXT rather than a foreign
   * key — and it arrived here from the Settings dialog, which used to carry
   * its own chip editor for it. Categories, mint marks and sets had editors
   * in BOTH places and drifted; this one had no home here at all, so it got
   * a pane rather than a deletion.
   */
  {
    id: 'metal-content',
    title: 'Metal Content',
    hint:
      'What a coin is made of — the choices in the editor’s Metal dropdown, and what the ' +
      'melt-value calculation reads. Removing one leaves the metal already recorded on each coin.',
  },
  {
    id: 'catalogues',
    title: 'Catalogues',
    hint:
      'The reference works a coin can be attributed in — Sear, RIC, Hendin, Krause. With the ' +
      'number beside it in the editor these read as "Sear 6819".',
  },
] as const;

/**
 * The pane the screen opens on.
 *
 * Categories, deliberately, and not Denominations: opening on the biggest and
 * most expensive pane would make every visit to this dialog — including the
 * ones that only wanted to add a category — pay for a thousand-odd rows.
 */
export const DEFAULT_REFERENCE_SECTION: ReferenceSectionId = 'categories';

const SECTION_IDS: ReadonlySet<string> = new Set(REFERENCE_SECTIONS.map((section) => section.id));

/** Type guard, so a string from outside cannot reach the pane switch. */
export function isReferenceSectionId(value: string): value is ReferenceSectionId {
  return SECTION_IDS.has(value);
}

/**
 * Turn whatever arrived into a section that exists.
 *
 * THE BUG THIS PREVENTS: a remembered or mistyped id rendering a modal with a
 * highlighted sidebar and a completely empty body, which looks exactly like
 * the dialog having crashed. Falling back is never wrong here — the worst
 * case is the user clicks once more.
 */
export function resolveReferenceSection(requested: string | null | undefined): ReferenceSectionId {
  const candidate = String(requested ?? '').trim().toLowerCase();
  return isReferenceSectionId(candidate) ? candidate : DEFAULT_REFERENCE_SECTION;
}
