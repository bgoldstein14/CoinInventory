/**
 * image-thumbnail.spec.ts
 *
 * Only the arithmetic is tested. The canvas work around it cannot be — there
 * is no jsdom here, and no canvas in Node — so it is kept to the handful of
 * lines that genuinely need a browser, and the decision that governs the
 * output size lives in this pure function instead.
 */
import { describe, expect, it } from 'vitest';
import { thumbnailSize } from './image-thumbnail';
import { THUMBNAIL_MAX_EDGE_PX } from './report-images';

describe('thumbnailSize', () => {
  it('shrinks a landscape image to the cap on its long edge', () => {
    expect(thumbnailSize(1600, 1200, 480)).toEqual({ width: 480, height: 360 });
  });

  it('shrinks a portrait image to the cap on its long edge', () => {
    expect(thumbnailSize(1200, 1600, 480)).toEqual({ width: 360, height: 480 });
  });

  it('shrinks a square image on both edges at once', () => {
    expect(thumbnailSize(1600, 1600, 480)).toEqual({ width: 480, height: 480 });
  });

  it('NEVER enlarges an image that is already small', () => {
    // Scaling a 200px photo up to 480 would make the file bigger and the
    // picture no clearer — the exact opposite of what this is for.
    expect(thumbnailSize(200, 150, 480)).toEqual({ width: 200, height: 150 });
  });

  it('never rounds an edge down to zero', () => {
    // A canvas of width 0 throws. A 2000x1 image is absurd but a corrupt
    // record can produce one, and it must not take the whole report down.
    const size = thumbnailSize(2000, 1, 480);
    expect(size.width).toBe(480);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the cap when the browser reports no dimensions', () => {
    expect(thumbnailSize(0, 0, 480)).toEqual({ width: 480, height: 480 });
  });

  it('defaults to the report-wide cap', () => {
    expect(thumbnailSize(1600, 1600)).toEqual({
      width: THUMBNAIL_MAX_EDGE_PX, height: THUMBNAIL_MAX_EDGE_PX
    });
  });
});
