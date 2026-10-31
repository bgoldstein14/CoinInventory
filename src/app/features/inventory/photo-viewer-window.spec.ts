/**
 * Tests for the resizable full-size photo window's arithmetic and its choice
 * between the original file and the stored copy.
 *
 * WHY THESE ARE WORTH TESTING
 * ---------------------------
 * Everything here was stated by the owner as a rule, in words:
 *
 *   "...a resizable window where the image takes up the full size of the
 *    window (which should start off only taking about 1/2 the display) allow
 *    me to shrink and grow the image window up to the highest resolution of
 *    the picture"
 *
 * The resizing itself is one line of CSS (`resize: both`) and cannot be
 * tested without a browser. The three numbers that CSS is given — the opening
 * size, the maximum and the minimum — are pure arithmetic, and they are the
 * part that can silently be wrong. In particular the MAXIMUM is the whole
 * reason the viewer bothers to fetch the original file at all, so it gets the
 * most attention below.
 */
import { describe, expect, it } from 'vitest';
import { buildImagePathView } from './image-path-display';
import {
  chooseViewerSource,
  describeViewerSource,
  initialViewerSize,
  maxViewerSize,
  minViewerSize,
  VIEWER_MIN_SIZE
} from './photo-viewer-window';

/** A 1920 x 1080 monitor, the shape most of these cases assume. */
const SCREEN = { width: 1920, height: 1080 };

const STORED = 'data:image/jpeg;base64,STORED';
const SOURCE_PATH = '\\\\NAS\\Coin Pictures\\1881-S Morgan - Obverse.jpg';

/** The same URL builder ApiService uses, so the expectations are realistic. */
const fileUrl = (path: string) => `http://localhost:3000/api/images/file?path=${encodeURIComponent(path)}`;

describe('chooseViewerSource — original file versus stored copy', () => {
  it('shows the ORIGINAL when the backend has confirmed the file is there', () => {
    // This is the case that makes "up to the highest resolution of the
    // picture" mean anything: the stored copy is downscaled, the original is
    // not.
    const view = buildImagePathView(SOURCE_PATH, 'present', fileUrl);

    expect(chooseViewerSource(STORED, view)).toEqual({
      url: fileUrl(SOURCE_PATH),
      kind: 'original'
    });
  });

  it('falls back to the stored copy when the original file has moved', () => {
    const view = buildImagePathView(SOURCE_PATH, 'missing', fileUrl);

    expect(chooseViewerSource(STORED, view)).toEqual({ url: STORED, kind: 'stored' });
  });

  it('falls back to the stored copy while the existence check is UNKNOWN', () => {
    // 'unknown' means the server has not answered (or could not be reached).
    // Pointing an <img> at a URL we are only hoping about would give the user
    // a broken-image icon in place of their photo — strictly worse than the
    // copy we already hold. The viewer re-evaluates when the answer arrives.
    const view = buildImagePathView(SOURCE_PATH, 'unknown', fileUrl);

    expect(chooseViewerSource(STORED, view)).toEqual({ url: STORED, kind: 'stored' });
  });

  it('falls back to the stored copy when no original path was ever recorded', () => {
    // Every photo added by drag-and-drop is in this state, as is anything
    // imported before source paths were tracked. It is the normal case, not
    // an error.
    const view = buildImagePathView(null, 'unknown', fileUrl);

    expect(chooseViewerSource(STORED, view)).toEqual({ url: STORED, kind: 'stored' });
  });

  it('falls back when the component passes null (its "the original 404d" signal)', () => {
    expect(chooseViewerSource(STORED, null)).toEqual({ url: STORED, kind: 'stored' });
  });
});

describe('initialViewerSize — "about 1/2 the display"', () => {
  it('fits a big camera original inside half the screen, keeping its shape', () => {
    // 4032 x 3024 (4:3) into a 960 x 540 box: the HEIGHT is the binding
    // constraint, so the window ends up 540 tall and 720 wide — half the
    // display's height, and the photo's own proportions, so the image fills
    // the window with no letterboxing on opening.
    const size = initialViewerSize({ width: 4032, height: 3024 }, SCREEN);

    expect(size).toEqual({ width: 720, height: 540 });
    expect(size.height).toBe(SCREEN.height / 2);
  });

  it('is bound by the WIDTH for a very wide photo', () => {
    // 3000 x 1000 into 960 x 540: width binds first, giving 960 x 320.
    expect(initialViewerSize({ width: 3000, height: 1000 }, SCREEN))
      .toEqual({ width: 960, height: 320 });
  });

  it('never enlarges a photo that is already smaller than half the screen', () => {
    // The scale is capped at 1. Blowing a 400 x 300 photo up to half a
    // 1920-wide monitor would just be a blurry rectangle, and it would also
    // contradict the maximum, which is the photo's native size.
    expect(initialViewerSize({ width: 400, height: 300 }, SCREEN))
      .toEqual({ width: 400, height: 300 });
  });

  it('falls back to a plain half-screen box before the image has loaded', () => {
    // naturalWidth/naturalHeight are 0 until the image loads, and the window
    // still has to have a size in the meantime.
    expect(initialViewerSize(null, SCREEN)).toEqual({ width: 960, height: 540 });
    expect(initialViewerSize({ width: 0, height: 0 }, SCREEN)).toEqual({ width: 960, height: 540 });
  });

  it('honours a different fraction, so "a bit bigger" is one number', () => {
    expect(initialViewerSize({ width: 4000, height: 4000 }, SCREEN, 0.9))
      .toEqual({ width: 972, height: 972 });
  });
});

describe('maxViewerSize — "up to the highest resolution of the picture"', () => {
  it('is the image\'s native pixel size, even when that exceeds the screen', () => {
    // Deliberately NOT clamped to the viewport. A camera original is bigger
    // than the monitor, and being able to grow out to its real resolution is
    // the entire feature; the backdrop scrolls to reach the rest.
    expect(maxViewerSize({ width: 4032, height: 3024 }))
      .toEqual({ width: 4032, height: 3024 });
  });

  it('caps a fallback stored copy at ITS native size, which is much smaller', () => {
    // The promise the owner cares about: no stretching a 600px image to
    // 4000px and wondering why it went soft. Nothing special implements this
    // — the cap is simply the natural size of whatever actually loaded, so
    // the fallback caps itself.
    expect(maxViewerSize({ width: 600, height: 450 }))
      .toEqual({ width: 600, height: 450 });
  });

  it('is null until the image has reported a size', () => {
    expect(maxViewerSize(null)).toBeNull();
    expect(maxViewerSize({ width: 0, height: 0 })).toBeNull();
  });
});

describe('minViewerSize — a floor that can never cross the ceiling', () => {
  it('is the flat minimum for any normally sized photo', () => {
    expect(minViewerSize({ width: 4032, height: 3024 }))
      .toEqual({ width: VIEWER_MIN_SIZE, height: VIEWER_MIN_SIZE });
  });

  it('drops below the flat minimum for a photo smaller than it', () => {
    // If it did not, CSS min-width would beat max-width and the window would
    // be STUCK larger than the image's native resolution — the one thing this
    // module promises cannot happen.
    const natural = { width: 120, height: 90 };

    expect(minViewerSize(natural)).toEqual({ width: 120, height: 90 });
    expect(minViewerSize(natural).width).toBeLessThanOrEqual(maxViewerSize(natural)!.width);
    expect(minViewerSize(natural).height).toBeLessThanOrEqual(maxViewerSize(natural)!.height);
  });
});

describe('describeViewerSource — telling the user which copy this is', () => {
  it('names the original and its resolution', () => {
    expect(describeViewerSource('original', { width: 4032, height: 3024 }))
      .toBe('Original file — 4032 × 3024');
  });

  it('says the stored copy is the stored copy, once, without nagging', () => {
    expect(describeViewerSource('stored', { width: 1600, height: 1200 }))
      .toBe('Stored copy — 1600 × 1200 (original file not available)');
  });

  it('omits the dimensions until they are known', () => {
    expect(describeViewerSource('original', null)).toBe('Original file');
  });
});
