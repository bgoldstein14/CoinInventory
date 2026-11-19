// User-defined group heading order. The DECISION blocks follow the rules
// listed at the top of group-order.ts.
import { describe, expect, it, vi } from 'vitest';
import {
  GroupOrders,
  NO_GROUP_ORDERS,
  applyGroupOrder,
  canReorderGroups,
  describeGroupMove,
  describeGroupOrderReset,
  groupHeadingKeyAction,
  handleGroupHeadingKey,
  hasGroupOrder,
  isMovableGroup,
  mergeGroupOrder,
  moveGroupByStep,
  moveGroupToTarget,
  restoreGroupOrders,
  serializeGroupOrders,
  withGroupOrder,
  withoutGroupOrder
} from './group-order';

/** A group list in the default (alphabetical) order the grid produces. */
function groups(...labels: string[]) {
  return labels.map(label => ({ label, isEmptyBucket: false }));
}

/** The same, with the pinned "no value recorded" bucket on the end. */
function groupsWithEmptyBucket(...labels: string[]) {
  return [...groups(...labels), { label: '(No Country)', isEmptyBucket: true }];
}

const labelsOf = (list: ReadonlyArray<{ label: string }>) => list.map(group => group.label);

describe('with no custom order, the alphabet is left exactly as it was', () => {
  it('hands the default list straight back', () => {
    const list = groups('France', 'Germany', 'Mexico');
    expect(labelsOf(applyGroupOrder(list, undefined))).toEqual(['France', 'Germany', 'Mexico']);
    expect(labelsOf(applyGroupOrder(list, []))).toEqual(['France', 'Germany', 'Mexico']);
  });

  it('leaves the empty bucket pinned last, which is where grid-grouping put it', () => {
    const list = groupsWithEmptyBucket('France', 'Mexico');
    expect(labelsOf(applyGroupOrder(list, null)))
      .toEqual(['France', 'Mexico', '(No Country)']);
  });
});

describe('a dragged order overrides the alphabet', () => {
  it('puts the groups in the saved order', () => {
    const list = groups('France', 'Germany', 'Mexico');
    expect(labelsOf(applyGroupOrder(list, ['Mexico', 'France', 'Germany'])))
      .toEqual(['Mexico', 'France', 'Germany']);
  });

  it('moves a group to the top — the owner\'s actual words', () => {
    const list = groups('France', 'Germany', 'Mexico');
    const move = moveGroupToTarget(list, undefined, 'Mexico', 'France');

    expect(move).not.toBeNull();
    expect(labelsOf(applyGroupOrder(list, move!.order)))
      .toEqual(['Mexico', 'France', 'Germany']);
  });

  it('drops a group below the one it was dragged onto when it is dragged DOWN', () => {
    const list = groups('France', 'Germany', 'Mexico');
    const move = moveGroupToTarget(list, undefined, 'France', 'Mexico');

    expect(labelsOf(applyGroupOrder(list, move!.order)))
      .toEqual(['Germany', 'Mexico', 'France']);
  });

  it('refuses a drop on itself, which would otherwise announce a move that never happened', () => {
    expect(moveGroupToTarget(groups('France', 'Mexico'), undefined, 'France', 'France')).toBeNull();
  });

  it('refuses a drop on a heading that is not on screen', () => {
    expect(moveGroupToTarget(groups('France', 'Mexico'), undefined, 'France', 'Peru')).toBeNull();
  });
});

describe('DECISION 1 — an order belongs to the column it was built for', () => {
  it('keeps one order per column, so switching grouping loses nothing', () => {
    let orders: GroupOrders = NO_GROUP_ORDERS;
    orders = withGroupOrder(orders, 'country', ['Mexico', 'France']);
    orders = withGroupOrder(orders, 'grade', ['MS-65', 'MS-63']);

    expect(orders['country']).toEqual(['Mexico', 'France']);
    expect(orders['grade']).toEqual(['MS-65', 'MS-63']);
  });

  it('answers "is there a custom order HERE" per column — what the Reset control is bound to', () => {
    const orders = withGroupOrder(NO_GROUP_ORDERS, 'country', ['Mexico']);

    expect(hasGroupOrder(orders, 'country')).toBe(true);
    expect(hasGroupOrder(orders, 'grade')).toBe(false);
    expect(hasGroupOrder(orders, null)).toBe(false);
  });

  it('does not mutate the orders it is given', () => {
    const orders = withGroupOrder(NO_GROUP_ORDERS, 'country', ['Mexico']);
    const next = withGroupOrder(orders, 'grade', ['MS-65']);

    expect(Object.keys(orders)).toEqual(['country']);
    expect(Object.keys(next).sort()).toEqual(['country', 'grade']);
  });
});

describe('DECISION 2 — groups a filter hides, and groups that turn up later', () => {
  it('skips a placed group that is currently filtered out', () => {
    const visible = groups('France', 'Mexico');
    expect(labelsOf(applyGroupOrder(visible, ['Mexico', 'Peru', 'France'])))
      .toEqual(['Mexico', 'France']);
  });

  it('puts it back where it was dragged once the filter is cleared', () => {
    const all = groups('France', 'Mexico', 'Peru');
    expect(labelsOf(applyGroupOrder(all, ['Mexico', 'Peru', 'France'])))
      .toEqual(['Mexico', 'Peru', 'France']);
  });

  it('does NOT evict a hidden group when a move is made while it is hidden', () => {
    // Peru is hidden by a filter; the move must keep its saved slot.
    const saved = ['Mexico', 'Peru', 'France'];
    const visible = groups('France', 'Mexico');
    const move = moveGroupToTarget(visible, saved, 'France', 'Mexico');

    expect(move!.order).toContain('Peru');
    expect(labelsOf(applyGroupOrder(groups('France', 'Mexico', 'Peru'), move!.order)))
      .toEqual(['Mexico', 'France', 'Peru']);
  });

  it('appends a group nobody has placed AFTER the placed ones, not at the top', () => {
    // Canada has never been placed.
    const list = groups('Canada', 'France', 'Mexico');
    expect(labelsOf(applyGroupOrder(list, ['Mexico', 'France'])))
      .toEqual(['Mexico', 'France', 'Canada']);
  });

  it('keeps the unplaced ones alphabetical among themselves', () => {
    const list = groups('Austria', 'Canada', 'France', 'Mexico');
    expect(labelsOf(applyGroupOrder(list, ['Mexico'])))
      .toEqual(['Mexico', 'Austria', 'Canada', 'France']);
  });

  it('merges the saved order and the visible headings into one authoritative list', () => {
    expect(mergeGroupOrder(['France', 'Mexico'], ['Mexico', 'Peru']))
      .toEqual(['Mexico', 'Peru', 'France']);
  });

  it('places a duplicated heading once', () => {
    const list = groups('France', 'Mexico');
    expect(labelsOf(applyGroupOrder(list, ['Mexico', 'Mexico', 'France'])))
      .toEqual(['Mexico', 'France']);
  });
});

describe('DECISION 3 — the empty bucket stays last', () => {
  it('is not movable', () => {
    expect(isMovableGroup({ label: '(No Country)', isEmptyBucket: true })).toBe(false);
    expect(isMovableGroup({ label: 'Mexico', isEmptyBucket: false })).toBe(true);
  });

  it('cannot be dragged anywhere, even onto the first heading', () => {
    const list = groupsWithEmptyBucket('France', 'Mexico');
    expect(moveGroupToTarget(list, undefined, '(No Country)', 'France')).toBeNull();
  });

  it('cannot be moved by the keyboard either', () => {
    const list = groupsWithEmptyBucket('France', 'Mexico');
    expect(moveGroupByStep(list, undefined, '(No Country)', -1)).toBeNull();
  });

  it('is not a drop target — a group dropped on it does not go to the end', () => {
    const list = groupsWithEmptyBucket('France', 'Mexico');
    expect(moveGroupToTarget(list, undefined, 'France', '(No Country)')).toBeNull();
  });

  it('stays last even when a saved order names it first', () => {
    const list = groupsWithEmptyBucket('France', 'Mexico');
    expect(labelsOf(applyGroupOrder(list, ['(No Country)', 'Mexico', 'France'])))
      .toEqual(['Mexico', 'France', '(No Country)']);
  });

  it('is never counted as something to reorder', () => {
    expect(canReorderGroups(groupsWithEmptyBucket('France'))).toBe(false);
    expect(canReorderGroups(groupsWithEmptyBucket('France', 'Mexico'))).toBe(true);
    expect(canReorderGroups(groups('France'))).toBe(false);
  });
});

describe('DECISION 4 — the way back to alphabetical', () => {
  it('drops the order for one column and keeps the others', () => {
    let orders: GroupOrders = NO_GROUP_ORDERS;
    orders = withGroupOrder(orders, 'country', ['Mexico']);
    orders = withGroupOrder(orders, 'grade', ['MS-65']);

    const reset = withoutGroupOrder(orders, 'country');

    expect(hasGroupOrder(reset, 'country')).toBe(false);
    expect(hasGroupOrder(reset, 'grade')).toBe(true);
  });

  it('is a no-op for a column that was never arranged', () => {
    const orders = withGroupOrder(NO_GROUP_ORDERS, 'country', ['Mexico']);
    expect(withoutGroupOrder(orders, 'grade')).toBe(orders);
  });

  it('says what it did', () => {
    expect(describeGroupOrderReset('Country')).toBe('Country groups back in alphabetical order');
  });
});

describe('the keyboard move', () => {
  it('moves a heading up one place', () => {
    const list = groups('France', 'Germany', 'Mexico');
    const move = moveGroupByStep(list, undefined, 'Mexico', -1);

    expect(labelsOf(applyGroupOrder(list, move!.order)))
      .toEqual(['France', 'Mexico', 'Germany']);
  });

  it('moves a heading down one place', () => {
    const list = groups('France', 'Germany', 'Mexico');
    const move = moveGroupByStep(list, undefined, 'France', 1);

    expect(labelsOf(applyGroupOrder(list, move!.order)))
      .toEqual(['Germany', 'France', 'Mexico']);
  });

  it('reaches the top in as many presses as there are places, and stops there', () => {
    // Each press is computed against the re-ordered list, as the store does.
    const list = groups('Austria', 'France', 'Mexico');
    let order: readonly string[] | undefined = undefined;
    let presses = 0;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const move = moveGroupByStep(applyGroupOrder(list, order), order, 'Mexico', -1);
      if (!move) break;
      order = move.order;
      presses += 1;
    }

    expect(presses).toBe(2);
    expect(labelsOf(applyGroupOrder(list, order))).toEqual(['Mexico', 'Austria', 'France']);
  });

  it('returns null at the end rather than announcing a move that did not happen', () => {
    const list = groups('France', 'Mexico');
    expect(moveGroupByStep(list, undefined, 'France', -1)).toBeNull();
    expect(moveGroupByStep(list, undefined, 'Mexico', 1)).toBeNull();
  });

  it('steps over a group a filter is hiding, because the user cannot see it', () => {
    const list = groups('France', 'Mexico');
    const move = moveGroupByStep(list, ['France', 'Peru', 'Mexico'], 'Mexico', -1);

    expect(labelsOf(applyGroupOrder(list, move!.order))).toEqual(['Mexico', 'France']);
    expect(move!.order).toContain('Peru');
  });

  it('announces the POSITION, which is the thing a screen reader cannot see', () => {
    const list = groups('France', 'Germany', 'Mexico');
    const move = moveGroupByStep(list, undefined, 'Mexico', -1)!;

    expect(describeGroupMove(move)).toBe('Mexico moved to position 2 of 3');
  });
});

describe('the Alt+Arrow gesture', () => {
  it('moves on Alt+ArrowUp and Alt+ArrowDown', () => {
    expect(groupHeadingKeyAction({ key: 'ArrowUp', altKey: true })).toEqual({ kind: 'move', delta: -1 });
    expect(groupHeadingKeyAction({ key: 'ArrowDown', altKey: true })).toEqual({ kind: 'move', delta: 1 });
  });

  it('leaves the bare arrows alone — they are the grid\'s, and the page\'s', () => {
    expect(groupHeadingKeyAction({ key: 'ArrowUp' }).kind).toBe('none');
    expect(groupHeadingKeyAction({ key: 'ArrowDown', altKey: false }).kind).toBe('none');
  });

  it('leaves Enter and Space alone, so the heading still opens its group', () => {
    for (const key of ['Enter', ' ', 'Spacebar']) {
      expect(groupHeadingKeyAction({ key, altKey: true }).kind).toBe('none');
      expect(groupHeadingKeyAction({ key }).kind).toBe('none');
    }
  });

  it('refuses the combinations that belong to the browser and the OS', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey']) {
      expect(groupHeadingKeyAction({ key: 'ArrowUp', altKey: true, [modifier]: true }).kind)
        .toBe('none');
    }
  });

  it('swallows the key it acts on, and only that one', () => {
    const ours = { key: 'ArrowDown', altKey: true, preventDefault: vi.fn() };
    const move = vi.fn();
    expect(handleGroupHeadingKey(ours, { move }).kind).toBe('move');
    expect(ours.preventDefault).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledWith(1);

    const theirs = { key: 'ArrowDown', preventDefault: vi.fn() };
    expect(handleGroupHeadingKey(theirs, { move }).kind).toBe('none');
    expect(theirs.preventDefault).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledOnce();
  });
});

describe('remembering an order, and surviving what was remembered', () => {
  it('round-trips through the stored grouping blob', () => {
    const orders = withGroupOrder(NO_GROUP_ORDERS, 'country', ['Mexico', 'France']);
    const stored = { column: 'country', collapsedByDefault: true, exceptions: [], orders: serializeGroupOrders(orders) };

    expect(restoreGroupOrders(stored)).toEqual({ country: ['Mexico', 'France'] });
  });

  it('writes plain arrays, so the structured clone IndexedDB performs cannot trip', () => {
    const stored = serializeGroupOrders(withGroupOrder(NO_GROUP_ORDERS, 'country', ['Mexico']));
    expect(Array.isArray(stored['country'])).toBe(true);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
  });

  it('does not write an emptied order back as []', () => {
    expect(serializeGroupOrders({ country: [] })).toEqual({});
  });

  it('drops an order for a column that can no longer be grouped by', () => {
    // `source` is not a grid column; `currentValue` is numeric.
    expect(restoreGroupOrders({ orders: { source: ['eBay'], currentValue: ['10'] } }))
      .toEqual({});
    expect(serializeGroupOrders({ source: ['eBay'] })).toEqual({});
  });

  it('KEEPS a heading that no longer names any group — and that must not throw or empty the grid', () => {
    const restored = restoreGroupOrders({ orders: { country: ['Atlantis', 'Mexico'] } });
    expect(restored['country']).toEqual(['Atlantis', 'Mexico']);

    const list = groups('France', 'Mexico');
    expect(() => applyGroupOrder(list, restored['country'])).not.toThrow();
    expect(labelsOf(applyGroupOrder(list, restored['country']))).toEqual(['Mexico', 'France']);
  });

  it('never loses a group to a saved order, however little of it still matches', () => {
    const list = groupsWithEmptyBucket('France', 'Mexico', 'Peru');
    for (const order of [['Atlantis'], ['Atlantis', 'Narnia'], [], ['Mexico']]) {
      expect(labelsOf(applyGroupOrder(list, order)).sort())
        .toEqual(['(No Country)', 'France', 'Mexico', 'Peru']);
    }
  });

  it('keeps only the non-empty strings out of a mixed array', () => {
    expect(restoreGroupOrders({ orders: { country: ['Mexico', 7, null, '', 'Mexico', 'France'] } }))
      .toEqual({ country: ['Mexico', 'France'] });
  });

  it('degrades anything unreadable at all to no custom order, without throwing', () => {
    for (const junk of [null, undefined, 'country', 42, [], {}, { orders: null }, { orders: 'x' },
      { orders: ['Mexico'] }, { orders: { country: 'Mexico' } }, { orders: { country: [] } }]) {
      expect(() => restoreGroupOrders(junk)).not.toThrow();
      expect(restoreGroupOrders(junk)).toEqual({});
    }
  });
});
