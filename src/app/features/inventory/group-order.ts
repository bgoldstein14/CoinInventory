/*
 * group-order.ts — putting the group headings in the order the OWNER wants,
 * rather than the one the alphabet wants.
 *
 * THE DEFAULT IS STILL ALPHABETICAL, AND THAT IS NOT A DETAIL. grid-grouping.ts
 * orders groups by heading with the empty bucket pinned last, and on a sixty
 * country collection that is the only order anybody can look a country up in.
 * This module does not replace that order; it is applied AFTER it, to the list
 * it produced, and with no saved order it hands that list straight back
 * unchanged. The alphabet is what the user falls back to, which is why
 * `resetGroupOrder` has to exist: a custom order with no way out is a one-way
 * door, and the way out is "forget my order", not "sort it again".
 *
 * ------------------------------------------------------------------------
 * THE FOUR DECISIONS, AND WHY EACH ONE WENT THE WAY IT DID
 * ------------------------------------------------------------------------
 *
 * 1. WHAT HAPPENS TO A CUSTOM ORDER WHEN THE GROUPING COLUMN CHANGES.
 *
 *    An order of countries means nothing while the grid is grouped by Grade,
 *    so it must not be applied — but dropping it is destroying a minute of the
 *    user's dragging because he glanced at Grade and came back. Both of the
 *    obvious answers are wrong, so neither is taken: the order is stored PER
 *    COLUMN. `GroupOrders` is a map keyed by the grouping column, an order is
 *    only ever applied to the column it was built for, and switching to Grade
 *    shows plain A-Z while the Country order waits for the user to switch
 *    back. Nothing is lost and nothing incoherent is applied.
 *
 *    THE UI IS HONEST ABOUT IT because the "Reset order" control is bound to
 *    `hasCustomGroupOrder`, which asks about the CURRENT column: switch to
 *    Grade and the control disappears (there is no custom order here), switch
 *    back to Country and it returns (there is one, and here is how to undo
 *    it). The presence of the control is the statement.
 *
 * 2. A DRAGGED GROUP THAT A FILTER THEN HIDES, AND A GROUP THAT APPEARS LATER.
 *
 *    A saved order is a list of HEADINGS, not of positions, and the headings
 *    on screen change every time the user types in the search box. So:
 *
 *      * A placed group that is currently filtered out is SKIPPED, not
 *        forgotten. Its name stays in the saved list, so clearing the search
 *        puts it back exactly where it was dragged. Pruning it would mean a
 *        search for "mex" silently deleted the user's arrangement of the other
 *        fifty-nine countries' neighbours.
 *      * A group that was never placed — a country imported this morning, or
 *        one that a filter has only just revealed — is appended AFTER every
 *        placed group, keeping the alphabetical order among themselves. Not at
 *        the top (a brand-new heading jumping the queue in front of a
 *        hand-built list is the most annoying of the three options) and not
 *        slotted alphabetically into the middle (which is a guess about where
 *        the user would have dragged it, dressed up as a rule).
 *
 *    `mergeGroupOrder` is the invariant that makes both work: the order a move
 *    is computed against includes the hidden names in their saved slots, so a
 *    drag performed under a filter cannot evict a group the user cannot see.
 *
 * 3. THE EMPTY BUCKET CANNOT BE DRAGGED OUT OF LAST PLACE.
 *
 *    It is pinned deliberately (see compareGroups in grid-grouping.ts): "no
 *    value recorded" is not a value, and on an imported collection it is
 *    routinely the biggest group there is, so at the top it buries every real
 *    heading under a screenful of unattributed coins. A user can put it there
 *    with one careless drag and will not know what he did. So it is not a drag
 *    SOURCE (`isMovableGroup` is false, the template renders no draggable
 *    attribute and no grip), it is not a drop TARGET (dropping on it is a
 *    no-op rather than a move to the end), and the keyboard gesture refuses it
 *    for the same reason. It is also never written into a saved order, and a
 *    saved order naming it is ignored, because `applyGroupOrder` appends the
 *    pinned groups after everything else whatever the order says.
 *
 * 4. GETTING BACK TO ALPHABETICAL. `withoutGroupOrder` — the reset drops the
 *    order for the CURRENT column only, so resetting Country does not throw
 *    away the Grade order the user built last week.
 *
 * ------------------------------------------------------------------------
 * STALE STATE MUST DEGRADE, NOT THROW
 * ------------------------------------------------------------------------
 *
 * The saved order is JSON out of IndexedDB that an older build wrote, and
 * every heading in it is a string that may no longer name anything: countries
 * get renamed in a bulk edit, a denomination is deleted, the whole column is
 * dropped from the grid. `restoreGroupOrders` validates per column and per
 * entry, and `applyGroupOrder` skips a name it cannot find. The worst case is
 * the alphabet, never an exception and never a grid with rows missing. That is
 * the rule inventory-filter-persistence.ts already set and this matches it.
 *
 * NO DRAG-AND-DROP LIBRARY, AND THAT IS A BUDGET DECISION. The bundle work
 * just cut 938 kB to 563 kB with thirteen @defer blocks; @angular/cdk's
 * drag-drop entry point would hand a chunk of that straight back for one
 * gesture on one list. The template uses the platform's own HTML5 drag events
 * (draggable / dragstart / dragover / drop), which cost zero bytes and give
 * the drag image for free, and this module holds every decision they lead to
 * so that none of it lives in a handler the suite cannot reach.
 *
 * Pure, DOM-free and Angular-free: the frontend suite runs under Node with no
 * jsdom, so a rule decided inside a template or a drag handler is a rule with
 * no tests.
 */
import { InventoryColumn } from '../../types/inventory-columns';
import { isGroupableColumn } from './grid-grouping';

/**
 * The part of a `CoinGroup` this module reads.
 *
 * Structural rather than an import of `CoinGroup` so the reordering rules can
 * be tested with two-field literals instead of fabricated coins, and so a
 * group's counts and money cannot accidentally become part of an ordering
 * decision.
 */
export interface OrderableGroup {
  readonly label: string;
  readonly isEmptyBucket: boolean;
}

/**
 * Every custom order the user has built, keyed by the grouping column.
 *
 * Keyed by column because an order of countries is meaningless under any
 * other grouping — see decision 1 at the top of the file. A column with no
 * entry is a column in plain alphabetical order.
 */
export type GroupOrders = Readonly<Record<string, readonly string[]>>;

/** No custom order anywhere: what a fresh install has, and what anything
 *  unreadable degrades to. */
export const NO_GROUP_ORDERS: GroupOrders = Object.freeze({});

/** May this group be moved at all? Everything except the pinned empty
 *  bucket — see decision 3. */
export function isMovableGroup(group: OrderableGroup): boolean {
  return !group.isEmptyBucket;
}

/** The headings that take part in an order, in their current screen order. */
function movableLabels(groups: readonly OrderableGroup[]): string[] {
  return groups.filter(isMovableGroup).map(group => group.label);
}

/**
 * Is reordering worth offering at all?
 *
 * Two movable groups minimum. One group has nowhere to go, and a grip handle
 * plus a keyboard hint on a heading that cannot move is a control that lies.
 */
export function canReorderGroups(groups: readonly OrderableGroup[]): boolean {
  return movableLabels(groups).length > 1;
}

/**
 * Re-order the default (alphabetical) group list by a saved order.
 *
 * Placed groups first in the saved order, then the ones that order has never
 * heard of in the order they arrived in — which is alphabetical, because that
 * is what `buildCoinGroups` hands over — then the pinned empty bucket. A name
 * in the order that matches nothing on screen is skipped silently: it is a
 * group a filter is hiding, or one that no longer exists, and neither is an
 * error. See decisions 2 and 3.
 */
export function applyGroupOrder<T extends OrderableGroup>(
  groups: readonly T[],
  order: readonly string[] | null | undefined
): T[] {
  const pinned = groups.filter(group => !isMovableGroup(group));
  // A Map iterates in insertion order, so "whatever is left" comes out in the
  // alphabetical order it went in with.
  const movable = new Map<string, T>();
  for (const group of groups) if (isMovableGroup(group)) movable.set(group.label, group);

  if (!order || order.length === 0) return [...movable.values(), ...pinned];

  const placed: T[] = [];
  for (const label of order) {
    const group = movable.get(label);
    if (!group) continue;
    movable.delete(label);
    placed.push(group);
  }

  return [...placed, ...movable.values(), ...pinned];
}

/**
 * The authoritative order a move is computed against: the saved order, plus
 * every visible group it does not yet name, appended.
 *
 * THE HIDDEN NAMES ARE THE POINT. A move computed against only what is on
 * screen would rewrite the saved order as "the six countries the search box
 * left visible", quietly evicting the other fifty-four. Splicing inside this
 * merged list instead means a drag performed under a filter moves one group
 * and leaves every hidden one in its slot.
 *
 * The visible members of this list, in this list's order, are exactly what
 * `applyGroupOrder` renders — which is what lets a move be expressed as
 * "put it next to the heading the user dropped it on".
 */
export function mergeGroupOrder(
  visibleLabels: readonly string[],
  order: readonly string[] | null | undefined
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const label of order ?? []) {
    if (typeof label !== 'string' || seen.has(label)) continue;
    seen.add(label);
    merged.push(label);
  }
  for (const label of visibleLabels) {
    if (seen.has(label)) continue;
    seen.add(label);
    merged.push(label);
  }

  return merged;
}

/** A move that is going to happen: the new order, and what to say out loud. */
export interface GroupMove {
  /** The new saved order for this column, hidden groups included. */
  readonly order: string[];
  /** The heading that moved. */
  readonly label: string;
  /** Where it landed, 0-based, among the groups the user can SEE. */
  readonly index: number;
  /** How many groups the user can see. */
  readonly total: number;
}

/** Splice `label` in next to `anchor` inside the merged order. */
function placeBeside(
  visibleLabels: readonly string[],
  order: readonly string[] | null | undefined,
  label: string,
  anchor: string,
  position: 'before' | 'after'
): GroupMove {
  const next = mergeGroupOrder(visibleLabels, order).filter(entry => entry !== label);
  const anchorIndex = next.indexOf(anchor);
  next.splice(position === 'after' ? anchorIndex + 1 : anchorIndex, 0, label);

  // The announced position is READ BACK off the result rather than worked out
  // from the arithmetic above: hidden groups sit in this list too, and the
  // only number worth announcing is the one the user can count on screen.
  const visible = new Set(visibleLabels);
  const index = next.filter(entry => visible.has(entry)).indexOf(label);

  return { order: next, label, index, total: visibleLabels.length };
}

/**
 * THE KEYBOARD MOVE: one place up or down the list of headings the user can
 * see, skipping nothing and wrapping nowhere.
 *
 * Null when there is nothing to do — the heading is the empty bucket, is not
 * on screen, or is already at the end it is being pushed towards. A null is
 * what stops the grid announcing "moved to position 1 of 7" for a key press
 * that moved nothing.
 */
export function moveGroupByStep(
  groups: readonly OrderableGroup[],
  order: readonly string[] | null | undefined,
  label: string,
  delta: -1 | 1
): GroupMove | null {
  const visible = movableLabels(groups);
  const from = visible.indexOf(label);
  if (from < 0) return null;

  const to = from + delta;
  if (to < 0 || to >= visible.length) return null;

  return placeBeside(visible, order, label, visible[to], delta > 0 ? 'after' : 'before');
}

/**
 * THE DRAG MOVE: the dragged heading takes the dropped-on heading's place.
 *
 * Dragging DOWN the list lands after the target and dragging UP lands before
 * it, which is what every list that can be dragged does: the group ends up
 * where the pointer let go, not one slot past it.
 *
 * Null for a drop that cannot mean anything: onto itself, onto the pinned
 * empty bucket, or onto a heading that is not on screen. A refused drop leaves
 * the order exactly as it was — see decision 3.
 */
export function moveGroupToTarget(
  groups: readonly OrderableGroup[],
  order: readonly string[] | null | undefined,
  dragged: string,
  target: string
): GroupMove | null {
  if (dragged === target) return null;

  const visible = movableLabels(groups);
  const from = visible.indexOf(dragged);
  const onto = visible.indexOf(target);
  if (from < 0 || onto < 0) return null;

  return placeBeside(visible, order, dragged, target, onto > from ? 'after' : 'before');
}

/**
 * What the live region says after a move.
 *
 * A POSITION, NOT A DIRECTION. "Moved up" is useless after the third press —
 * the user needs to know where the group has got to, and "3 of 12" is the one
 * fact a screen reader cannot work out from a grid whose rows just shuffled.
 */
export function describeGroupMove(move: GroupMove): string {
  return `${move.label} moved to position ${move.index + 1} of ${move.total}`;
}

/** What the live region says when the custom order is thrown away. */
export function describeGroupOrderReset(columnLabel: string): string {
  return `${columnLabel} groups back in alphabetical order`;
}

/** Record an order for one column, leaving every other column's alone. */
export function withGroupOrder(
  orders: GroupOrders,
  column: InventoryColumn,
  order: readonly string[]
): GroupOrders {
  return { ...orders, [column]: [...order] };
}

/** Forget one column's order — the reset. The others survive it. */
export function withoutGroupOrder(orders: GroupOrders, column: InventoryColumn): GroupOrders {
  if (!(column in orders)) return orders;
  const next = { ...orders };
  delete next[column];
  return next;
}

/** Is there a custom order in force for this column right now? The one
 *  question the "Reset order" control is bound to. */
export function hasGroupOrder(orders: GroupOrders, column: string | null | undefined): boolean {
  if (!column) return false;
  return (orders[column]?.length ?? 0) > 0;
}

/**
 * The orders as they go into storage: a plain object of plain string arrays,
 * so the structured clone IndexedDB performs cannot trip over anything.
 *
 * Empty orders are dropped rather than written as `[]`. A column the user has
 * reset is a column with no custom order, and the saved blob should say so
 * rather than carry a growing list of empty arrays for every column he has
 * ever looked at.
 */
export function serializeGroupOrders(orders: GroupOrders): Record<string, string[]> {
  const stored: Record<string, string[]> = {};
  for (const [column, labels] of Object.entries(orders)) {
    if (!isGroupableColumn(column) || !labels || labels.length === 0) continue;
    stored[column] = [...labels];
  }
  return stored;
}

/**
 * Read the saved orders back out of the stored grouping blob, DEGRADING
 * RATHER THAN THROWING.
 *
 * Takes the whole stored object, not its `orders` field, so that this module
 * owns that sub-document end to end and `restoreGrouping` does not have to
 * know it exists.
 *
 * Nothing is trusted. A column key that is not groupable today — `source`,
 * dropped from the grid, or a price somebody hand-edited in — is dropped
 * whole, because an order for a column nobody can group by can never be
 * applied and would sit in storage forever. Inside a column, anything that is
 * not a non-empty string is dropped, and a repeated heading is kept once: a
 * duplicate would otherwise be placed twice by `applyGroupOrder` and the
 * second copy would silently win.
 *
 * Headings that no longer match any group are KEPT, deliberately. There is no
 * way to tell "deleted" from "a filter is hiding it" at restore time — the
 * coins have not even been fetched yet — and `applyGroupOrder` skips a name it
 * cannot find, so a stale name costs nothing and a prune would cost the user
 * his arrangement every time he saved while a search was running.
 */
export function restoreGroupOrders(stored: unknown): GroupOrders {
  if (!stored || typeof stored !== 'object') return NO_GROUP_ORDERS;

  const raw = (stored as { orders?: unknown }).orders;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_GROUP_ORDERS;

  const orders: Record<string, readonly string[]> = {};
  for (const [column, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isGroupableColumn(column) || !Array.isArray(value)) continue;

    const labels: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue;
      seen.add(entry);
      labels.push(entry);
    }

    if (labels.length > 0) orders[column] = labels;
  }

  return orders;
}

/* =======================================================================
 * THE KEYBOARD GESTURE
 *
 * The grid gained full keyboard operation this week — arrows, Enter/Space, a
 * roving tabindex (grid-keyboard.ts) — and a reordering that only a mouse can
 * reach would be the one thing in the grid a keyboard user cannot do.
 *
 * ALT + ARROW UP / ALT + ARROW DOWN on the focused group heading.
 *
 *   * The heading is already a real <button>, so Tab reaches it with no work.
 *   * Plain Up/Down cannot be used: grid-keyboard.ts deliberately returns "not
 *     ours" for a key pressed on a BUTTON, and binding the bare arrows here
 *     would fight the page scroll and the grid's own row movement.
 *   * Alt+Arrow is the move-this-thing convention users already have from
 *     editors and mail clients, and unlike Alt+Left/Right (browser history) it
 *     is not spoken for.
 *   * It is DISCOVERABLE rather than folklore: the heading carries
 *     `aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"`, a title that says it in
 *     words, and the toolbar prints the hint next to the Group by menu.
 *
 * Any other modifier combination is refused rather than treated as a loose
 * Alt+Arrow. Alt+Shift+Arrow and Ctrl+Alt+Arrow belong to the browser and the
 * operating system (screen rotation, on some machines), and swallowing them
 * here would be taking a key that was not pressed at this grid.
 * ======================================================================= */

/** What a key press on a group heading turns out to mean. */
export type GroupHeadingKeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'move'; readonly delta: -1 | 1 };

const NO_HEADING_ACTION: GroupHeadingKeyAction = { kind: 'none' };

/** The parts of a KeyboardEvent this module reads. A plain object satisfies
 *  it, which is what makes the gesture testable with no DOM at all. */
export interface GroupHeadingKeyEvent {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  preventDefault?(): void;
}

/** What this key press means on a group heading. */
export function groupHeadingKeyAction(event: GroupHeadingKeyEvent): GroupHeadingKeyAction {
  if (!event.altKey) return NO_HEADING_ACTION;
  if (event.ctrlKey || event.metaKey || event.shiftKey) return NO_HEADING_ACTION;

  if (event.key === 'ArrowUp') return { kind: 'move', delta: -1 };
  if (event.key === 'ArrowDown') return { kind: 'move', delta: 1 };
  return NO_HEADING_ACTION;
}

/**
 * Run a key press against the gesture and do what it says.
 *
 * `preventDefault()` for ours and only ours: Alt+Arrow scrolls in some
 * browsers, and a list that reorders while the page scrolls under it loses the
 * heading the user was watching. Returns the action so a test can assert the
 * decision and the effect together.
 */
export function handleGroupHeadingKey(
  event: GroupHeadingKeyEvent,
  handlers: { move(delta: -1 | 1): void }
): GroupHeadingKeyAction {
  const action = groupHeadingKeyAction(event);
  if (action.kind === 'none') return action;

  event.preventDefault?.();
  handlers.move(action.delta);
  return action;
}
