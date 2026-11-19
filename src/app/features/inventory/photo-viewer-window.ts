/*
 * Sizing and source selection for the resizable full-size photo window.
 * Pure functions with no Angular or DOM, so they can be tested under Node.
 *
 * Every photo has two copies: the stored copy (`coin.imagePaths[i]`, a data URL
 * downscaled at import) and, when a `sourcePath` was recorded and the file still
 * exists, the original on disk served by `GET /api/images/file`. The viewer
 * prefers the original and caps the window at the natural size of whichever
 * image is actually shown.
 */

import { ImagePathView } from './image-path-display';

/** A width/height pair in CSS pixels. */
export interface PixelSize {
  width: number;
  height: number;
}

/** Which of the two copies of a photo the viewer ended up showing. */
export type ViewerSourceKind = 'original' | 'stored';

/** What the viewer should put in the <img src>, and what that thing is. */
export interface ViewerSource {
  /** The URL to render: either a backend file URL or the stored data URL. */
  url: string;
  kind: ViewerSourceKind;
}

/** Fraction of the screen the window opens at, per axis (half width, half height). */
export const VIEWER_DISPLAY_FRACTION = 0.5;

/**
 * Smallest window size, leaving room for the prev / next / close buttons.
 * Never applied above the image's own natural size — see minViewerSize().
 */
export const VIEWER_MIN_SIZE = 240;

/** True when a measured size is usable (an unloaded <img> reports 0 x 0). */
function isMeasured(size: PixelSize | null | undefined): size is PixelSize {
  return !!size && size.width > 0 && size.height > 0;
}

/**
 * Decide which copy of the photo to show. Uses the original only when the
 * backend has confirmed the file is readable (`isLink`); 'unknown' falls back to
 * the stored copy to avoid a broken-image icon. Called from a computed, so the
 * viewer swaps to the original once the existence check resolves.
 */
export function chooseViewerSource(
  storedDataUrl: string,
  pathView: ImagePathView | null
): ViewerSource {
  if (pathView?.isLink && pathView.fileUrl) {
    return { url: pathView.fileUrl, kind: 'original' };
  }
  return { url: storedDataUrl, kind: 'stored' };
}

/**
 * The opening window size: the image's aspect ratio scaled to fit inside the
 * display fraction, so the photo fills the window without letterboxing. Scale
 * is capped at 1 so small photos open at their true size.
 */
export function initialViewerSize(
  natural: PixelSize | null,
  viewport: PixelSize,
  fraction: number = VIEWER_DISPLAY_FRACTION
): PixelSize {
  const boxWidth = Math.max(1, viewport.width * fraction);
  const boxHeight = Math.max(1, viewport.height * fraction);

  // Not measured yet (or broken image): use the plain box until the image loads.
  if (!isMeasured(natural)) {
    return { width: Math.round(boxWidth), height: Math.round(boxHeight) };
  }

  const scale = Math.min(boxWidth / natural.width, boxHeight / natural.height, 1);

  // Floor at the minimum, but never above the image's natural size.
  return {
    width: Math.max(Math.round(natural.width * scale), Math.min(VIEWER_MIN_SIZE, natural.width)),
    height: Math.max(Math.round(natural.height * scale), Math.min(VIEWER_MIN_SIZE, natural.height))
  };
}

/**
 * The largest the window may grow: the image's native pixel size. Deliberately
 * not clamped to the screen — large originals may exceed the viewport and the
 * backdrop scrolls. Returns null while the size is unknown (no max-width).
 */
export function maxViewerSize(natural: PixelSize | null): PixelSize | null {
  if (!isMeasured(natural)) return null;
  return { width: Math.round(natural.width), height: Math.round(natural.height) };
}

/**
 * The smallest the window may shrink: VIEWER_MIN_SIZE, but never above the
 * maximum, since a CSS min-width larger than max-width would win.
 */
export function minViewerSize(natural: PixelSize | null): PixelSize {
  if (!isMeasured(natural)) return { width: VIEWER_MIN_SIZE, height: VIEWER_MIN_SIZE };
  return {
    width: Math.min(VIEWER_MIN_SIZE, Math.round(natural.width)),
    height: Math.min(VIEWER_MIN_SIZE, Math.round(natural.height))
  };
}

/** One short caption saying which copy is on screen and its dimensions. */
export function describeViewerSource(kind: ViewerSourceKind, natural: PixelSize | null): string {
  const dimensions = isMeasured(natural)
    ? ` — ${Math.round(natural.width)} × ${Math.round(natural.height)}`
    : '';

  return kind === 'original'
    ? `Original file${dimensions}`
    : `Stored copy${dimensions} (original file not available)`;
}
