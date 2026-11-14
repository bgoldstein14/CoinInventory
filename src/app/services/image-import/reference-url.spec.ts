/**
 * Tests for the client half of the reference URL.
 *
 * It is duplicated on the server (server/routes/images/reference-url.ts)
 * because the browser and Node share no module here. The duplication is
 * five lines of string handling, and THE TWO HALVES MUST AGREE: the client
 * builds the reference during an import, the server parses it back into a
 * path when the coin is saved. These tests use the same cases as the server
 * spec for exactly that reason.
 */
import { describe, expect, it } from 'vitest';
import {
  IMAGE_REFERENCE_ROUTE,
  isImageReferenceUrl,
  referenceUrlForPath,
  sourcePathFromReferenceUrl
} from './reference-url';

describe('referenceUrlForPath', () => {
  it('encodes the characters that would otherwise break the query string', () => {
    const url = referenceUrlForPath('C:\\Coin Pictures\\a & b #3.jpg');

    expect(url.startsWith(IMAGE_REFERENCE_ROUTE)).toBe(true);
    expect(url).not.toContain(' ');
    expect(url).not.toContain('\\');
    expect(url.slice(IMAGE_REFERENCE_ROUTE.length)).not.toContain('&');
  });
});

describe('sourcePathFromReferenceUrl', () => {
  for (const path of [
    'C:\\Coin Pictures\\1921 morgan.jpg',
    '\\\\NAS\\Coin Pictures\\sub folder\\a & b #3.jpeg',
    'D:/forward/slashes.png'
  ]) {
    it(`round-trips ${path}`, () => {
      expect(sourcePathFromReferenceUrl(referenceUrlForPath(path))).toBe(path);
    });
  }

  it('reads the absolute form the API service builds', () => {
    const absolute = `http://localhost:3000${referenceUrlForPath('C:\\a.jpg')}`;
    expect(sourcePathFromReferenceUrl(absolute)).toBe('C:\\a.jpg');
  });

  it('is null for a stored picture, and for junk', () => {
    for (const other of ['data:image/jpeg;base64,abc', '', null, undefined, 42]) {
      expect(sourcePathFromReferenceUrl(other)).toBeNull();
      expect(isImageReferenceUrl(other)).toBe(false);
    }
  });

  it('never throws on a malformed escape', () => {
    // A mangled reference means "no path known", never an exception in the
    // middle of a save.
    expect(sourcePathFromReferenceUrl(`${IMAGE_REFERENCE_ROUTE}%zz`)).toBeNull();
  });
});
