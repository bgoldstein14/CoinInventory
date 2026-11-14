/*
 * denomination-expansion.ts — which issuer groups are open, for 70 of them.
 *
 * THE PROBLEM THIS SOLVES. The Denominations pane carries 70 issuer groups
 * and 1,207 rows. Every group starts open, so reaching one issuer means
 * scrolling past every issuer that sorts before it. One control that folds
 * the whole list away turns that scroll into a list of 70 headings.
 *
 * WHY A DEFAULT PLUS EXCEPTIONS, AND NOT A SET OF COLLAPSED HEADINGS.
 * The obvious model — "the set of headings the user folded away" — cannot
 * express "everything is closed", because the set has to be enumerated from
 * the groups that happen to be on screen at the time. Two things then go
 * wrong, and both of them have the same shape: a group that was NOT on
 * screen when the user pressed the control does not get folded.
 *
 *   * Collapse all, then add an issuer: the new group is not in the set, so
 *     it renders open while every other group is closed. Harmless by luck
 *     here, but the same hole the other way round is not.
 *   * Collapse all while a search is running (the search shows a handful of
 *     groups), then clear the search: the 60-odd groups that were filtered
 *     out were never added to the set and spring open again.
 *
 * Storing a DEFAULT and the headings that differ from it has neither hole:
 * a group nobody has ever seen follows the default, which is what "all"
 * means. It is also what makes `focusGroup` a single value rather than a
 * loop over headings the caller would have to supply.
 *
 * WHY THIS IS NOT PERSISTED HERE. Expansion is UI state and belongs to the
 * component that renders it. A future change persists UI state across
 * sessions through `StorageKeys` in services/storage.service.ts; the hook
 * is a `GroupExpansion` in and out of the component's signal, which is why
 * the type is a plain data structure with no component, no service and no
 * storage in sight. See the note on `groupExpansion` in category-modal.ts.
 *
 * Pure, dependency-free and DOM-free, like every other piece of logic in
 * this folder: the frontend suite runs under Node with no jsdom.
 */

/**
 * Which groups are open.
 *
 * `exceptions` holds the headings that do NOT follow `collapsedByDefault` —
 * so it is a set of open groups when the default is collapsed, and a set of
 * closed groups when the default is open. Keyed by heading text because
 * that is what the pane renders and what `DenominationGroup.heading`
 * carries; the catch-all "No issuer yet" group therefore folds like any
 * other, which is the point — it is the biggest group on a database whose
 * denominations were never attributed.
 */
export interface GroupExpansion {
  readonly collapsedByDefault: boolean;
  readonly exceptions: ReadonlySet<string>;
}

/** What the pane opens with: every group open, exactly as it behaved before. */
export const ALL_GROUPS_EXPANDED: GroupExpansion = {
  collapsedByDefault: false,
  exceptions: new Set<string>(),
};

/** Every group folded away. The compact view of 70 issuers. */
export function collapseAllGroups(): GroupExpansion {
  return { collapsedByDefault: true, exceptions: new Set<string>() };
}

/** Every group open again. */
export function expandAllGroups(): GroupExpansion {
  return { collapsedByDefault: false, exceptions: new Set<string>() };
}

/**
 * One group open, every other group — present or not yet loaded — closed.
 *
 * THIS IS THE POST-ADD LANDING, AND IT IS A COLLAPSE, NOT A FILTER. The
 * issuer that was just created is the only one open, so the user lands on
 * it; the other 70 are still listed, still counted and one click from
 * opening. The bug being fixed is a view that showed the new issuer and
 * nothing else at all, with no control anywhere that would bring the rest
 * back.
 */
export function focusGroup(heading: string): GroupExpansion {
  return { collapsedByDefault: true, exceptions: new Set<string>([heading]) };
}

/** Is this group open? */
export function isGroupExpanded(state: GroupExpansion, heading: string): boolean {
  return state.exceptions.has(heading) ? state.collapsedByDefault : !state.collapsedByDefault;
}

/** Open it if it is closed, close it if it is open. */
export function toggleGroup(state: GroupExpansion, heading: string): GroupExpansion {
  const exceptions = new Set(state.exceptions);
  if (!exceptions.delete(heading)) exceptions.add(heading);
  return { collapsedByDefault: state.collapsedByDefault, exceptions };
}

/**
 * Make sure one group is open, leaving every other group as it was.
 *
 * Used after a row is added to a group: writing a denomination into a
 * folded group and leaving it folded reads as the Add button having done
 * nothing.
 */
export function expandGroup(state: GroupExpansion, heading: string): GroupExpansion {
  if (isGroupExpanded(state, heading)) return state;
  return toggleGroup(state, heading);
}

/** How many of these groups are open. */
export function expandedGroupCount(
  state: GroupExpansion,
  headings: readonly string[]
): number {
  return headings.reduce((count, heading) => count + (isGroupExpanded(state, heading) ? 1 : 0), 0);
}

/** What the one control does next, and what it should say while it waits. */
export interface ExpandAllControl {
  /** What pressing it does — the caller passes this straight back in. */
  readonly action: 'expand' | 'collapse';
  readonly label: string;
  /** The longer form, for `aria-label` and the tooltip. */
  readonly ariaLabel: string;
}

/**
 * ONE CONTROL, NOT TWO.
 *
 * Two buttons mean one of them is always a no-op, and on a list this long
 * the user cannot see which: "Collapse all" with everything already closed
 * looks broken rather than redundant. The control therefore reads the
 * current state and offers the half that would change something.
 *
 * ANYTHING OPEN MEANS COLLAPSE. Not "most of them" and not a majority
 * count: the reason to press this is to get a list of headings back, and
 * one group left open is enough to bury the headings below it.
 */
export function describeExpandAllControl(
  state: GroupExpansion,
  headings: readonly string[]
): ExpandAllControl {
  const open = expandedGroupCount(state, headings);
  const total = headings.length;

  if (open > 0) {
    return {
      action: 'collapse',
      label: 'Collapse all',
      ariaLabel: `Collapse all ${total} issuer group(s)`,
    };
  }

  return {
    action: 'expand',
    label: 'Expand all',
    ariaLabel: `Expand all ${total} issuer group(s)`,
  };
}

/** Apply the control. The whole of what the button's click handler does. */
export function applyExpandAllControl(action: 'expand' | 'collapse'): GroupExpansion {
  return action === 'collapse' ? collapseAllGroups() : expandAllGroups();
}
