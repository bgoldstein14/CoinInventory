/*
 * Grid keyboard model — what a key press on a coin row means.
 *
 * Kept DOM-free so it can be tested under Node; the component only moves
 * focus and emits outputs.
 *
 * - Arrow Up/Down move the focused row; Enter and Space open it. All of these
 *   call preventDefault so the page doesn't scroll at the same time.
 * - Keys from a control inside the row (checkbox, button, etc.) are ignored,
 *   so Space still toggles the selection checkbox.
 * - Roving tabindex: exactly one row is in the tab order.
 */

/** What a key press on a row means. */
export type GridRowKeyAction =
  /** Not handled: came from a control, or the key isn't bound. */
  | { readonly kind: 'none' }
  /** Move the focused row by `delta` (-1 up, +1 down). */
  | { readonly kind: 'move'; readonly delta: number }
  /** Open the Details panel for the focused row. */
  | { readonly kind: 'activate' };

const NO_ACTION: GridRowKeyAction = { kind: 'none' };

/** Elements that handle their own keys. `A` because Enter activates links. */
const CONTROL_TAG_NAMES = new Set([
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'OPTION',
  'LABEL',
  'A'
]);

/** The KeyboardEvent fields this module reads. */
export interface GridRowKeyEvent {
  readonly key: string;
  /** `unknown` so a real KeyboardEvent fits without importing DOM types. */
  readonly target?: unknown;
  preventDefault?(): void;
}

/** True when the event came from an element that handles its own keys. */
export function isControlTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  const tagName = element.tagName;
  if (typeof tagName !== 'string') return false;
  return CONTROL_TAG_NAMES.has(tagName.toUpperCase());
}

/** Keys that open a row. `'Spacebar'` is the old Edge/IE spelling. */
const ACTIVATION_KEYS = new Set([' ', 'Spacebar', 'Enter']);

export function gridRowKeyAction(event: GridRowKeyEvent): GridRowKeyAction {
  if (isControlTarget(event.target)) return NO_ACTION;

  switch (event.key) {
    case 'ArrowDown':
      return { kind: 'move', delta: 1 };
    case 'ArrowUp':
      return { kind: 'move', delta: -1 };
    default:
      return ACTIVATION_KEYS.has(event.key) ? { kind: 'activate' } : NO_ACTION;
  }
}

/** Callbacks the component provides. */
export interface GridRowKeyHandlers {
  /** Move the focused row by `delta` and focus it. */
  move(delta: number): void;
  /** Open the Details panel for this row. */
  activate(): void;
}

/**
 * Handle a key press on a row. Calls preventDefault only for handled keys.
 * Returns the action taken.
 */
export function handleGridRowKey(
  event: GridRowKeyEvent,
  handlers: GridRowKeyHandlers
): GridRowKeyAction {
  const action = gridRowKeyAction(event);
  if (action.kind === 'none') return action;

  event.preventDefault?.();

  if (action.kind === 'activate') {
    handlers.activate();
  } else {
    handlers.move(action.delta);
  }
  return action;
}

/**
 * Index to focus after an arrow key. Clamps at the ends (no wrapping).
 * Returns -1 for an empty grid or an index no longer in range.
 */
export function nextFocusedIndex(currentIndex: number, delta: number, rowCount: number): number {
  if (rowCount <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= rowCount) return -1;
  const next = currentIndex + delta;
  if (next < 0) return 0;
  if (next >= rowCount) return rowCount - 1;
  return next;
}

/**
 * The row in the tab order: the last-focused row if still present, else the
 * selected coin, else the first row. Null only for an empty grid.
 */
export function tabbableRowId(
  rowIds: readonly string[],
  focusedId: string | null | undefined,
  selectedId: string | null | undefined
): string | null {
  if (rowIds.length === 0) return null;
  if (focusedId && rowIds.includes(focusedId)) return focusedId;
  if (selectedId && rowIds.includes(selectedId)) return selectedId;
  return rowIds[0];
}

/**
 * `tabindex` for a row: 0 for the tabbable row, -1 otherwise (still
 * focusable programmatically for arrow-key movement).
 */
export function rowTabIndex(isTabbableRow: boolean): 0 | -1 {
  return isTabbableRow ? 0 : -1;
}
