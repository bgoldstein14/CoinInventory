/**
 * routes/coins/image-payload.spec.ts — unit tests for the image payload
 * normalizer (routes/coins/image-payload.ts).
 *
 * This is the one place that decides what "an image" sent by the client means,
 * and all three write paths funnel through it (POST /api/coins,
 * PUT /api/coins/:id, POST /api/coins/:id/images). The bare-string form is the
 * compatibility path the un-migrated Angular client still uses, so the tests
 * covering it are regression guards rather than ordinary coverage.
 *
 * No mocks needed: these are pure functions with no database involvement.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeImageEntry,
  normalizeImageEntries,
  normalizeSourcePath,
} from './image-payload';

describe('normalizeImageEntry', () => {
  it('treats a bare base64 string as an image with no known source path', () => {
    // *** THE COMPATIBILITY PATH *** — what the current client sends.
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
    // A gradually-migrating client might reasonably reach for either name;
    // accepting them avoids a confusing silent skip.
    expect(normalizeImageEntry({ image: 'x' })?.imageData).toBe('x');
    expect(normalizeImageEntry({ data: 'y' })?.imageData).toBe('y');
  });

  it('returns null for anything that carries no usable image data', () => {
    for (const junk of [null, undefined, '', 0, 42, true, [], {}, { sourcePath: 'C:\\a.jpg' }]) {
      expect(normalizeImageEntry(junk)).toBeNull();
    }
  });
});

describe('normalizeSourcePath', () => {
  it('trims surrounding whitespace', () => {
    // Paths pasted out of Explorer often arrive with a trailing space.
    expect(normalizeSourcePath('  C:\\pics\\a.jpg  ')).toBe('C:\\pics\\a.jpg');
  });

  it('collapses every flavour of "unknown" to null', () => {
    // One representation of "we do not know where the original is", not two.
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
    // Callers write `normalizeImageEntries(body.imagePaths)` with no guard of
    // their own, so undefined has to be safe.
    expect(normalizeImageEntries(undefined)).toEqual([]);
    expect(normalizeImageEntries(null)).toEqual([]);
    expect(normalizeImageEntries('not an array')).toEqual([]);
  });
});
