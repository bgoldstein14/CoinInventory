/* ===========================================================================
 * image-path-display.ts — deciding HOW to render one image's original path.
 * ---------------------------------------------------------------------------
 * Pure functions, no Angular. Everything the template needs is worked out here
 * and handed over as a plain object, which keeps the markup free of nested
 * conditionals and makes all of the behaviour unit-testable without a browser.
 *
 * ---------------------------------------------------------------------------
 * THE THREE (well, four) CASES
 * ---------------------------------------------------------------------------
 *   present  the backend confirmed the file is readable
 *            -> a real link, opening in a new tab
 *   missing  the backend looked and it is not there
 *            -> NOT a link: no href, no underline, no pointer, not focusable,
 *               and a muted colour. The path text stays visible, because the
 *               user explicitly wants it as a record of where the file *was*.
 *   unknown  we could not ask (server unreachable, check not finished)
 *            -> plain text, no claim either way. Showing "missing" here would
 *               tell the user his whole photo library had vanished every time
 *               the backend restarted.
 *   none     no path was ever recorded (every image imported before this
 *            feature, or one added through the gallery's file picker)
 *            -> render nothing at all. An empty or dead affordance is worse
 *               than no affordance.
 * =========================================================================== */

import { ImageFileExistence } from '../../types/coin-image.model';

/** Everything the template needs to render one image's path. */
export interface ImagePathView {
  /** True when there is a path worth showing at all. */
  hasPath: boolean;
  /** The full path, for the tooltip and for the text itself. */
  sourcePath: string;
  /** Shortened for display so a long UNC path cannot stretch the sidebar. */
  displayPath: string;
  /** 'present' | 'missing' | 'unknown' (never used when hasPath is false). */
  existence: ImageFileExistence;
  /** Only a confirmed-present file is clickable. */
  isLink: boolean;
  /** The backend URL that serves the original, or null when not a link. */
  fileUrl: string | null;
  /** `title` tooltip: the full path plus what its state means. */
  title: string;
}

/**
 * How many characters of a path to show before shortening it.
 *
 * The detail sidebar is narrow and a real path here is long
 * (`\\192.168.0.10\Coin Pictures\Business Strikes\1865 3CN - MS60 - Obverse.jpg`
 * is 76 characters), so some shortening is needed. 58 keeps the interesting
 * part — the filename — fully visible in the sidebar at its normal width.
 */
export const PATH_DISPLAY_LIMIT = 58;

/**
 * Shorten a path from the MIDDLE, keeping both ends.
 *
 * Truncating the end (`\\192.168.0.10\Coin Pic…`) would hide the filename,
 * which is the part the user actually reads. Truncating the start would hide
 * which share it came from. So the middle — the least informative part, the
 * intermediate folders — is what gives way. The full path is always available
 * in the `title` tooltip regardless.
 */
export function middleEllipsis(path: string, limit = PATH_DISPLAY_LIMIT): string {
  if (path.length <= limit) return path;

  // One character of the budget is spent on the ellipsis itself. The remainder
  // is split with slightly more going to the tail, because the filename lives
  // there and matters more than the leading share name.
  const budget = limit - 1;
  const tailLength = Math.ceil(budget / 2);
  const headLength = budget - tailLength;

  return `${path.slice(0, headLength)}…${path.slice(path.length - tailLength)}`;
}

/** The tooltip text for each state. The full path is prepended by the caller. */
function explain(existence: ImageFileExistence): string {
  switch (existence) {
    case 'present':
      return 'Click to open the original full-size image in a new tab.';
    case 'missing':
      return 'The original file is no longer at this location, so it cannot be opened. ' +
        'The path is kept as a record of where it was.';
    case 'unknown':
      return 'Could not check whether this file still exists — the server did not respond.';
  }
}

/**
 * Build the render model for one image's original-file path.
 *
 * @param sourcePath  the recorded absolute path, or null/empty for "none"
 * @param existence   what the backend said about it
 * @param buildFileUrl how to turn a path into a backend URL. Passed in rather
 *                     than imported so this module stays free of Angular and of
 *                     ApiService — in the app this is `ApiService.imageFileUrl`.
 */
export function buildImagePathView(
  sourcePath: string | null | undefined,
  existence: ImageFileExistence,
  buildFileUrl: (path: string) => string
): ImagePathView {
  const path = (sourcePath ?? '').trim();

  // ---- Case 'none': nothing recorded, so render nothing --------------------
  if (path.length === 0) {
    return {
      hasPath: false,
      sourcePath: '',
      displayPath: '',
      existence: 'unknown',
      isLink: false,
      fileUrl: null,
      title: ''
    };
  }

  // A link is offered ONLY for a file the backend has confirmed it can read.
  // 'unknown' deliberately does NOT get a link: offering one we cannot honour
  // produces a click that appears to do nothing, which is the worst outcome.
  const isLink = existence === 'present';

  return {
    hasPath: true,
    sourcePath: path,
    displayPath: middleEllipsis(path),
    existence,
    isLink,
    // Built through the backend, never as a `file:///` URL — Chrome and Edge
    // silently block navigation from an http page to a file URL. See
    // ApiService.imageFileUrl for the full explanation.
    fileUrl: isLink ? buildFileUrl(path) : null,
    title: `${path}\n${explain(existence)}`
  };
}
