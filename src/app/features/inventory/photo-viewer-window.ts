/* ===========================================================================
 * photo-viewer-window.ts — the arithmetic and the source choice behind the
 * resizable full-size photo window.
 * ---------------------------------------------------------------------------
 * Pure functions, no Angular, no DOM. CoinPhotoViewer feeds them the numbers
 * it reads off the browser (the <img>'s naturalWidth/naturalHeight and the
 * window's innerWidth/innerHeight) and binds the answers straight to CSS.
 *
 * Why these few lines live on their own rather than inside the component:
 * every one of them is a RULE the owner asked for in words —
 *
 *   "a large popup ... in a resizable window where the image takes up the
 *    full size of the window (which should start off only taking about 1/2
 *    the display) allow me to shrink and grow the image window up to the
 *    highest resolution of the picture"
 *
 * — and rules stated in words deserve tests. None of this needs a browser, so
 * none of it should need one to be checked.
 *
 * ---------------------------------------------------------------------------
 * THE "HIGHEST RESOLUTION OF THE PICTURE" PROBLEM
 * ---------------------------------------------------------------------------
 * There are TWO copies of every photo in this app, and they are not the same
 * size:
 *
 *   1. The STORED COPY. `coin.imagePaths[i]` is a base64 `data:` URL kept in
 *      the database, downscaled at import time to roughly 250 KB (see
 *      services/image-import/image-downscaler.ts). Always available; modest
 *      resolution.
 *
 *   2. The ORIGINAL. The camera file still sitting on disk, up to ~46 MB.
 *      Available only when the import recorded a `sourcePath` for the photo
 *      AND that file is still where it was. The backend streams it from
 *      `GET /api/images/file?path=…` (see server/routes/images/file.ts, and
 *      CoinImagePathLink for why it cannot be a `file://` link).
 *
 * "Grow the window up to the highest resolution of the picture" is only
 * honest for (2). So the viewer prefers the original whenever it is genuinely
 * there, falls back to the stored copy when it is not, and in BOTH cases caps
 * the window at whatever that image's real pixel size turns out to be. The
 * cap therefore needs no special case: it is always "the natural size of the
 * thing actually on screen", which is exactly what stops the user stretching
 * a 600px fallback to 4000px and wondering why it went soft.
 * =========================================================================== */

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

/**
 * How much of the screen the window covers when it first opens, per axis.
 *
 * The owner asked for "about 1/2 the display". Half per AXIS — half the
 * screen's width and half its height — which is a quarter of the screen by
 * area. That ambiguity was put to him directly on 2026-10-17 and he settled
 * it: "Quarter of the screen area is fine." Recorded here because the two
 * readings differ by a factor of two and the next person to read this line
 * will wonder which was meant.
 *
 * It is a named constant on its own line precisely so that "a bit bigger
 * please" stays a one-character change rather than a hunt through a
 * stylesheet.
 */
export const VIEWER_DISPLAY_FRACTION = 0.5;

/**
 * The smallest the window may be shrunk to. Small enough to tuck the photo
 * out of the way, large enough that the floating prev / next / close buttons
 * still have somewhere to sit.
 *
 * Never applied above the image's own natural size — see minViewerSize().
 */
export const VIEWER_MIN_SIZE = 240;

/** True when a measured size is usable (an unloaded <img> reports 0 x 0). */
function isMeasured(size: PixelSize | null | undefined): size is PixelSize {
  return !!size && size.width > 0 && size.height > 0;
}

/**
 * Decide which copy of the photo to show.
 *
 * @param storedDataUrl the `data:` URL held on the coin record — the fallback,
 *                      and the only thing guaranteed to exist.
 * @param pathView      what CoinImagePathsService knows about this photo's
 *                      original file, or null if nothing is known yet.
 *
 * The test is `pathView.isLink`, which is true ONLY when the backend has
 * confirmed it can actually read the file (see image-path-display.ts). That
 * matters: 'unknown' — the server has not answered yet, or did not answer at
 * all — deliberately does NOT get the original. Pointing an <img> at a URL we
 * are merely hoping about would give the user a broken-image icon instead of
 * their photo, which is strictly worse than the stored copy we already have.
 *
 * Because the existence check resolves a moment after the viewer opens, this
 * is called from a computed: the viewer legitimately starts on the stored copy
 * and swaps up to the original when the answer arrives.
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
 * The size the window opens at: the image's own shape, scaled to fit inside
 * half the display.
 *
 * Why the image's ASPECT RATIO drives this rather than a plain half-by-half
 * rectangle: the owner also asked that "the image takes up the full size of
 * the window". A window shaped like the photo means the photo fills it edge to
 * edge with no letterboxing at all on opening. (Resize it to some other shape
 * afterwards and bars appear — that is `object-fit: contain` doing its job,
 * and it is the right trade: squashing a round coin into an oval would hide
 * exactly the detail this screen exists to show.)
 *
 * The scale is capped at 1, so a small photo opens at its true size instead of
 * being blown up into a blurry half-screen rectangle.
 *
 * @param natural  the <img>'s naturalWidth/naturalHeight, or null before load
 * @param viewport window.innerWidth / innerHeight
 */
export function initialViewerSize(
  natural: PixelSize | null,
  viewport: PixelSize,
  fraction: number = VIEWER_DISPLAY_FRACTION
): PixelSize {
  const boxWidth = Math.max(1, viewport.width * fraction);
  const boxHeight = Math.max(1, viewport.height * fraction);

  // Nothing measured yet (or a broken image): just take the half-screen box.
  // The window still gets a sensible size, and the real one lands on load.
  if (!isMeasured(natural)) {
    return { width: Math.round(boxWidth), height: Math.round(boxHeight) };
  }

  const scale = Math.min(boxWidth / natural.width, boxHeight / natural.height, 1);

  // Floor at the minimum, but never push a genuinely tiny image ABOVE its own
  // natural size — that would contradict the maximum we are about to impose.
  return {
    width: Math.max(Math.round(natural.width * scale), Math.min(VIEWER_MIN_SIZE, natural.width)),
    height: Math.max(Math.round(natural.height * scale), Math.min(VIEWER_MIN_SIZE, natural.height))
  };
}

/**
 * The largest the window may be grown to: the image's native pixel size, and
 * not one pixel more.
 *
 * Note what is deliberately NOT here — a clamp to the screen. A 4032 x 3024
 * camera original is bigger than the monitor, and the owner explicitly wants
 * to be able to grow the window "up to the highest resolution of the picture".
 * So the window is allowed to exceed the viewport and the backdrop scrolls
 * (see `overflow: auto` in the stylesheet). Capping at the screen would make
 * the feature unreachable on every photo it was asked for.
 *
 * Returns null while the size is unknown, which the template reads as "put no
 * max-width on it yet".
 */
export function maxViewerSize(natural: PixelSize | null): PixelSize | null {
  if (!isMeasured(natural)) return null;
  return { width: Math.round(natural.width), height: Math.round(natural.height) };
}

/**
 * The smallest the window may be shrunk to.
 *
 * Normally the flat VIEWER_MIN_SIZE, but never larger than the maximum: for a
 * thumbnail-sized image the floor and the ceiling would otherwise cross, and a
 * CSS min-width above its max-width wins — the window would be stuck LARGER
 * than the image's native resolution, which is the one thing this module
 * promises cannot happen.
 */
export function minViewerSize(natural: PixelSize | null): PixelSize {
  if (!isMeasured(natural)) return { width: VIEWER_MIN_SIZE, height: VIEWER_MIN_SIZE };
  return {
    width: Math.min(VIEWER_MIN_SIZE, Math.round(natural.width)),
    height: Math.min(VIEWER_MIN_SIZE, Math.round(natural.height))
  };
}

/**
 * One short line telling the user which copy is on screen, and how big it is.
 *
 * Kept to a single clause on purpose. The owner asked to be told "briefly and
 * without nagging": the stored-copy case mentions the original once, as a
 * fact, and never suggests he should go and do something about it.
 */
export function describeViewerSource(kind: ViewerSourceKind, natural: PixelSize | null): string {
  const dimensions = isMeasured(natural)
    ? ` — ${Math.round(natural.width)} × ${Math.round(natural.height)}`
    : '';

  return kind === 'original'
    ? `Original file${dimensions}`
    : `Stored copy${dimensions} (original file not available)`;
}
