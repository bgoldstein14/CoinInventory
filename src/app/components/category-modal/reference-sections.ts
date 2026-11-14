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
 * WHY THE ORDER IS COMPUTED AND NOT WRITTEN DOWN. The sidebar is A-Z, so
 * the order an entry appears in the array below means nothing — see
 * `compareReferenceSections`, which also explains why `Unlinked Coins` is
 * pinned last rather than sorted with the others.
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

/**
 * What KIND of pane this is, which is the one thing the A-Z sort has to know
 * about.
 *
 * Seven of these panes maintain a reference LIST — rows the user adds,
 * renames and removes. `Unlinked Coins` does not: it lists COINS that need
 * attention, it empties as they are fixed, and on a healthy database it is
 * empty for good. It is a diagnostic, and a diagnostic is not something you
 * go looking for alphabetically.
 */
export type ReferenceSectionKind = 'list' | 'diagnostic';

export interface ReferenceSection {
  readonly id: ReferenceSectionId;
  /** What the sidebar entry and the pane heading say. */
  readonly title: string;
  /** The sentence under the heading — the only explanation of what the list is FOR. */
  readonly hint: string;
  /** Reference list, or diagnostic. Decides only where the sort puts it. */
  readonly kind: ReferenceSectionKind;
}

/**
 * The panes, DECLARED. The order here is not the order on screen —
 * `REFERENCE_SECTIONS` below sorts them — so a new entry can go wherever it
 * reads best beside its neighbours and its comment.
 */
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
  /*
   * The one pane that lists COINS rather than reference rows. It belongs on
   * this screen because every fix it offers is a reference-data fix — pick
   * an issuer, pick a denomination, or add the missing denomination.
   *
   * It used to sit immediately below Denominations for that reason. It is
   * now LAST, because it is a diagnostic rather than a list and because the
   * sidebar is A-Z; `compareReferenceSections` carries that argument. Its
   * `kind` is what keeps it there.
   *
   * Nobody would find it here on their own, so the shell raises a banner on
   * the inventory screen whenever the count is non-zero and that banner opens
   * this pane directly (see app.html). Discoverability is the banner's job;
   * the fixing is this pane's.
   */
  {
    id: 'unlinked',
    kind: 'diagnostic',
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
    kind: 'list',
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
 * Sidebar order: THE REFERENCE LISTS A-Z, THEN THE DIAGNOSTIC.
 *
 * WHY ALPHABETICAL AT ALL. The order used to be a reading order — issuers
 * before denominations because you need one to add the other, unlinked
 * coins straight after because that is where its fixes send you. That is a
 * good argument the first time somebody opens the screen and a bad one
 * every time after, when they know which list they want and are hunting for
 * its label. Eight entries is past the point where a curated order can be
 * scanned, and the owner asked for A-Z.
 *
 * WHY `Unlinked Coins` IS PINNED LAST RATHER THAN SORTED WITH THE REST.
 * It is not the same kind of thing. The other seven are lists the user
 * maintains; this one lists COINS that need attention and is EMPTY on a
 * healthy database — the state it is meant to reach. Sorting a pane that is
 * usually empty into the middle of the seven that are never empty puts a
 * dead end between two live lists.
 *
 * Note that a pure A-Z would put it last TODAY anyway, by the accident of
 * its initial letter. Pinning it by kind is what makes that survive: rename
 * it to "Coins Needing Attention" — which has been suggested, because
 * nobody knows what "unlinked" means — and a pure sort would drop it
 * between Catalogues and Collection Sets. The rule is about what the pane
 * IS, so it is expressed as `kind` and not as a title that happens to start
 * with U.
 *
 * Its own discoverability does not depend on this position: the inventory
 * screen raises a banner whenever the count is non-zero and that banner
 * opens the pane directly (see app.html). The sidebar is where you look
 * when you already know; the banner is what tells you.
 *
 * `sensitivity: 'accent'` folds case but not accents, and the locale is
 * pinned to 'en', for the same reasons `compareIssuersByName` in
 * denomination-grouping.ts gives: the order a test asserts has to be the
 * order the user sees, on any machine.
 */
export function compareReferenceSections(left: ReferenceSection, right: ReferenceSection): number {
  const leftIsDiagnostic = left.kind === 'diagnostic' ? 1 : 0;
  const rightIsDiagnostic = right.kind === 'diagnostic' ? 1 : 0;
  if (leftIsDiagnostic !== rightIsDiagnostic) return leftIsDiagnostic - rightIsDiagnostic;
  return left.title.localeCompare(right.title, 'en', { sensitivity: 'accent' });
}

/**
 * The panes, in the order the sidebar shows them.
 *
 * A copy, because `.sort()` mutates and `DECLARED_SECTIONS` is the source
 * of truth that the next reader edits.
 */
export const REFERENCE_SECTIONS: readonly ReferenceSection[] =
  [...DECLARED_SECTIONS].sort(compareReferenceSections);

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
