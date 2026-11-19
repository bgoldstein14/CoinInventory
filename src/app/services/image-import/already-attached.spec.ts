 /*
 * Re-importing a folder must skip photos already attached to the coin. The
 * index is built from POST /api/coins/image-source-paths data, so no HTTP or
 * DOM is needed.
  */

import { describe, expect, it } from 'vitest';
import {
  MAX_COINS_PER_SOURCE_PATH_REQUEST,
  buildAttachedPathIndex,
  chunkCoinIds,
  isAlreadyAttached
} from './already-attached';

describe('buildAttachedPathIndex', () => {
  it('indexes each coin s recorded paths in their comparison form', () => {
    const index = buildAttachedPathIndex({
      morgan: ['D:\\Coin Pictures\\Morgan Obverse.jpg'],
      peace: []
    });

    expect(index.has('morgan')).toBe(true);
    expect(index.has('peace')).toBe(true);
    // Stored lower-cased, because the comparison is case-insensitive.
    expect([...index.get('morgan')!]).toEqual(['d:\\coin pictures\\morgan obverse.jpg']);
    expect([...index.get('peace')!]).toEqual([]);
  });

  it('drops null and blank paths instead of indexing them', () => {
    // Indexing "" would make every path-less candidate look already attached.
    const index = buildAttachedPathIndex({
      morgan: ['', '   ', 'D:\\pics\\a.jpg']
    });

    expect([...index.get('morgan')!]).toEqual(['d:\\pics\\a.jpg']);
  });

  it('is empty for a coin nobody asked about', () => {
    const index = buildAttachedPathIndex({ morgan: ['D:\\pics\\a.jpg'] });
    expect(index.has('peace')).toBe(false);
  });
});

describe('chunkCoinIds', () => {
  it('keeps a request under the server s cap', () => {
    // Over the cap the server returns 400, and the lookup fails open.
    const ids = Array.from({ length: MAX_COINS_PER_SOURCE_PATH_REQUEST + 1 }, (_, i) => `c${i}`);
    const chunks = chunkCoinIds(ids);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_COINS_PER_SOURCE_PATH_REQUEST);
    expect(chunks[1]).toEqual([`c${MAX_COINS_PER_SOURCE_PATH_REQUEST}`]);
  });

  it('makes one batch of a list that fits, and none of an empty one', () => {
    expect(chunkCoinIds(['a', 'b'])).toEqual([['a', 'b']]);
    expect(chunkCoinIds([])).toEqual([]);
  });

  it('loses nothing and reorders nothing', () => {
    const ids = Array.from({ length: 7 }, (_, i) => `c${i}`);
    expect(chunkCoinIds(ids, 3).flat()).toEqual(ids);
  });
});

describe('isAlreadyAttached', () => {
  const index = buildAttachedPathIndex({
    morgan: ['D:\\Coin Pictures\\Business Strikes\\1881-S Morgan - Obverse.jpg'],
    peace: []
  });

  it('recognises the identical path', () => {
    expect(
      isAlreadyAttached(index, 'morgan', 'D:\\Coin Pictures\\Business Strikes\\1881-S Morgan - Obverse.jpg')
    ).toBe(true);
  });

  it('recognises the same file written with different case', () => {
    expect(
      isAlreadyAttached(index, 'morgan', 'd:\\coin pictures\\business strikes\\1881-s morgan - obverse.JPG')
    ).toBe(true);
  });

  it('recognises the same file written with forward slashes', () => {
    expect(
      isAlreadyAttached(index, 'morgan', 'D:/Coin Pictures/Business Strikes/1881-S Morgan - Obverse.jpg')
    ).toBe(true);
  });

  it('recognises the same file written with a doubled separator', () => {
    // Rows written before stripTrailingSeparators() existed still hold these.
    expect(
      isAlreadyAttached(index, 'morgan', 'D:\\Coin Pictures\\\\Business Strikes\\1881-S Morgan - Obverse.jpg')
    ).toBe(true);
  });

  it('does not match a different file in the same folder', () => {
    expect(
      isAlreadyAttached(index, 'morgan', 'D:\\Coin Pictures\\Business Strikes\\1881-S Morgan - Reverse.jpg')
    ).toBe(false);
  });

  it('does not match the same filename under a different folder', () => {
    expect(
      isAlreadyAttached(index, 'morgan', 'D:\\Coin Pictures\\Proofs\\1881-S Morgan - Obverse.jpg')
    ).toBe(false);
  });

  it('does not match a path belonging to a DIFFERENT coin', () => {
    // The same photo may legitimately attach to two coins.
    expect(
      isAlreadyAttached(index, 'peace', 'D:\\Coin Pictures\\Business Strikes\\1881-S Morgan - Obverse.jpg')
    ).toBe(false);
  });

  it('never matches when the candidate has no path at all', () => {
    // Imports without a base folder record a null path; unknown means attach.
    expect(isAlreadyAttached(index, 'morgan', null)).toBe(false);
    expect(isAlreadyAttached(index, 'morgan', '')).toBe(false);
    expect(isAlreadyAttached(index, 'morgan', '   ')).toBe(false);
  });

  it('answers false for a coin the index knows nothing about', () => {
    // Fails open: if the lookup couldn't run, every photo is attached.
    expect(isAlreadyAttached(index, 'unknown-coin', 'D:\\pics\\a.jpg')).toBe(false);
    expect(isAlreadyAttached(new Map(), 'morgan', 'D:\\pics\\a.jpg')).toBe(false);
  });
});
