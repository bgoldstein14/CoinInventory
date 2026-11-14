/**
 * routes/images/reference-url.spec.ts
 *
 * The reference URL is the whole of the wire format for the REFERENCED
 * storage mode: a photograph the database holds the location of and not the
 * picture of. Two properties matter and both are pinned here.
 *
 *   1. A ROUND TRIP IS LOSSLESS. Whatever path goes in comes back out —
 *      Windows backslashes, spaces, UNC prefixes, `&` and `#` in filenames.
 *      A lossy round trip would re-point a photograph at a file that does
 *      not exist, on an ordinary coin save.
 *   2. THE ORIGIN IS NOT PART OF THE IDENTITY. The client builds the
 *      absolute form (a relative URL would 404 under `ng serve`), older
 *      payloads carry the relative one, and both have to be understood as
 *      the same reference.
 */

import { describe, it, expect } from 'vitest';
import {
  IMAGE_REFERENCE_ROUTE,
  isImageReferenceUrl,
  originFromRequest,
  referenceUrlFor,
  sourcePathFromReferenceUrl
} from './reference-url';

describe('referenceUrlFor', () => {
  it('encodes a Windows path so nothing truncates the query string', () => {
    const url = referenceUrlFor('C:\\Coin Pictures\\1921 morgan & friends#2.jpg');

    // The raw characters that would break a query string must not survive.
    expect(url.startsWith(IMAGE_REFERENCE_ROUTE)).toBe(true);
    expect(url).not.toContain('\\');
    expect(url).not.toContain(' ');
    expect(url.slice(IMAGE_REFERENCE_ROUTE.length)).not.toContain('&');
    expect(url.slice(IMAGE_REFERENCE_ROUTE.length)).not.toContain('#');
  });

  it('puts the origin in front when one is known', () => {
    expect(referenceUrlFor('C:\\a.jpg', 'http://localhost:3000')).toBe(
      `http://localhost:3000${IMAGE_REFERENCE_ROUTE}C%3A%5Ca.jpg`
    );
  });
});

describe('sourcePathFromReferenceUrl', () => {
  for (const path of [
    'C:\\Coin Pictures\\1921 morgan.jpg',
    '\\\\NAS\\Coin Pictures\\sub folder\\a & b #3.jpeg',
    'D:/forward/slashes.png'
  ]) {
    it(`round-trips ${path}`, () => {
      expect(sourcePathFromReferenceUrl(referenceUrlFor(path))).toBe(path);
      expect(sourcePathFromReferenceUrl(referenceUrlFor(path, 'http://host:3000'))).toBe(path);
    });
  }

  it('is null for anything that is not a reference', () => {
    for (const other of [
      'data:image/jpeg;base64,abc',
      '',
      null,
      undefined,
      42,
      '/api/coins/1/thumbnail'
    ]) {
      expect(sourcePathFromReferenceUrl(other)).toBeNull();
    }
  });

  it('is null for a reference with an empty or malformed path', () => {
    expect(sourcePathFromReferenceUrl(`${IMAGE_REFERENCE_ROUTE}`)).toBeNull();
    expect(sourcePathFromReferenceUrl(`${IMAGE_REFERENCE_ROUTE}%20%20`)).toBeNull();
    // A lone '%' is not a valid escape; decodeURIComponent throws on it, and
    // a throw here would become a 500 in the middle of saving a coin.
    expect(sourcePathFromReferenceUrl(`${IMAGE_REFERENCE_ROUTE}%zz`)).toBeNull();
  });
});

describe('isImageReferenceUrl', () => {
  it('recognises both the relative and the absolute form', () => {
    expect(isImageReferenceUrl('/api/images/file?path=C%3A%5Ca.jpg')).toBe(true);
    expect(isImageReferenceUrl('http://localhost:3000/api/images/file?path=C%3A%5Ca.jpg')).toBe(true);
  });

  it('never mistakes a stored picture for a reference', () => {
    expect(isImageReferenceUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(false);
  });
});

describe('originFromRequest', () => {
  it('builds protocol://host from the request that asked', () => {
    expect(originFromRequest({ protocol: 'http', get: () => 'localhost:3000' })).toBe(
      'http://localhost:3000'
    );
  });

  it('falls back to the relative form when there is no Host header', () => {
    // http/1.1 forbids it, but a hand-rolled client can still omit it, and a
    // reference of "undefined/api/…" would be worse than a relative one.
    expect(originFromRequest({ protocol: 'http', get: () => undefined })).toBe('');
    expect(originFromRequest({})).toBe('');
  });
});
