/**
 * Wrapper around the browser's `confirm()` dialog for user-initiated actions
 * (e.g. deleting coins). If `confirm` is unavailable (tests, SSR) it fails open
 * and returns true, so the button the user pressed still works.
 */
export function confirmAction(message: string): boolean {
  const confirmFn = lookUpConfirm();

  if (!confirmFn) return true;
  return confirmFn(message);
}

/**
 * The same dialog for app-initiated overwrites (e.g. pm-autofill replacing a
 * hand-entered weight). Fails closed: if `confirm` is unavailable it returns
 * false and nothing is overwritten.
 */
export function confirmOverwrite(message: string): boolean {
  const confirmFn = lookUpConfirm();

  if (!confirmFn) return false;
  return confirmFn(message);
}

/** Find `confirm` on globalThis or window, or null if neither has it. */
function lookUpConfirm(): ((message: string) => boolean) | null {
  if (typeof globalThis !== 'undefined' && 'confirm' in globalThis) {
    return globalThis.confirm.bind(globalThis);
  }
  if (typeof window !== 'undefined' && 'confirm' in window) {
    return window.confirm.bind(window);
  }
  return null;
}
