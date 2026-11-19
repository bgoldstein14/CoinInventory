/*
 * group-order.ts — user-defined ordering of group headings.
 *
 * Applied after the default alphabetical order from grid-grouping.ts; with no
 * saved order the list is returned unchanged.
 *
 * - Orders are stored per grouping column and only applied to that column.
 * - A saved order is a list of headings. Placed groups hidden by a filter are
 *   skipped but kept in the saved list; groups never placed are appended
 *   after the placed ones, alphabetically.
 * - The empty bucket is pinned last: it can't be dragged, dropped on, moved by
 *   keyboard, or saved in an order.
 * - Reset clears the order for the current column only.
 *
 * Stored state is validated on restore and never throws; unknown names are
 * skipped. Drag uses native HTML5 drag events (no CDK drag-drop, to keep the
 * bundle small). Pure and DOM-free so it can be tested under Node.
 */
import { InventoryColumn } from '../../types/inventory-columns';
import { isGroupableColumn } from './grid-grouping';

/** The part of a `CoinGroup` this module reads; structural so tests can use plain literals. */
export interface OrderableGroup {
  readonly label: string;
  readonly isEmptyBucket: boolean;
}

/** Custom orders keyed by grouping column. A missing column means alphabetical. */
export type GroupOrders = Readonly<Record<string, readonly string[]>>;

/** No custom orders. Fallback for missing or unreadable state. */
export const NO_GROUP_ORDERS: GroupOrders = Object.freeze({});

/** Every group except the pinned empty bucket can be moved. */
export function isMovableGroup(group: OrderableGroup): boolean {
  return !group.isEmptyBucket;
}

/** Movable headings in current screen order. */
function movableLabels(groups: readonly OrderableGroup[]): string[] {
  return groups.filter(isMovableGroup).map(group => group.label);
}

/** Reordering is only offered when at least two groups can move. */
export function canReorderGroups(groups: readonly OrderableGroup[]): boolean {
  return movableLabels(groups).length > 1;
}

/**
 * Reorder the default group list by a saved order: placed groups first, then
 * unplaced ones in their incoming (alphabetical) order, then the empty bucket.
 * Names that match nothing on screen are skipped.
 */
export function applyGroupOrder<T extends OrderableGroup>(
  groups: readonly T[],
  order: readonly string[] | null | undefined
): T[] {
  const pinned = groups.filter(group => !isMovableGroup(group));
  // Map preserves insertion order, so leftovers stay alphabetical.
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
 * The full order a move is computed against: the saved order plus any
 * visible groups it doesn't name. Including hidden names means a drag made
 * under a filter doesn't drop the groups the filter is hiding.
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

/** Result of a move: the new order and its announced position. */
export interface GroupMove {
  /** New saved order for this column, hidden groups included. */
  readonly order: string[];
  /** The heading that moved. */
  readonly label: string;
  /** 0-based position among visible groups. */
  readonly index: number;
  /** Number of visible groups. */
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

  // Position is counted among visible groups only, since hidden ones are in `next` too.
  const visible = new Set(visibleLabels);
  const index = next.filter(entry => visible.has(entry)).indexOf(label);

  return { order: next, label, index, total: visibleLabels.length };
}

/**
 * Keyboard move: one place up or down among visible headings, no wrapping.
 * Returns null when nothing would move, so nothing is announced.
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
 * Drag move: the dragged heading takes the target's place (after it when
 * dragging down, before it when dragging up). Returns null for a drop onto
 * itself, the empty bucket, or a heading not on screen.
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

/** Live-region text after a move, e.g. "Mexico moved to position 3 of 12". */
export function describeGroupMove(move: GroupMove): string {
  return `${move.label} moved to position ${move.index + 1} of ${move.total}`;
}

/** Live-region text after a reset. */
export function describeGroupOrderReset(columnLabel: string): string {
  return `${columnLabel} groups back in alphabetical order`;
}

/** Set the order for one column, leaving others unchanged. */
export function withGroupOrder(
  orders: GroupOrders,
  column: InventoryColumn,
  order: readonly string[]
): GroupOrders {
  return { ...orders, [column]: [...order] };
}

/** Clear one column's order (reset). */
export function withoutGroupOrder(orders: GroupOrders, column: InventoryColumn): GroupOrders {
  if (!(column in orders)) return orders;
  const next = { ...orders };
  delete next[column];
  return next;
}

/** Whether the column has a custom order; drives the "Reset order" control. */
export function hasGroupOrder(orders: GroupOrders, column: string | null | undefined): boolean {
  if (!column) return false;
  return (orders[column]?.length ?? 0) > 0;
}

/** Orders for storage as plain string arrays; empty and non-groupable entries are dropped. */
export function serializeGroupOrders(orders: GroupOrders): Record<string, string[]> {
  const stored: Record<string, string[]> = {};
  for (const [column, labels] of Object.entries(orders)) {
    if (!isGroupableColumn(column) || !labels || labels.length === 0) continue;
    stored[column] = [...labels];
  }
  return stored;
}

/**
 * Read saved orders from the stored grouping object. Never throws.
 * Drops non-groupable columns, non-string or empty entries, and duplicates.
 * Headings that match no current group are kept: at restore time a deleted
 * group can't be told apart from one hidden by a filter, and applyGroupOrder
 * skips unknown names anyway.
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

/* --- Keyboard gesture ---
 * Alt+ArrowUp / Alt+ArrowDown on a focused group heading moves it. Plain
 * arrows aren't usable because grid-keyboard.ts ignores keys on buttons.
 * Other modifier combinations are left to the browser/OS. */

/** What a key press on a group heading means. */
export type GroupHeadingKeyAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'move'; readonly delta: -1 | 1 };

const NO_HEADING_ACTION: GroupHeadingKeyAction = { kind: 'none' };

/** The KeyboardEvent fields this module reads. */
export interface GroupHeadingKeyEvent {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  preventDefault?(): void;
}

export function groupHeadingKeyAction(event: GroupHeadingKeyEvent): GroupHeadingKeyAction {
  if (!event.altKey) return NO_HEADING_ACTION;
  if (event.ctrlKey || event.metaKey || event.shiftKey) return NO_HEADING_ACTION;

  if (event.key === 'ArrowUp') return { kind: 'move', delta: -1 };
  if (event.key === 'ArrowDown') return { kind: 'move', delta: 1 };
  return NO_HEADING_ACTION;
}

/**
 * Handle a key press on a heading. Calls preventDefault only for the move
 * gesture (Alt+Arrow scrolls in some browsers). Returns the action taken.
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
