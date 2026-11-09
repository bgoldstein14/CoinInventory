 /*
 * already-attached.spec.ts
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * Adding a few coin images to a folder that has already been imported makes
 * the program try to import every image in it again, even though most of the
 * coins already have images attached.
 *
 * Re-importing a folder where 290 of 300 photos were already attached read,
 * decoded and re-saved all 300. These are the rules that cut that to 10.
 *
 * The thing being tested is deliberately a pure function over plain data: the
 * index is built from what POST /api/coins/image-source-paths returns, so it
 * can be exercised here without an HTTP mock, a browser or a canvas.
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
    // Every image imported before the SourcePath column existed has no path.
    // Indexing those as an empty string would make every path-less candidate
    // look "already attached" and silently skip real photos.
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
    // The server rejects more than MAX_COIN_IDS_PER_REQUEST with a 400, and
    // because this lookup fails open a 400 means "import everything again" —
    // the original bug, triggered by exactly the largest imports.
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
    // The library has an "Obverse" shot in nearly every subfolder, so a
    // filename-only comparison would skip hundreds of genuinely new photos.
    expect(
      isAlreadyAttached(index, 'morgan', 'D:\\Coin Pictures\\Proofs\\1881-S Morgan - Obverse.jpg')
    ).toBe(false);
  });

  it('does not match a path belonging to a DIFFERENT coin', () => {
    // The question is "already on THIS coin", not "already in the database".
    // The same photo legitimately attaches to two coins.
    expect(
      isAlreadyAttached(index, 'peace', 'D:\\Coin Pictures\\Business Strikes\\1881-S Morgan - Obverse.jpg')
    ).toBe(false);
  });

  it('never matches when the candidate has no path at all', () => {
    // An import with no base folder records sourcePath: null for everything.
    // That is a legitimate, long-standing mode, and "unknown" must mean
    // "attach it", not "we have seen it before".
    expect(isAlreadyAttached(index, 'morgan', null)).toBe(false);
    expect(isAlreadyAttached(index, 'morgan', '')).toBe(false);
    expect(isAlreadyAttached(index, 'morgan', '   ')).toBe(false);
  });

  it('answers false for a coin the index knows nothing about', () => {
    // FAILING OPEN IS THE RULE HERE. If the bulk lookup could not run, the
    // index is empty and every photo is attached — exactly the behaviour the
    // import had before this feature. Skipping photos on no evidence would be
    // data loss dressed up as a convenience.
    expect(isAlreadyAttached(index, 'unknown-coin', 'D:\\pics\\a.jpg')).toBe(false);
    expect(isAlreadyAttached(new Map(), 'morgan', 'D:\\pics\\a.jpg')).toBe(false);
  });
});
