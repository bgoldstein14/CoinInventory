/*
 * denomination-expansion.spec.ts — the Denominations pane's fold state.
 *
 * Two things are pinned here and they are the two that were actually wrong
 * on screen:
 *
 *   1. "Collapse all" means ALL — including groups that were filtered out
 *      by a search, and including an issuer created after the button was
 *      pressed. A model that remembers "the headings I folded" cannot do
 *      that, which is why the state is a default plus exceptions.
 *   2. Landing on a newly added issuer is a COLLAPSE of the others, never a
 *      filter: `focusGroup` names exactly one heading and says nothing
 *      about which groups exist, so no group can be removed from the list
 *      by it.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_GROUPS_EXPANDED,
  GroupExpansion,
  applyExpandAllControl,
  collapseAllGroups,
  describeExpandAllControl,
  expandAllGroups,
  expandGroup,
  expandedGroupCount,
  focusGroup,
  isGroupExpanded,
  toggleGroup,
} from './denomination-expansion';

/** A handful of the 70 the real pane carries, in the order it shows them. */
const HEADINGS = ['Austria', 'Burma', 'Mexico', 'No issuer yet'];

describe('the pane opens with everything expanded', () => {
  it('leaves every group open, exactly as the pane behaved before', () => {
    for (const heading of HEADINGS) {
      expect(isGroupExpanded(ALL_GROUPS_EXPANDED, heading)).toBe(true);
    }
  });

  it('says a group nobody has ever named is open too', () => {
    expect(isGroupExpanded(ALL_GROUPS_EXPANDED, 'Siam')).toBe(true);
  });
});

describe('collapseAllGroups — the control that makes 70 issuers scannable', () => {
  it('folds every group away', () => {
    const state = collapseAllGroups();
    for (const heading of HEADINGS) {
      expect(isGroupExpanded(state, heading)).toBe(false);
    }
  });

  it('folds a group that was NOT on screen when it was pressed', () => {
    /* THE HOLE A SET OF COLLAPSED HEADINGS WOULD HAVE. Press Collapse all
     * while a search is narrowing the pane to two issuers, then clear the
     * search: the sixty groups that were filtered out were never named, and
     * with a denylist they would spring open again. */
    const state = collapseAllGroups();
    expect(isGroupExpanded(state, 'An issuer the search was hiding')).toBe(false);
  });

  it('folds an issuer created after it was pressed', () => {
    const state = collapseAllGroups();
    expect(isGroupExpanded(state, 'Siam')).toBe(false);
  });
});

describe('expandAllGroups', () => {
  it('opens everything again, including groups closed one at a time', () => {
    let state: GroupExpansion = toggleGroup(ALL_GROUPS_EXPANDED, 'Mexico');
    state = toggleGroup(state, 'Austria');
    expect(isGroupExpanded(state, 'Mexico')).toBe(false);

    state = expandAllGroups();
    for (const heading of HEADINGS) {
      expect(isGroupExpanded(state, heading)).toBe(true);
    }
  });
});

describe('focusGroup — landing on the issuer that was just added', () => {
  it('opens the named group and closes every other one', () => {
    const state = focusGroup('Siam');

    expect(isGroupExpanded(state, 'Siam')).toBe(true);
    for (const heading of HEADINGS) {
      expect(isGroupExpanded(state, heading)).toBe(false);
    }
  });

  it('names ONE heading and nothing else, so it cannot hide a group', () => {
    /* The bug this replaces showed the new issuer and no route to any
     * other. Expansion state has to be incapable of expressing "these are
     * the only issuers that exist", so the whole value is a flag plus the
     * single heading to keep open. */
    const state = focusGroup('Siam');
    expect([...state.exceptions]).toEqual(['Siam']);
    expect(state.collapsedByDefault).toBe(true);
  });

  it('leaves every other issuer one click from being opened', () => {
    const state = toggleGroup(focusGroup('Siam'), 'Mexico');

    expect(isGroupExpanded(state, 'Mexico')).toBe(true);
    expect(isGroupExpanded(state, 'Siam')).toBe(true);
    expect(isGroupExpanded(state, 'Austria')).toBe(false);
  });
});

describe('toggleGroup', () => {
  it('closes an open group and opens it again', () => {
    const closed = toggleGroup(ALL_GROUPS_EXPANDED, 'Mexico');
    expect(isGroupExpanded(closed, 'Mexico')).toBe(false);

    const reopened = toggleGroup(closed, 'Mexico');
    expect(isGroupExpanded(reopened, 'Mexico')).toBe(true);
  });

  it('works the same way when everything starts collapsed', () => {
    const opened = toggleGroup(collapseAllGroups(), 'Mexico');
    expect(isGroupExpanded(opened, 'Mexico')).toBe(true);
    expect(isGroupExpanded(opened, 'Austria')).toBe(false);
  });

  it('does not touch the state it was given', () => {
    // The caller holds this in a signal that the template reads. Mutating
    // it in place is a render that does not happen.
    const before = collapseAllGroups();
    const sizeBefore = before.exceptions.size;

    toggleGroup(before, 'Mexico');

    expect(before.exceptions.size).toBe(sizeBefore);
    expect(isGroupExpanded(before, 'Mexico')).toBe(false);
  });
});

describe('expandGroup — make sure the row just added is visible', () => {
  it('opens a closed group', () => {
    const state = expandGroup(collapseAllGroups(), 'Mexico');
    expect(isGroupExpanded(state, 'Mexico')).toBe(true);
  });

  it('leaves an already open group alone, value and identity', () => {
    const before = ALL_GROUPS_EXPANDED;
    expect(expandGroup(before, 'Mexico')).toBe(before);
  });

  it('does not open anything else', () => {
    const state = expandGroup(collapseAllGroups(), 'Mexico');
    expect(isGroupExpanded(state, 'Austria')).toBe(false);
  });
});

describe('expandedGroupCount', () => {
  it('counts the open ones among the groups on screen', () => {
    expect(expandedGroupCount(ALL_GROUPS_EXPANDED, HEADINGS)).toBe(HEADINGS.length);
    expect(expandedGroupCount(collapseAllGroups(), HEADINGS)).toBe(0);
    expect(expandedGroupCount(focusGroup('Mexico'), HEADINGS)).toBe(1);
  });

  it('counts nothing when there are no groups', () => {
    expect(expandedGroupCount(ALL_GROUPS_EXPANDED, [])).toBe(0);
  });
});

describe('describeExpandAllControl — one control, never a no-op', () => {
  it('offers to collapse while everything is open', () => {
    const control = describeExpandAllControl(ALL_GROUPS_EXPANDED, HEADINGS);
    expect(control.action).toBe('collapse');
    expect(control.label).toBe('Collapse all');
    expect(control.ariaLabel).toContain('4');
  });

  it('offers to expand once everything is closed', () => {
    const control = describeExpandAllControl(collapseAllGroups(), HEADINGS);
    expect(control.action).toBe('expand');
    expect(control.label).toBe('Expand all');
  });

  it('still offers to collapse when only ONE group is left open', () => {
    // One open group is enough to bury every heading below it, which is the
    // whole reason the control exists. A majority rule would read as the
    // button doing the wrong thing at exactly the moment it matters.
    const control = describeExpandAllControl(focusGroup('Mexico'), HEADINGS);
    expect(control.action).toBe('collapse');
  });

  it('offers to expand when there are no groups at all', () => {
    expect(describeExpandAllControl(ALL_GROUPS_EXPANDED, []).action).toBe('expand');
  });
});

describe('applyExpandAllControl', () => {
  it('collapses everything, including groups it was never told about', () => {
    const state = applyExpandAllControl('collapse');
    expect(isGroupExpanded(state, 'Anything At All')).toBe(false);
  });

  it('expands everything', () => {
    const state = applyExpandAllControl('expand');
    expect(isGroupExpanded(state, 'Anything At All')).toBe(true);
  });

  it('round-trips through the description, which is how the button uses it', () => {
    let state: GroupExpansion = ALL_GROUPS_EXPANDED;

    state = applyExpandAllControl(describeExpandAllControl(state, HEADINGS).action);
    expect(expandedGroupCount(state, HEADINGS)).toBe(0);

    state = applyExpandAllControl(describeExpandAllControl(state, HEADINGS).action);
    expect(expandedGroupCount(state, HEADINGS)).toBe(HEADINGS.length);
  });
});
