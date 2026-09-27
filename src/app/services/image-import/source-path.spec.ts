/**
 * Tests for rebuilding an original file's ABSOLUTE path from the two halves we
 * actually have: the base folder the user typed, and the relative path the
 * browser gave us.
 *
 * These are the rules that decide what ends up in CoinImages.SourcePath for
 * ~1,700 rows, and a wrong join is invisible until every link in the app says
 * "file is missing" — so they are pinned down carefully here.
 */
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_IMPORT_BASE_FOLDER,
  joinWindowsPath,
  previewSourcePath,
  sourcePathForFile
} from './source-path';

/**
 * Builds a File with a `webkitRelativePath`, which is what a directory picker
 * produces. Node's File has no such property, so it is defined here — it is
 * read-only in the browser, hence defineProperty rather than assignment.
 */
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
    // This is the real shape of the input: the browser ALWAYS uses forward
    // slashes, even on Windows.
    expect(joinWindowsPath('\\\\192.168.0.10\\Coin Pictures', 'Business Strikes/1865 3CN - Obverse.jpg'))
      .toBe('\\\\192.168.0.10\\Coin Pictures\\Business Strikes\\1865 3CN - Obverse.jpg');
  });

  it('tolerates a trailing separator on the base folder', () => {
    // Explorer's address bar sometimes copies a trailing slash, and the user
    // may well type one. Either way there must be exactly one separator at the
    // seam, not two.
    expect(joinWindowsPath('C:\\Pics\\', 'Sub/a.jpg')).toBe('C:\\Pics\\Sub\\a.jpg');
    expect(joinWindowsPath('C:\\Pics/', 'Sub/a.jpg')).toBe('C:\\Pics\\Sub\\a.jpg');
    expect(joinWindowsPath('C:\\Pics\\\\', 'Sub/a.jpg')).toBe('C:\\Pics\\Sub\\a.jpg');
  });

  it('does not eat the leading \\\\ of a UNC base folder', () => {
    // Only TRAILING separators are stripped; a UNC path's leading pair is what
    // makes it a UNC path at all.
    expect(joinWindowsPath('\\\\host\\share\\', 'a.jpg')).toBe('\\\\host\\share\\a.jpg');
  });

  it('trims whitespace around a pasted base folder', () => {
    expect(joinWindowsPath('  C:\\Pics  ', 'a.jpg')).toBe('C:\\Pics\\a.jpg');
  });

  it('ignores leading separators on the relative half', () => {
    expect(joinWindowsPath('C:\\Pics', '/Sub/a.jpg')).toBe('C:\\Pics\\Sub\\a.jpg');
  });

  it('collapses a folder name repeated at the seam', () => {
    // webkitRelativePath INCLUDES the picked folder's own name. So pointing the
    // picker at the share root while the base folder names that same share
    // would otherwise produce ...\Coin Pictures\Coin Pictures\... — a folder
    // that does not exist, which would mark every imported image as missing.
    expect(joinWindowsPath('\\\\192.168.0.10\\Coin Pictures', 'Coin Pictures/Business Strikes/a.jpg'))
      .toBe('\\\\192.168.0.10\\Coin Pictures\\Business Strikes\\a.jpg');
  });

  it('matches the repeated folder name case-insensitively, like Windows does', () => {
    expect(joinWindowsPath('C:\\Pics', 'PICS/a.jpg')).toBe('C:\\Pics\\a.jpg');
  });

  it('keeps a repeated name when the relative path is only a filename', () => {
    // "Pics\Pics.jpg" is a file called Pics.jpg, not a doubled folder — there
    // is no folder segment to collapse, so nothing is dropped.
    expect(joinWindowsPath('C:\\Pics', 'Pics')).toBe('C:\\Pics\\Pics');
  });

  it('returns just the relative path when there is no base folder', () => {
    expect(joinWindowsPath('', 'Sub/a.jpg')).toBe('Sub\\a.jpg');
    expect(joinWindowsPath('   ', 'a.jpg')).toBe('a.jpg');
  });

  it('returns just the base folder when the relative path is empty', () => {
    // No stray separator on the end.
    expect(joinWindowsPath('C:\\Pics', '')).toBe('C:\\Pics');
  });
});

describe('sourcePathForFile', () => {
  it('uses webkitRelativePath when the user picked a directory', () => {
    const file = pickedFile('a.jpg', 'Business Strikes/a.jpg');
    expect(sourcePathForFile('\\\\192.168.0.10\\Coin Pictures', file))
      .toBe('\\\\192.168.0.10\\Coin Pictures\\Business Strikes\\a.jpg');
  });

  it('falls back to the file name for individually picked files', () => {
    // A plain multi-file picker leaves webkitRelativePath empty, so all we have
    // to go on is the name — which is correct if those files sit directly in
    // the base folder.
    const file = pickedFile('1921 Morgan - Obverse.jpg', '');
    expect(sourcePathForFile('C:\\Pics', file)).toBe('C:\\Pics\\1921 Morgan - Obverse.jpg');
  });

  it('returns null when there is no base folder to anchor the name to', () => {
    // Null means "no path recorded", which the viewer renders as no link at
    // all — deliberately NOT a bare filename that could never be reopened.
    expect(sourcePathForFile('', pickedFile('a.jpg', ''))).toBe(null);
  });

  it('offers a drive-letter path as an illustration, never as a value', () => {
    // The example is placeholder/hint text only. It must look like a host-local
    // path so the user copies the right SHAPE -- the host keeps the photo
    // library on a local drive, not behind the UNC path a developer workstation
    // reaches it by.
    //
    // It is NOT a default and must never become one: a wrong base folder fails
    // silently, stamping every row with an unreachable location that only
    // surfaces later as ~1,700 images all reporting "file is missing". The real
    // prefill comes from the server (GET /api/app-info) and is described in
    // import-base-folder.ts.
    expect(EXAMPLE_IMPORT_BASE_FOLDER).toBe('D:\\Coin Pictures');
  });
});

/**
 * The host runs the app from a local drive, so drive-letter bases are the normal
 * case rather than an exotic one. These pin down the two places a drive letter
 * behaves differently from any other path fragment.
 */
describe('joinWindowsPath with drive-letter bases', () => {
  it('joins a plain drive-letter folder', () => {
    expect(joinWindowsPath('D:\\Coin Pictures', 'Business Strikes/1865 3CN.jpg'))
      .toBe('D:\\Coin Pictures\\Business Strikes\\1865 3CN.jpg');
  });

  it('collapses the repeated folder name for a drive-letter base too', () => {
    // Same trap as the UNC case: webkitRelativePath includes the picked folder's
    // own name, so pointing the picker at D:\Coin Pictures would otherwise give
    // D:\Coin Pictures\Coin Pictures\...
    expect(joinWindowsPath('D:\\Coin Pictures', 'Coin Pictures/Proofs/a.jpg'))
      .toBe('D:\\Coin Pictures\\Proofs\\a.jpg');
  });

  it('keeps a drive root absolute when the trailing separator is stripped', () => {
    // The subtle one. Stripping the trailing separator from "D:\" leaves "D:",
    // and in Windows a bare "D:" means "the current directory on drive D", NOT
    // the root of D. The separator we add back at the seam is what keeps the
    // result absolute -- so this must be D:\a.jpg and never D:a.jpg.
    expect(joinWindowsPath('D:\\', 'a.jpg')).toBe('D:\\a.jpg');
    expect(joinWindowsPath('D:\\', 'Proofs/a.jpg')).toBe('D:\\Proofs\\a.jpg');
  });

  it('treats a bare drive letter as that drive s root', () => {
    // If the user types just "D:", the only sane reading is the root -- and
    // that is what the added separator produces.
    expect(joinWindowsPath('D:', 'a.jpg')).toBe('D:\\a.jpg');
  });

  it('does not confuse the drive letter with a repeatable folder name', () => {
    // "D:" is a path segment like any other to segmentsOf(), so guard against a
    // relative path whose first segment happens to look similar.
    expect(joinWindowsPath('D:\\', 'D/a.jpg')).toBe('D:\\D\\a.jpg');
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
