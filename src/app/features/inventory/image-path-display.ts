/*
 * Render model for one image's original-file path. Pure functions, no Angular.
 *
 *   present  backend confirmed the file is readable -> link, opens in a new tab
 *   missing  backend looked and it is gone -> muted, non-clickable text kept as
 *            a record of where the file was
 *   unknown  could not ask (server unreachable, check pending) -> plain text,
 *            no claim either way
 *   none     no path recorded -> render nothing
 */

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

/** Max characters of a path to show; keeps the filename visible in the sidebar. */
export const PATH_DISPLAY_LIMIT = 58;

/**
 * Shorten a path from the middle, keeping the share name and the filename.
 * The full path is always in the `title` tooltip.
 */
export function middleEllipsis(path: string, limit = PATH_DISPLAY_LIMIT): string {
  if (path.length <= limit) return path;

  // One character goes to the ellipsis; the tail (filename) gets the larger half.
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
 * @param sourcePath   the recorded absolute path, or null/empty for "none"
 * @param existence    what the backend said about it
 * @param buildFileUrl turns a path into a backend URL (`ApiService.imageFileUrl`
 *                     in the app); injected to keep this module Angular-free
 */
export function buildImagePathView(
  sourcePath: string | null | undefined,
  existence: ImageFileExistence,
  buildFileUrl: (path: string) => string
): ImagePathView {
  const path = (sourcePath ?? '').trim();

  // Case 'none': nothing recorded, so render nothing.
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

  // Only a confirmed-present file gets a link.
  const isLink = existence === 'present';

  return {
    hasPath: true,
    sourcePath: path,
    displayPath: middleEllipsis(path),
    existence,
    isLink,
    // Served through the backend: browsers block navigation from http to file:// URLs.
    fileUrl: isLink ? buildFileUrl(path) : null,
    title: `${path}\n${explain(existence)}`
  };
}
