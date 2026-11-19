/**
 * Unit tests for the image payload normalizer, which every write path uses.
 * The bare-string form must keep working.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeImageEntry,
  normalizeImageEntries,
  normalizeSourcePath,
} from './image-payload';

describe('normalizeImageEntry', () => {
  it('treats a bare base64 string as an image with no known source path', () => {
    // The bare-string form.
    expect(normalizeImageEntry('data:image/png;base64,abc')).toEqual({
      imageData: 'data:image/png;base64,abc',
      sourcePath: null,
    });
  });

  it('reads imageData and sourcePath out of the object form', () => {
    expect(
      normalizeImageEntry({
        imageData: 'data:image/jpeg;base64,abc',
        sourcePath: 'C:\\Coin Pictures\\a.jpg',
      })
    ).toEqual({ imageData: 'data:image/jpeg;base64,abc', sourcePath: 'C:\\Coin Pictures\\a.jpg' });
  });

  it('accepts `image` and `data` as aliases for imageData', () => {
    // Aliases for imageData.
    expect(normalizeImageEntry({ image: 'x' })?.imageData).toBe('x');
    expect(normalizeImageEntry({ data: 'y' })?.imageData).toBe('y');
  });

  it('returns null for anything that carries neither a picture nor a path', () => {
    // `{ sourcePath }` alone is a referenced photo now, so it isn't junk.
    for (const junk of [null, undefined, '', 0, 42, true, [], {}, { imageData: '' }]) {
      expect(normalizeImageEntry(junk)).toBeNull();
    }
  });
});

/*
 * Referenced photos: the database must not end up with the picture, and an
 * entry with neither picture nor path must not be stored.
 */
describe('normalizeImageEntry — referenced photographs', () => {
  const REFERENCE = '/api/images/file?path=C%3A%5Cpics%5Ca.jpg';
  const ABSOLUTE = `http://localhost:3000${REFERENCE}`;

  it('stores a path and NO picture when the entry is a reference URL', () => {
    // The URL must not fall through to the bare-string branch and land in ImageData.
    expect(normalizeImageEntry(REFERENCE)).toEqual({
      imageData: null,
      sourcePath: 'C:\\pics\\a.jpg'
    });
  });

  it('recognises the reference with an origin in front of it', () => {
    // The client sends an absolute URL (a relative one would hit the dev server).
    expect(normalizeImageEntry(ABSOLUTE)).toEqual({
      imageData: null,
      sourcePath: 'C:\\pics\\a.jpg'
    });
  });

  it('takes the reference in object form too, and prefers the supplied path', () => {
    expect(
      normalizeImageEntry({ imageData: ABSOLUTE, sourcePath: '\\\\nas\\pics\\b.jpg' })
    ).toEqual({ imageData: null, sourcePath: '\\\\nas\\pics\\b.jpg' });
  });

  it('treats "a path and no picture" as referenced', () => {
    expect(normalizeImageEntry({ sourcePath: 'C:\\a.jpg' })).toEqual({
      imageData: null,
      sourcePath: 'C:\\a.jpg'
    });
    expect(normalizeImageEntry({ imageData: null, sourcePath: 'C:\\a.jpg' })).toEqual({
      imageData: null,
      sourcePath: 'C:\\a.jpg'
    });
  });

  it('refuses a reference that points nowhere', () => {
    // Neither picture nor location: dropped, like other unusable entries.
    expect(normalizeImageEntry('/api/images/file?path=')).toBeNull();
    expect(normalizeImageEntry({ imageData: '/api/images/file?path=', sourcePath: '  ' })).toBeNull();
  });

  it('never mistakes a stored data URL for a reference', () => {
    expect(normalizeImageEntry('data:image/jpeg;base64,abc')).toEqual({
      imageData: 'data:image/jpeg;base64,abc',
      sourcePath: null
    });
  });
});

describe('normalizeSourcePath', () => {
  it('trims surrounding whitespace', () => {
    // Paths pasted from Explorer often have a trailing space.
    expect(normalizeSourcePath('  C:\\pics\\a.jpg  ')).toBe('C:\\pics\\a.jpg');
  });

  it('collapses every flavour of "unknown" to null', () => {
    // One representation of "unknown".
    for (const empty of ['', '   ', undefined, null, 42, {}]) {
      expect(normalizeSourcePath(empty)).toBeNull();
    }
  });
});

describe('normalizeImageEntries', () => {
  it('handles a mixed legacy/new array in order', () => {
    expect(
      normalizeImageEntries([
        'data:image/png;base64,legacy',
        { imageData: 'data:image/png;base64,new', sourcePath: 'C:\\pics\\b.png' },
      ])
    ).toEqual([
      { imageData: 'data:image/png;base64,legacy', sourcePath: null },
      { imageData: 'data:image/png;base64,new', sourcePath: 'C:\\pics\\b.png' },
    ]);
  });

  it('drops unusable entries so SortOrder stays gap-free', () => {
    expect(normalizeImageEntries(['a', '', null, 'b'])).toEqual([
      { imageData: 'a', sourcePath: null },
      { imageData: 'b', sourcePath: null },
    ]);
  });

  it('returns an empty array for a missing or non-array argument', () => {
    // Callers pass body.imagePaths unguarded.
    expect(normalizeImageEntries(undefined)).toEqual([]);
    expect(normalizeImageEntries(null)).toEqual([]);
    expect(normalizeImageEntries('not an array')).toEqual([]);
  });
});
