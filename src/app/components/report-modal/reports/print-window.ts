/*
 * print-window.ts — the ONLY part of the report feature that touches a DOM.
 *
 * WHY window.print() AND NOT A PDF LIBRARY
 *
 * The production initial bundle is 752 kB, against a 500 kB warning and a
 * 1 MB hard error in angular.json. pdfmake is ~1.1 MB minified with its
 * default fonts; jsPDF plus the AutoTable plugin a table of this shape needs
 * is ~400 kB. Either would have to be lazy-loaded, and lazy-loading is the
 * easy part. The parts that are not easy:
 *
 *   - A PDF library means reimplementing text measurement, column widths,
 *     page breaks and image placement in its own coordinate system. The
 *     browser already does all of that, correctly, for free.
 *   - It would be a second renderer. The HTML one still has to exist for
 *     on-screen preview, so every layout decision would live in two places.
 *   - Neither library gives the user anything they do not already get. The
 *     browser's own print dialog has "Save as PDF" on every platform this
 *     app ships to, so `window.print()` produces a GENUINE PDF with no
 *     dependency at all.
 *
 * What is given up is precise control of pagination. That is a real cost, and
 * it is paid down in report-html.ts with `thead { display: table-header-group }`
 * and `tr { break-inside: avoid }`, which handle the two cases that matter on
 * a long table. The rest — exactly where page 7 ends — is not worth 1 MB and
 * a second renderer. The webview shell does not change the answer: a print
 * inside it goes through the same Chromium print path.
 *
 * WHY A SEPARATE WINDOW RATHER THAN AN @media print RULE ON THE APP ITSELF.
 * Rendering the report into a hidden div and hiding the rest of the app with
 * a print stylesheet works, and is fragile: the report then inherits every
 * rule in styles.scss plus every component stylesheet, so an unrelated edit
 * to a modal can silently change what comes out of the printer and nothing
 * in the test suite would notice. A blank window with one inline stylesheet
 * cannot be affected by any of that.
 *
 * WHY THE OPENER IS AN ARGUMENT. The frontend suite runs under Node with no
 * jsdom; injecting `window.open` makes the two real failure modes — a
 * blocked pop-up, and printing before the document is closed — assertable
 * without a browser.
 */

/** The slice of `Window` this module uses. Narrow so a fake is three lines. */
export interface PrintTarget {
  document: { open(): void; write(html: string): void; close(): void };
  focus(): void;
  print(): void;
}

export type WindowOpener = () => PrintTarget | null;

export type PrintOutcome = 'printed' | 'blocked';

/** The real opener. `noopener` is deliberately NOT set — see below. */
export const defaultWindowOpener: WindowOpener = () =>
  window.open('', '_blank', 'width=1000,height=800') as unknown as PrintTarget | null;

/**
 * Write a self-contained document into a new window and print it.
 *
 * `document.close()` BEFORE `print()` is load-bearing. `document.write()`
 * leaves the stream open, and Chromium will happily print a still-open
 * document as a blank page — the classic "print produced nothing" bug. The
 * close() flushes it and fires the load, so the images are laid out before
 * the dialog opens.
 *
 * A blocked pop-up is REPORTED, not thrown. `window.open` answers null when
 * the browser refuses, and dereferencing that inside a click handler is an
 * uncaught TypeError that reaches the user as a button doing nothing at all.
 *
 * Note the opener does NOT pass `noopener`: with it, `window.open` returns
 * null by specification, and there would be no handle to write into. The
 * window is one we create and fill ourselves with no user-navigable content,
 * so there is nothing for an opener reference to leak to.
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
