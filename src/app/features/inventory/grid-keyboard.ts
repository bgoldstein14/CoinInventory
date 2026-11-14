/*
 * Grid keyboard model — what a key press on a coin row MEANS.
 *
 * WHY THIS IS A FILE OF ITS OWN
 *
 * The suite runs under Node with NO jsdom, so a keydown handler written
 * inline in a component is untestable: there is no element to dispatch a key
 * at and no `KeyboardEvent` to build. Everything that can be decided without
 * a DOM is decided here, against a minimal event shape that a plain object
 * satisfies, and the component is left holding only the two things that do
 * need a browser — moving focus and emitting an output.
 *
 * WHAT THE MODEL HAS TO GET RIGHT
 *
 *  1. ARROW UP/DOWN MOVE, AND MUST SWALLOW THE EVENT. Left alone, the browser
 *     scrolls the page at the same time as the selection moves, so the row
 *     that just took focus slides out from under the user.
 *
 *  2. ENTER AND SPACE BOTH OPEN THE ROW. Enter is the conventional activation
 *     key; Space is what a user who has just arrowed onto a row will reach
 *     for. Space scrolls by default, so it needs swallowing for the same
 *     reason the arrows do.
 *
 *  3. KEYS INSIDE A CONTROL ARE NOT OURS. Every row carries a selection
 *     checkbox, and Space on a checkbox toggles it — that is the whole of
 *     what Space means there. A row-level handler that swallowed it would
 *     break bulk selection from the keyboard entirely, and would open the
 *     detail sidebar every time somebody ticked a box. Same for the Images
 *     button (Enter/Space press it) and for any select or text box the grid
 *     grows later. So: if the event came from a control, this module returns
 *     `none` and the component does nothing at all.
 *
 *  4. ONE ROW IS TABBABLE AT A TIME. `tabindex` on all 105 rows would mean
 *     105 presses of Tab to get past the table. The standard answer is a
 *     roving tabindex: exactly one row is in the tab order, the arrows move
 *     which one that is. `tabbableRowId` below is that choice, and it is
 *     pure so it can be tested for the cases that actually bite — the
 *     focused row being filtered out from under the user, and an empty grid.
 *
 * Nothing here imports Angular.
 */

/** What a key press on a row turns out to mean. */
export type GridRowKeyAction =
  /** Not ours: a control handled it, or it is a key we do not bind. */
  | { readonly kind: 'none' }
  /** Move the focused row by `delta` (-1 up, +1 down). */
  | { readonly kind: 'move'; readonly delta: number }
  /** Open the Details panel for the focused row. */
  | { readonly kind: 'activate' };

const NO_ACTION: GridRowKeyAction = { kind: 'none' };

/**
 * Tag names whose own keyboard behaviour must survive untouched.
 *
 * `OPTION` and `LABEL` are here because a key press can legitimately be
 * reported against them, and `A` because a link is activated by Enter.
 */
const CONTROL_TAG_NAMES = new Set([
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'OPTION',
  'LABEL',
  'A'
]);

/**
 * The parts of a KeyboardEvent this module reads. A plain object satisfies
 * it, which is the point: these rules are testable with no DOM at all.
 */
export interface GridRowKeyEvent {
  readonly key: string;
  /**
   * `unknown` so that a real `KeyboardEvent` satisfies this interface without
   * this module importing the DOM types it exists to avoid needing. The two
   * properties actually read are picked off defensively in `isControlTarget`.
   */
  readonly target?: unknown;
  preventDefault?(): void;
}

/**
 * Did this key press come from something that handles its own keys?
 *
 * Deliberately asks about the ELEMENT the event came from rather than about
 * the key: "Space means toggle" is a fact about the checkbox, not about the
 * space bar, and a rule written the other way round would have to be
 * re-stated for every control the grid ever gains.
 */
export function isControlTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  const tagName = element.tagName;
  if (typeof tagName !== 'string') return false;
  return CONTROL_TAG_NAMES.has(tagName.toUpperCase());
}

/** The keys that open a row. `'Spacebar'` is the old Edge/IE spelling. */
const ACTIVATION_KEYS = new Set([' ', 'Spacebar', 'Enter']);

/** What this key press means on a row. */
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

/** What the component must be able to do in response. */
export interface GridRowKeyHandlers {
  /** Move the focused row by `delta` and put real focus on it. */
  move(delta: number): void;
  /** Open the Details panel for this row. */
  activate(): void;
}

/**
 * Run a key press against the model and do what it says.
 *
 * `preventDefault()` is called here, for EVERY action that is ours and for
 * no action that is not. Arrows and Space both scroll the page by default,
 * and a grid whose selection moves while the page scrolls underneath it is
 * worse than one with no keyboard support at all.
 *
 * Returns the action taken, so a test can assert both halves at once.
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
 * Where the focus goes when an arrow key moves it.
 *
 * CLAMPS, does not wrap. Arrowing off the bottom of a 105-row grid and
 * landing back at the top is disorienting: the viewport jumps the whole
 * length of the table for a key press that the user expected to do nothing.
 * Stopping at the end is what every native list does.
 *
 * Returns -1 for an empty grid or a row that is no longer in the list, which
 * callers read as "there is nowhere to go".
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
 * WHICH ROW IS IN THE TAB ORDER — the roving tabindex.
 *
 * Exactly one, always, so Tab reaches the grid in one press and leaves it in
 * one press. The order of preference is the order in which the answers stop
 * being surprising:
 *
 *   1. The row that was last focused, IF it is still on screen. Filters and
 *      sorting can take it away mid-session; falling through then is the
 *      whole reason this is not just "the focused row".
 *   2. The selected coin, so tabbing into the grid lands on the row the rest
 *      of the screen is already talking about.
 *   3. The first row, so a grid nobody has touched yet is still reachable.
 *
 * Returns null only for an empty grid, where there is nothing to tab to.
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
 * The `tabindex` value for one row: 0 for the single tabbable row, -1 for
 * every other. -1 rather than absent, because a row still has to be
 * focusable programmatically for the arrow keys to move focus onto it.
 */
export function rowTabIndex(isTabbableRow: boolean): 0 | -1 {
  return isTabbableRow ? 0 : -1;
}
