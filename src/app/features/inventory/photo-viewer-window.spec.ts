/**
 * Tests for the photo window's sizing arithmetic and its choice between the
 * original file and the stored copy. The CSS resize itself can't be tested
 * without a DOM; the numbers fed to it can.
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
    // 'unknown' = the server has not answered; avoid a broken-image icon.
    const view = buildImagePathView(SOURCE_PATH, 'unknown', fileUrl);

    expect(chooseViewerSource(STORED, view)).toEqual({ url: STORED, kind: 'stored' });
  });

  it('falls back to the stored copy when no original path was ever recorded', () => {
    // The normal case for drag-and-drop photos.
    const view = buildImagePathView(null, 'unknown', fileUrl);

    expect(chooseViewerSource(STORED, view)).toEqual({ url: STORED, kind: 'stored' });
  });

  it('falls back when the component passes null (its "the original 404d" signal)', () => {
    expect(chooseViewerSource(STORED, null)).toEqual({ url: STORED, kind: 'stored' });
  });
});

describe('initialViewerSize — "about 1/2 the display"', () => {
  it('fits a big camera original inside half the screen, keeping its shape', () => {
    // 4032 x 3024 (4:3) into a 960 x 540 box: height binds, giving 720 x 540.
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
    // Scale is capped at 1.
    expect(initialViewerSize({ width: 400, height: 300 }, SCREEN))
      .toEqual({ width: 400, height: 300 });
  });

  it('falls back to a plain half-screen box before the image has loaded', () => {
    // naturalWidth/naturalHeight are 0 until the image loads.
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
    // Not clamped to the viewport; the backdrop scrolls.
    expect(maxViewerSize({ width: 4032, height: 3024 }))
      .toEqual({ width: 4032, height: 3024 });
  });

  it('caps a fallback stored copy at ITS native size, which is much smaller', () => {
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
    // Otherwise CSS min-width would beat max-width.
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
