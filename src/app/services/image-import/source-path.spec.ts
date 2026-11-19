/**
 * Tests for rebuilding an original file's absolute path (stored in
 * CoinImages.SourcePath) from the user's base folder and the browser's
 * relative path. A wrong join only shows up later as "file is missing".
 */
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_IMPORT_BASE_FOLDER,
  joinWindowsPath,
  normalizeSourcePathForComparison,
  previewSourcePath,
  sourcePathForFile
} from './source-path';

/** A File with a `webkitRelativePath`, as a directory picker produces it. */
function pickedFile(name: string, webkitRelativePath = ''): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: webkitRelativePath });
  return file;
}

describe('joinWindowsPath', () => {
  it('joins a base folder to a relative path with a single backslash', () => {
    expect(joinWindowsPath('C:\\Pics', 'Business Strikes\\a.jpg'))
      .toBe('C:\\Pics\\Business Strikes\\a.jpg');
  });

  it('normalises the forward slashes webkitRelativePath uses', () => {
    // The browser always uses forward slashes, even on Windows.
    expect(joinWindowsPath('\\\\NAS\\Coin Pictures', 'Business Strikes/1865 3CN - Obverse.jpg'))
      .toBe('\\\\NAS\\Coin Pictures\\Business Strikes\\1865 3CN - Obverse.jpg');
  });

  it('tolerates a trailing separator on the base folder', () => {
    // Exactly one separator at the seam.
    expect(joinWindowsPath('C:\\Pics\\', 'Sub/a.jpg')).toBe('C:\\Pics\\Sub\\a.jpg');
    expect(joinWindowsPath('C:\\Pics/', 'Sub/a.jpg')).toBe('C:\\Pics\\Sub\\a.jpg');
    expect(joinWindowsPath('C:\\Pics\\\\', 'Sub/a.jpg')).toBe('C:\\Pics\\Sub\\a.jpg');
  });

  it('does not eat the leading \\\\ of a UNC base folder', () => {
    // Only trailing separators are stripped.
    expect(joinWindowsPath('\\\\host\\share\\', 'a.jpg')).toBe('\\\\host\\share\\a.jpg');
  });

  it('trims whitespace around a pasted base folder', () => {
    expect(joinWindowsPath('  C:\\Pics  ', 'a.jpg')).toBe('C:\\Pics\\a.jpg');
  });

  it('ignores leading separators on the relative half', () => {
    expect(joinWindowsPath('C:\\Pics', '/Sub/a.jpg')).toBe('C:\\Pics\\Sub\\a.jpg');
  });

  it('collapses a folder name repeated at the seam', () => {
    // webkitRelativePath includes the picked folder's own name, which would
    // otherwise give ...\Coin Pictures\Coin Pictures\...
    expect(joinWindowsPath('\\\\NAS\\Coin Pictures', 'Coin Pictures/Business Strikes/a.jpg'))
      .toBe('\\\\NAS\\Coin Pictures\\Business Strikes\\a.jpg');
  });

  it('matches the repeated folder name case-insensitively, like Windows does', () => {
    expect(joinWindowsPath('C:\\Pics', 'PICS/a.jpg')).toBe('C:\\Pics\\a.jpg');
  });

  it('keeps a repeated name when the relative path is only a filename', () => {
    // No folder segment to collapse.
    expect(joinWindowsPath('C:\\Pics', 'Pics')).toBe('C:\\Pics\\Pics');
  });

  it('returns just the relative path when there is no base folder', () => {
    expect(joinWindowsPath('', 'Sub/a.jpg')).toBe('Sub\\a.jpg');
    expect(joinWindowsPath('   ', 'a.jpg')).toBe('a.jpg');
  });

  it('returns just the base folder when the relative path is empty', () => {
    expect(joinWindowsPath('C:\\Pics', '')).toBe('C:\\Pics');
  });
});

describe('sourcePathForFile', () => {
  it('uses webkitRelativePath when the user picked a directory', () => {
    const file = pickedFile('a.jpg', 'Business Strikes/a.jpg');
    expect(sourcePathForFile('\\\\NAS\\Coin Pictures', file))
      .toBe('\\\\NAS\\Coin Pictures\\Business Strikes\\a.jpg');
  });

  it('falls back to the file name for individually picked files', () => {
    // A plain multi-file picker leaves webkitRelativePath empty.
    const file = pickedFile('1921 Morgan - Obverse.jpg', '');
    expect(sourcePathForFile('C:\\Pics', file)).toBe('C:\\Pics\\1921 Morgan - Obverse.jpg');
  });

  it('returns null when there is no base folder to anchor the name to', () => {
    // Null means "no path recorded", not a bare filename.
    expect(sourcePathForFile('', pickedFile('a.jpg', ''))).toBe(null);
  });

  it('offers a drive-letter path as an illustration, never as a value', () => {
    // Placeholder text only, never a default value (see import-base-folder.ts).
    // A host-local drive path, since the host keeps the photos on a local drive.
    expect(EXAMPLE_IMPORT_BASE_FOLDER).toBe('D:\\Coin Pictures');
  });
});

/** Drive-letter bases are the normal case on the host. */
describe('joinWindowsPath with drive-letter bases', () => {
  it('joins a plain drive-letter folder', () => {
    expect(joinWindowsPath('D:\\Coin Pictures', 'Business Strikes/1865 3CN.jpg'))
      .toBe('D:\\Coin Pictures\\Business Strikes\\1865 3CN.jpg');
  });

  it('collapses the repeated folder name for a drive-letter base too', () => {
    expect(joinWindowsPath('D:\\Coin Pictures', 'Coin Pictures/Proofs/a.jpg'))
      .toBe('D:\\Coin Pictures\\Proofs\\a.jpg');
  });

  it('keeps a drive root absolute when the trailing separator is stripped', () => {
    // A bare "D:" means the current directory on D, not its root, so the
    // result must be D:\a.jpg, never D:a.jpg.
    expect(joinWindowsPath('D:\\', 'a.jpg')).toBe('D:\\a.jpg');
    expect(joinWindowsPath('D:\\', 'Proofs/a.jpg')).toBe('D:\\Proofs\\a.jpg');
  });

  it('treats a bare drive letter as that drive s root', () => {
    expect(joinWindowsPath('D:', 'a.jpg')).toBe('D:\\a.jpg');
  });

  it('does not confuse the drive letter with a repeatable folder name', () => {
    expect(joinWindowsPath('D:\\', 'D/a.jpg')).toBe('D:\\D\\a.jpg');
  });
});

 /*
 * Decides whether a picked file is already attached to the coin: too strict
 * duplicates photos, too loose silently skips wanted ones.
  */
describe('normalizeSourcePathForComparison', () => {
  it('is case-insensitive, because Windows paths are', () => {
    expect(normalizeSourcePathForComparison('D:\\Coin Pictures\\A.JPG'))
      .toBe(normalizeSourcePathForComparison('d:\\coin pictures\\a.jpg'));
  });

  it('treats forward and back slashes as the same separator', () => {
    expect(normalizeSourcePathForComparison('D:/Coin Pictures/a.jpg'))
      .toBe(normalizeSourcePathForComparison('D:\\Coin Pictures\\a.jpg'));
  });

  it('collapses repeated separators', () => {
    expect(normalizeSourcePathForComparison('D:\\Coin Pictures\\\\a.jpg'))
      .toBe(normalizeSourcePathForComparison('D:\\Coin Pictures\\a.jpg'));
  });

  it('ignores a trailing separator and surrounding whitespace', () => {
    expect(normalizeSourcePathForComparison('  D:\\Coin Pictures\\Proofs\\  '))
      .toBe(normalizeSourcePathForComparison('D:\\Coin Pictures\\Proofs'));
  });

  it('keeps the leading double separator of a UNC path', () => {
    // \\NAS\pics\a.jpg and \NAS\pics\a.jpg are different locations.
    expect(normalizeSourcePathForComparison('\\\\NAS\\pics\\a.jpg'))
      .not.toBe(normalizeSourcePathForComparison('\\NAS\\pics\\a.jpg'));
    expect(normalizeSourcePathForComparison('//NAS/pics/a.jpg'))
      .toBe(normalizeSourcePathForComparison('\\\\NAS\\pics\\a.jpg'));
  });

  it('still distinguishes genuinely different files', () => {
    expect(normalizeSourcePathForComparison('D:\\pics\\a.jpg'))
      .not.toBe(normalizeSourcePathForComparison('D:\\pics\\b.jpg'));
    // Same filename, different folder.
    expect(normalizeSourcePathForComparison('D:\\pics\\Halves\\Obverse.jpg'))
      .not.toBe(normalizeSourcePathForComparison('D:\\pics\\Dimes\\Obverse.jpg'));
  });

  it('returns an empty string for nothing at all', () => {
    // Callers must never treat two empty forms as a match.
    expect(normalizeSourcePathForComparison(null)).toBe('');
    expect(normalizeSourcePathForComparison(undefined)).toBe('');
    expect(normalizeSourcePathForComparison('   ')).toBe('');
  });
});

describe('previewSourcePath', () => {
  it('builds the live example the import screen shows', () => {
    const file = pickedFile('a.jpg', 'Proofs/a.jpg');
    expect(previewSourcePath('C:\\Pics', file)).toBe('C:\\Pics\\Proofs\\a.jpg');
  });

  it('is null before any file has been selected', () => {
    expect(previewSourcePath('C:\\Pics', undefined)).toBe(null);
  });
});
