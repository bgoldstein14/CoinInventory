/**
 * Tests for how one image's original-file path is rendered.
 *
 * The three states are what the user actually asked for: a clickable link
 * while the file is there, the same text in a different colour and NOT
 * clickable once it is gone, and nothing at all when no path was recorded.
 *
 * These assert the render model rather than poking at real DOM nodes: the
 * frontend test suite runs in Node with no browser, and the template is a
 * direct, type-checked projection of this object (the template itself is
 * validated by `ng build`).
 */
import { describe, expect, it } from 'vitest';
import { buildImagePathView, middleEllipsis, PATH_DISPLAY_LIMIT } from './image-path-display';

/** Stands in for ApiService.imageFileUrl, with its real encoding rules. */
const fileUrl = (path: string) =>
  `http://localhost:3000/api/images/file?path=${encodeURIComponent(path)}`;

const SHORT_PATH = 'C:\\Pics\\a.jpg';

describe('buildImagePathView — file is present', () => {
  const view = buildImagePathView(SHORT_PATH, 'present', fileUrl);

  it('renders as a link', () => {
    expect(view.hasPath).toBe(true);
    expect(view.isLink).toBe(true);
  });

  it('points at the backend route with the path URL-encoded', () => {
    // NOT a file:/// URL: Chrome and Edge silently block navigation from an
    // http page to a file URL, so the click would appear to do nothing.
    // Encoding matters because a Windows path has backslashes and spaces.
    expect(view.fileUrl).toBe(
      'http://localhost:3000/api/images/file?path=C%3A%5CPics%5Ca.jpg'
    );
  });

  it('encodes spaces and the UNC leading slashes in a real share path', () => {
    const real = '\\\\192.168.0.10\\Coin Pictures\\1865 3CN - Obverse.jpg';
    const encoded = buildImagePathView(real, 'present', fileUrl).fileUrl!;

    expect(encoded).toContain('%5C%5C192.168.0.10');
    expect(encoded).toContain('Coin%20Pictures');
    // A raw backslash or space in a query string is exactly the kind of thing
    // that quietly truncates a URL.
    expect(encoded).not.toContain(' ');
    expect(encoded).not.toContain('\\');
  });

  it('offers the full path and an explanation as the tooltip', () => {
    expect(view.title).toContain(SHORT_PATH);
    expect(view.title.toLowerCase()).toContain('new tab');
  });
});

describe('buildImagePathView — file is missing', () => {
  const view = buildImagePathView(SHORT_PATH, 'missing', fileUrl);

  it('is not a link at all', () => {
    // No URL is even built, so there is nothing for the template to put in an
    // href — which is what keeps the element unfocusable and un-clickable
    // rather than merely styled to look that way.
    expect(view.isLink).toBe(false);
    expect(view.fileUrl).toBe(null);
  });

  it('still shows the path, because it documents where the file was', () => {
    expect(view.hasPath).toBe(true);
    expect(view.displayPath).toBe(SHORT_PATH);
  });

  it('is flagged as missing so it can be shown in a muted colour', () => {
    expect(view.existence).toBe('missing');
  });

  it('explains in the tooltip that the original has moved', () => {
    expect(view.title).toContain(SHORT_PATH);
    expect(view.title.toLowerCase()).toContain('no longer at this location');
  });
});

describe('buildImagePathView — existence unknown', () => {
  // The backend could not be reached. We know nothing, so we claim nothing.
  const view = buildImagePathView(SHORT_PATH, 'unknown', fileUrl);

  it('shows the path as plain text rather than claiming the file is gone', () => {
    expect(view.hasPath).toBe(true);
    expect(view.displayPath).toBe(SHORT_PATH);
    expect(view.existence).toBe('unknown');
  });

  it('does not offer a link it may not be able to honour', () => {
    expect(view.isLink).toBe(false);
    expect(view.fileUrl).toBe(null);
  });

  it('says why in the tooltip', () => {
    expect(view.title.toLowerCase()).toContain('could not check');
  });
});

describe('buildImagePathView — no path recorded', () => {
  it('renders no affordance at all for null', () => {
    const view = buildImagePathView(null, 'unknown', fileUrl);
    expect(view.hasPath).toBe(false);
    expect(view.displayPath).toBe('');
    expect(view.isLink).toBe(false);
    expect(view.fileUrl).toBe(null);
    expect(view.title).toBe('');
  });

  it('treats undefined and an empty/whitespace path the same way', () => {
    // The server normalises a SQL NULL and a missing column alike to JSON
    // null, and trims blank strings away — but the UI must not depend on that.
    for (const value of [undefined, '', '   ']) {
      expect(buildImagePathView(value, 'present', fileUrl).hasPath).toBe(false);
    }
  });

  it('does not build a link even when told the file is present', () => {
    // Nothing to link to, so "present" is meaningless here.
    expect(buildImagePathView('', 'present', fileUrl).fileUrl).toBe(null);
  });
});

describe('middleEllipsis', () => {
  it('leaves a short path exactly as it is', () => {
    expect(middleEllipsis(SHORT_PATH)).toBe(SHORT_PATH);
  });

  it('shortens a long path from the middle, keeping both ends', () => {
    const long = '\\\\192.168.0.10\\Coin Pictures\\Business Strikes\\1865 3CN - MS60 - Obverse.jpg';
    const short = middleEllipsis(long);

    expect(short.length).toBeLessThanOrEqual(PATH_DISPLAY_LIMIT);
    expect(short).toContain('\u2026');
    // The share is still identifiable...
    expect(short.startsWith('\\\\192.168')).toBe(true);
    // ...and the filename, the part the user actually reads, survives.
    expect(short.endsWith('Obverse.jpg')).toBe(true);
  });

  it('keeps the full path available for the tooltip regardless', () => {
    const long = 'C:\\' + 'x'.repeat(200) + '\\photo.jpg';
    const view = buildImagePathView(long, 'present', fileUrl);

    expect(view.displayPath.length).toBeLessThanOrEqual(PATH_DISPLAY_LIMIT);
    expect(view.sourcePath).toBe(long);
    expect(view.title).toContain(long);
  });
});
