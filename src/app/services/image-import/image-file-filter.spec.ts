import { describe, expect, it } from 'vitest';
import {
  fileExtension,
  filterImageFiles,
  isDisplayableImage,
  tallySkipReasons
} from './image-file-filter';

/** Minimal File stand-in: the filter only ever looks at `name`. */
function file(name: string, size = 1024): File {
  return new File(['x'], name, { type: 'application/octet-stream' });
  // NOTE: `size` is intentionally unused - the filter must NOT read the file,
  // which is the whole point of doing this step before anything expensive.
}

describe('image-file-filter', () => {
  it('keeps every web-displayable raster extension, case-insensitively', () => {
    const names = [
      'a.jpg', 'b.JPEG', 'c.png', 'd.WEBP', 'e.gif', 'f.bmp',
      '1880-S $1 - MS64 - Obverse - Photo.JPG'
    ];
    const result = filterImageFiles(names.map(n => file(n)));

    expect(result.accepted.map(f => f.name)).toEqual(names);
    expect(result.skipped).toEqual([]);
  });

  it('excludes RAW camera files the browser cannot render', () => {
    const result = filterImageFiles([
      file('2011 ATB - Vicksburg - Obverse.dng'),
      file('IMG_0042.CR2'),
      file('shot.NEF')
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped.every(s => s.category === 'raw-photo')).toBe(true);
    expect(result.skipped[0].reason).toContain('RAW camera file (.dng)');
  });

  it('excludes layered / print formats (.psd, .tif)', () => {
    const result = filterImageFiles([file('coin.psd'), file('scan.tif'), file('scan.tiff')]);

    expect(result.accepted).toEqual([]);
    expect(result.skipped.every(s => s.category === 'layered-image')).toBe(true);
  });

  it('excludes operating-system junk files', () => {
    const result = filterImageFiles([
      file('Thumbs.db'), file('thumbs.db'), file('desktop.ini'), file('.DS_Store')
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.skipped.every(s => s.category === 'system-file')).toBe(true);
  });

  it('excludes non-images, including extensionless files and stray .info', () => {
    const result = filterImageFiles([
      file('album.info'), file('notes.txt'), file('README'), file('archive.zip')
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.skipped.map(s => s.category)).toEqual([
      'not-an-image', 'not-an-image', 'not-an-image', 'not-an-image'
    ]);
    expect(result.skipped.find(s => s.fileName === 'README')!.reason)
      .toContain('No file extension');
  });

  it('counts the skipped files by reason so nothing looks silently dropped', () => {
    const files = [
      file('good-1.jpg'), file('good-2.png'),
      file('a.dng'), file('b.dng'), file('c.dng'),
      file('x.CR2'),
      file('Thumbs.db'),
      file('notes.txt')
    ];

    const result = filterImageFiles(files);

    expect(result.totalSelected).toBe(8);
    expect(result.accepted).toHaveLength(2);
    expect(result.skipped).toHaveLength(6);

    // Biggest group first, and every rejection accounted for.
    expect(result.tallies[0].count).toBe(3);
    expect(result.tallies[0].reason).toContain('.dng');
    expect(result.tallies.reduce((sum, t) => sum + t.count, 0)).toBe(6);
  });

  it('does not trust a misleading MIME type over the extension', () => {
    // Windows commonly reports image/x-adobe-dng for RAW. The old
    // file.type.startsWith('image/') test let these straight through.
    const raw = new File(['x'], 'sneaky.dng', { type: 'image/x-adobe-dng' });
    // ...and sometimes reports nothing at all for a perfectly good .webp.
    const webp = new File(['x'], 'fine.webp', { type: '' });

    const result = filterImageFiles([raw, webp]);

    expect(result.accepted.map(f => f.name)).toEqual(['fine.webp']);
    expect(result.skipped.map(s => s.fileName)).toEqual(['sneaky.dng']);
  });

  it('exposes the small helpers it is built from', () => {
    expect(fileExtension('1812 50¢ VG - Obverse.jpg')).toBe('jpg');
    expect(fileExtension('folder/sub/a.PNG')).toBe('png');
    expect(fileExtension('noext')).toBe('');
    expect(isDisplayableImage('a.jpeg')).toBe(true);
    expect(isDisplayableImage('a.dng')).toBe(false);
    expect(isDisplayableImage('Thumbs.db')).toBe(false);
    expect(tallySkipReasons([])).toEqual([]);
  });
});
