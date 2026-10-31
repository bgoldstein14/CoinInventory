import { describe, expect, it } from 'vitest';
import {
  computeScaledSize,
  dataUrlByteLength,
  JPEG_QUALITY,
  MAX_LONG_EDGE
} from './image-downscaler';

/**
 * These tests cover the RESIZE MATHS, which is the part that decides how much
 * data ends up in SQL Server. The canvas drawing itself needs a real browser
 * and is verified by eye; the maths is pure and is pinned down here.
 */
describe('computeScaledSize', () => {
  it('caps the long edge at 1600px for a landscape photo', () => {
    // 4000x3000 -> scale 0.4 -> 1600x1200, aspect ratio preserved.
    const result = computeScaledSize(4000, 3000);
    expect(result).toEqual({ width: 1600, height: 1200, resized: true });
    expect(Math.max(result.width, result.height)).toBe(MAX_LONG_EDGE);
  });

  it('caps the long edge at 1600px for a portrait photo', () => {
    const result = computeScaledSize(3000, 4000);
    expect(result).toEqual({ width: 1200, height: 1600, resized: true });
    expect(Math.max(result.width, result.height)).toBe(MAX_LONG_EDGE);
  });

  it('caps a square photo on both edges', () => {
    expect(computeScaledSize(5000, 5000)).toEqual({ width: 1600, height: 1600, resized: true });
  });

  it('leaves an already-small image completely alone (never upscales)', () => {
    expect(computeScaledSize(1200, 900)).toEqual({ width: 1200, height: 900, resized: false });
    expect(computeScaledSize(320, 240)).toEqual({ width: 320, height: 240, resized: false });
  });

  it('treats exactly 1600px as already small enough', () => {
    expect(computeScaledSize(1600, 1200)).toEqual({ width: 1600, height: 1200, resized: false });
  });

  it('resizes an image that is one pixel over the cap', () => {
    const result = computeScaledSize(1601, 1601);
    expect(result.resized).toBe(true);
    expect(Math.max(result.width, result.height)).toBe(1600);
  });

  it('preserves the aspect ratio of an extreme panorama without a zero edge', () => {
    // 46 MP panorama: the short edge would round to 0 without the floor.
    const result = computeScaledSize(20000, 30);
    expect(result.width).toBe(1600);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it('honours a custom max edge', () => {
    expect(computeScaledSize(4000, 2000, 800)).toEqual({ width: 800, height: 400, resized: true });
  });

  it('survives a failed decode reporting zero or NaN dimensions', () => {
    // A 1x1 keeps canvas.toDataURL() from throwing; the caller records the
    // file as a failure rather than taking the whole batch down.
    expect(computeScaledSize(0, 0)).toEqual({ width: 1, height: 1, resized: false });
    expect(computeScaledSize(Number.NaN, 100)).toEqual({ width: 1, height: 1, resized: false });
    expect(computeScaledSize(-5, 10)).toEqual({ width: 1, height: 1, resized: false });
  });

  it('uses a quality setting that trades bytes for imperceptible loss', () => {
    expect(JPEG_QUALITY).toBeGreaterThanOrEqual(0.8);
    expect(JPEG_QUALITY).toBeLessThanOrEqual(0.9);
  });
});

describe('dataUrlByteLength', () => {
  it('converts base64 characters back to a byte count', () => {
    // "abc" -> "YWJj" : 4 characters, no padding, 3 bytes.
    expect(dataUrlByteLength('data:image/jpeg;base64,YWJj')).toBe(3);
    // "ab" -> "YWI=" : one pad character, 2 bytes.
    expect(dataUrlByteLength('data:image/jpeg;base64,YWI=')).toBe(2);
    // "a" -> "YQ==" : two pad characters, 1 byte.
    expect(dataUrlByteLength('data:image/jpeg;base64,YQ==')).toBe(1);
  });

  it('returns 0 for something that is not a data URL', () => {
    expect(dataUrlByteLength('not-a-data-url')).toBe(0);
  });
});
