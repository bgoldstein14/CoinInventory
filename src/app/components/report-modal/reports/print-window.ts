/*
 * print-window.ts — the only part of the report feature that touches a DOM.
 *
 * Reports are printed through the browser's print dialog ("Save as PDF"
 * gives a real PDF) instead of bundling a PDF library. They are written into
 * a separate blank window with one inline stylesheet, so the app's own styles
 * cannot affect the printed page. The opener is injectable for tests.
 */

/** The slice of `Window` this module uses. */
export interface PrintTarget {
  document: { open(): void; write(html: string): void; close(): void };
  focus(): void;
  print(): void;
}

export type WindowOpener = () => PrintTarget | null;

export type PrintOutcome = 'printed' | 'blocked';

/**
 * The real opener. `noopener` is not set: with it, `window.open` returns null
 * and there is no handle to write into.
 */
export const defaultWindowOpener: WindowOpener = () =>
  window.open('', '_blank', 'width=1000,height=800') as unknown as PrintTarget | null;

/**
 * Write a self-contained document into a new window and print it.
 *
 * `document.close()` must come before `print()`; Chromium prints a still-open
 * document as a blank page. A blocked pop-up (null from `window.open`) is
 * returned as 'blocked' rather than thrown.
 */
export function openPrintWindow(
  html: string,
  opener: WindowOpener = defaultWindowOpener
): PrintOutcome {
  let target: PrintTarget | null;
  try {
    target = opener();
  } catch {
    return 'blocked';
  }

  if (!target) return 'blocked';

  target.document.open();
  target.document.write(html);
  target.document.close();
  target.focus();
  target.print();

  return 'printed';
}
