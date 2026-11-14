/*
 * The grid's keyboard model.
 *
 * The rules themselves are pure (features/inventory/grid-keyboard.ts), which
 * is the only reason they can be tested at all: this suite runs under Node
 * with NO jsdom, so there is no element to dispatch a key at. Every "event"
 * below is a plain object, which is exactly the shape the module promises to
 * accept.
 *
 * What is NOT tested here, because it cannot be: that the component binds
 * `(keydown)` to the row and that `.focus()` lands on the right element.
 * `inventory-table-keyboard.spec.ts` greps the template for the bindings;
 * the `.focus()` call is three lines in `focusRowElement`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  gridRowKeyAction,
  handleGridRowKey,
  isControlTarget,
  nextFocusedIndex,
  rowTabIndex,
  tabbableRowId
} from './grid-keyboard';

/** A key press reported against an element with this tag name. */
function keyOn(key: string, tagName?: string) {
  return { key, target: tagName ? { tagName } : { tagName: 'TR' } };
}

describe('which keys the grid claims', () => {
  it('moves down on ArrowDown and up on ArrowUp', () => {
    expect(gridRowKeyAction(keyOn('ArrowDown'))).toEqual({ kind: 'move', delta: 1 });
    expect(gridRowKeyAction(keyOn('ArrowUp'))).toEqual({ kind: 'move', delta: -1 });
  });

  it('opens the row on Enter', () => {
    expect(gridRowKeyAction(keyOn('Enter'))).toEqual({ kind: 'activate' });
  });

  it('opens the row on Space, in both spellings browsers use', () => {
    expect(gridRowKeyAction(keyOn(' '))).toEqual({ kind: 'activate' });
    expect(gridRowKeyAction(keyOn('Spacebar'))).toEqual({ kind: 'activate' });
  });

  it('leaves every other key alone', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'PageDown', 'F2']) {
      expect(gridRowKeyAction(keyOn(key)), key).toEqual({ kind: 'none' });
    }
  });
});

describe('keys inside a control belong to the control', () => {
  it('ignores Space in the row selection checkbox, so the box still toggles', () => {
    // THE regression this guard exists for. Every row carries a selection
    // checkbox; if the row swallowed Space the box could not be ticked from
    // the keyboard at all, and ticking it would throw the sidebar open.
    expect(gridRowKeyAction(keyOn(' ', 'INPUT'))).toEqual({ kind: 'none' });
  });

  it('ignores Enter and Space on the Images button', () => {
    expect(gridRowKeyAction(keyOn('Enter', 'BUTTON'))).toEqual({ kind: 'none' });
    expect(gridRowKeyAction(keyOn(' ', 'BUTTON'))).toEqual({ kind: 'none' });
  });

  it('ignores the arrow keys inside a select, which uses them to change value', () => {
    expect(gridRowKeyAction(keyOn('ArrowDown', 'SELECT'))).toEqual({ kind: 'none' });
  });

  it('ignores keys in a text box', () => {
    expect(gridRowKeyAction(keyOn('ArrowUp', 'TEXTAREA'))).toEqual({ kind: 'none' });
  });

  it('recognises a control whatever case the tag name arrives in', () => {
    expect(isControlTarget({ tagName: 'input' })).toBe(true);
    expect(isControlTarget({ tagName: 'Button' })).toBe(true);
  });

  it('treats a contenteditable element as a control', () => {
    expect(isControlTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('does not treat the row, a cell or a missing target as a control', () => {
    expect(isControlTarget({ tagName: 'TR' })).toBe(false);
    expect(isControlTarget({ tagName: 'TD' })).toBe(false);
    expect(isControlTarget(null)).toBe(false);
    expect(isControlTarget(undefined)).toBe(false);
  });
});

describe('the event is swallowed for exactly the keys we act on', () => {
  function run(key: string, tagName = 'TR') {
    const preventDefault = vi.fn();
    const move = vi.fn();
    const activate = vi.fn();
    const action = handleGridRowKey({ key, target: { tagName }, preventDefault }, { move, activate });
    return { action, preventDefault, move, activate };
  }

  it('swallows the arrows, or the page scrolls as the selection moves', () => {
    const down = run('ArrowDown');
    expect(down.preventDefault).toHaveBeenCalledTimes(1);
    expect(down.move).toHaveBeenCalledWith(1);
    expect(down.activate).not.toHaveBeenCalled();
  });

  it('swallows Space, which scrolls the page by default', () => {
    const space = run(' ');
    expect(space.preventDefault).toHaveBeenCalledTimes(1);
    expect(space.activate).toHaveBeenCalledTimes(1);
  });

  it('swallows Enter and opens the row', () => {
    const enter = run('Enter');
    expect(enter.preventDefault).toHaveBeenCalledTimes(1);
    expect(enter.activate).toHaveBeenCalledTimes(1);
  });

  it('does NOT swallow a key it does not act on', () => {
    const tab = run('Tab');
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(tab.move).not.toHaveBeenCalled();
    expect(tab.activate).not.toHaveBeenCalled();
  });

  it('does NOT swallow Space pressed in the checkbox', () => {
    const space = run(' ', 'INPUT');
    expect(space.preventDefault).not.toHaveBeenCalled();
    expect(space.activate).not.toHaveBeenCalled();
  });

  it('survives an event with no preventDefault at all', () => {
    const activate = vi.fn();
    expect(() =>
      handleGridRowKey({ key: 'Enter', target: { tagName: 'TR' } }, { activate, move: vi.fn() })
    ).not.toThrow();
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe('where an arrow key lands', () => {
  it('steps one row at a time', () => {
    expect(nextFocusedIndex(3, 1, 10)).toBe(4);
    expect(nextFocusedIndex(3, -1, 10)).toBe(2);
  });

  it('stops at the ends rather than wrapping round', () => {
    // Wrapping would jump the viewport the whole length of a 105-row grid
    // for a key press the user expected to do nothing.
    expect(nextFocusedIndex(0, -1, 10)).toBe(0);
    expect(nextFocusedIndex(9, 1, 10)).toBe(9);
  });

  it('reports nowhere to go for an empty grid', () => {
    expect(nextFocusedIndex(0, 1, 0)).toBe(-1);
  });

  it('reports nowhere to go for a row that is no longer in the list', () => {
    // `indexOf` returns -1 when a filter has removed the focused row.
    expect(nextFocusedIndex(-1, 1, 10)).toBe(-1);
    expect(nextFocusedIndex(12, 1, 10)).toBe(-1);
  });
});

describe('the roving tabindex', () => {
  const rows = ['a', 'b', 'c'];

  it('puts exactly one row in the tab order', () => {
    // The point of the whole mechanism: `tabindex` on all 105 rows would
    // mean 105 presses of Tab to get past the table.
    const chosen = tabbableRowId(rows, 'b', 'c');
    const tabbable = rows.filter(id => rowTabIndex(id === chosen) === 0);
    expect(tabbable).toEqual(['b']);
  });

  it('prefers the row that currently has focus', () => {
    expect(tabbableRowId(rows, 'c', 'a')).toBe('c');
  });

  it('falls back to the selected coin when the focused row has been filtered out', () => {
    expect(tabbableRowId(rows, 'gone', 'b')).toBe('b');
  });

  it('falls back to the first row when nothing has been touched', () => {
    expect(tabbableRowId(rows, null, null)).toBe('a');
  });

  it('falls back to the first row when the selected coin is off screen too', () => {
    expect(tabbableRowId(rows, 'gone', 'also-gone')).toBe('a');
  });

  it('has nothing to offer for an empty grid', () => {
    expect(tabbableRowId([], 'a', 'b')).toBeNull();
  });

  it('keeps every other row focusable programmatically, not unfocusable', () => {
    // -1 rather than no attribute: the arrow keys have to be able to move
    // real focus onto a row that is not in the tab order.
    expect(rowTabIndex(false)).toBe(-1);
    expect(rowTabIndex(true)).toBe(0);
  });
});
