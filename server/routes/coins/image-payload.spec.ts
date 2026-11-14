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

  it('returns null for anything that carries neither a picture nor a path', () => {
    // `{ sourcePath }` is DELIBERATELY not in this list any more: an entry
    // with a path and no picture is now a REFERENCED photograph, which is a
    // real thing to store. See the referenced describe block below.
    for (const junk of [null, undefined, '', 0, 42, true, [], {}, { imageData: '' }]) {
      expect(normalizeImageEntry(junk)).toBeNull();
    }
  });
});

/*
 * REFERENCED PHOTOGRAPHS — "store where it is, not what it looks like".
 *
 * The user picks the mode in Settings. These tests pin the two things that
 * make it a real mode rather than a label: the database must not end up with
 * the picture, and nothing may be stored that has neither a picture nor a
 * path (that would be a photograph silently thrown away).
 */
describe('normalizeImageEntry — referenced photographs', () => {
  const REFERENCE = '/api/images/file?path=C%3A%5Cpics%5Ca.jpg';
  const ABSOLUTE = `http://localhost:3000${REFERENCE}`;

  it('stores a path and NO picture when the entry is a reference URL', () => {
    // THE MUTATION THIS CATCHES: letting the URL fall through to the
    // bare-string branch, which would write the URL text into ImageData and
    // make "referenced" a lie.
    expect(normalizeImageEntry(REFERENCE)).toEqual({
      imageData: null,
      sourcePath: 'C:\\pics\\a.jpg'
    });
  });

  it('recognises the reference with an origin in front of it', () => {
    // The client builds the absolute form, because a relative URL would be
    // fetched from the dev server (:4200) rather than the API (:3000).
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
    // Neither a picture nor a location. Storing the row would lose the
    // photograph quietly; dropping it is what every other unusable entry
    // gets, and the import reports it.
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
