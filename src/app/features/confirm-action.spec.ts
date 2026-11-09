/**
 * Tests for the two confirmation wrappers.
 *
 * The only interesting behaviour either of them has is WHAT HAPPENS WHEN
 * THERE IS NO DIALOG — under Node, under SSR, in a unit test — and the two
 * answer it in opposite directions on purpose. Getting that backwards is
 * silent: everything still compiles, every other test still passes, and the
 * coin editor quietly overwrites hand-typed weights in any environment
 * without `window.confirm`. So it is pinned here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmAction, confirmOverwrite } from './confirm-action';

/** Install an answer for the wrappers to find, as the app's own tests do. */
function withConfirm<T>(answer: boolean, body: (spy: ReturnType<typeof vi.fn>) => T): T {
  const spy = vi.fn(() => answer);
  (globalThis as unknown as { confirm?: unknown }).confirm = spy;
  return body(spy);
}

afterEach(() => {
  delete (globalThis as unknown as { confirm?: unknown }).confirm;
});

describe('when a dialog is available', () => {
  it('both wrappers pass the message through and return the answer', () => {
    withConfirm(true, (spy) => {
      expect(confirmAction('delete it?')).toBe(true);
      expect(confirmOverwrite('replace it?')).toBe(true);
      expect(spy).toHaveBeenCalledWith('delete it?');
      expect(spy).toHaveBeenCalledWith('replace it?');
    });

    withConfirm(false, () => {
      expect(confirmAction('delete it?')).toBe(false);
      expect(confirmOverwrite('replace it?')).toBe(false);
    });
  });
});

describe('when there is no dialog at all', () => {
  it('confirmAction FAILS OPEN — a button the user pressed must still work', () => {
    expect('confirm' in globalThis).toBe(false);
    expect(confirmAction('delete it?')).toBe(true);
  });

  it('confirmOverwrite FAILS CLOSED — nobody pressed anything, so nothing is replaced', () => {
    expect('confirm' in globalThis).toBe(false);
    expect(confirmOverwrite('replace it?')).toBe(false);
  });
});
