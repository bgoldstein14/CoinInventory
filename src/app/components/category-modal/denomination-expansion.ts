/*
 * Expand/collapse state for the issuer groups on the Denominations pane.
 *
 * Stored as a default plus exceptions rather than a set of collapsed headings,
 * so "collapse all" also covers groups not on screen (filtered out by a search,
 * or added later). Plain data, so the component can persist it if needed.
 */

/**
 * Which groups are open. `exceptions` holds headings that differ from
 * `collapsedByDefault`; keyed by heading text, including "No issuer yet".
 */
export interface GroupExpansion {
  readonly collapsedByDefault: boolean;
  readonly exceptions: ReadonlySet<string>;
}

/** Initial state: every group open. */
export const ALL_GROUPS_EXPANDED: GroupExpansion = {
  collapsedByDefault: false,
  exceptions: new Set<string>(),
};

/** Every group folded away. */
export function collapseAllGroups(): GroupExpansion {
  return { collapsedByDefault: true, exceptions: new Set<string>() };
}

/** Every group open again. */
export function expandAllGroups(): GroupExpansion {
  return { collapsedByDefault: false, exceptions: new Set<string>() };
}

/**
 * One group open, every other group (present or not) closed. Used to land on
 * a newly added issuer; the others remain listed.
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
 * Make sure one group is open, leaving the others as they were. Used after
 * adding a row so the new row is visible.
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

/** What the expand/collapse-all control does next, and its labels. */
export interface ExpandAllControl {
  /** What pressing it does — the caller passes this straight back in. */
  readonly action: 'expand' | 'collapse';
  readonly label: string;
  /** The longer form, for `aria-label` and the tooltip. */
  readonly ariaLabel: string;
}

/**
 * A single expand/collapse-all control: it offers collapse while any group is
 * open and expand once all are closed, so pressing it always changes something.
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

/** Apply the control's action. */
export function applyExpandAllControl(action: 'expand' | 'collapse'): GroupExpansion {
  return action === 'collapse' ? collapseAllGroups() : expandAllGroups();
}
