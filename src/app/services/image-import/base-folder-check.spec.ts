 /*
 * base-folder-check.spec.ts
 *
 * Before writing, the paths an import would store are checked against the
 * disk; an import whose paths all resolve to nothing (wrong base folder) is
 * refused.
  */

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SAMPLED_PATHS,
  samplePathsToVerify,
  verifyBaseFolder,
  verdictMessage
} from './base-folder-check';

/** A File as a directory picker produces it (webkitRelativePath is read-only). */
function pickedFile(name: string, relativePath = ''): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

/** A probe that reports every path as readable. */
const allPresent = async (paths: string[]) =>
  Object.fromEntries(paths.map(p => [p, true]));

/** A probe that reports every path as unreadable — the wrong-base-folder case. */
const allMissing = async (paths: string[]) =>
  Object.fromEntries(paths.map(p => [p, false]));

describe('samplePathsToVerify', () => {
  it('builds the absolute paths that would actually be stored', () => {
    const files = [pickedFile('a.jpg', 'Coins/Half Dollars/a.jpg')];

    expect(samplePathsToVerify('D:\\Coin Pictures', files))
      .toEqual(['D:\\Coin Pictures\\Coins\\Half Dollars\\a.jpg']);
  });

  it('caps the sample so one import costs one small request', () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      pickedFile(`a${i}.jpg`, `Coins/Sub${i}/a${i}.jpg`)
    );

    expect(samplePathsToVerify('D:\\Pics', files).length).toBe(MAX_SAMPLED_PATHS);
  });

  it('spreads the sample across the selection rather than taking a prefix', () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      pickedFile(`a${i}.jpg`, `Coins/Sub${i}/a${i}.jpg`)
    );

    const sampled = samplePathsToVerify('D:\\Pics', files);

    expect(sampled[0]).toContain('Sub0');
    expect(sampled[sampled.length - 1]).toContain('Sub49');
  });

  it('de-duplicates, so repeated paths do not waste the cap', () => {
    const files = [
      pickedFile('a.jpg', 'Coins/a.jpg'),
      pickedFile('a.jpg', 'Coins/a.jpg'),
      pickedFile('b.jpg', 'Coins/b.jpg')
    ];

    expect(samplePathsToVerify('D:\\Pics', files).length).toBe(2);
  });

  it('yields nothing when there is no base folder to anchor names to', () => {
    expect(samplePathsToVerify('', [pickedFile('a.jpg', 'Coins/a.jpg')])).toEqual([]);
  });
});

describe('verifyBaseFolder', () => {
  it('refuses an import whose paths all resolve to nothing', async () => {
    const files = [pickedFile('a.jpg', 'Half Dollars/a.jpg')];

    const verdict = await verifyBaseFolder('C:\\dev\\coin-inventory', files, allMissing);

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('unreadable');
    expect(verdict.checked).toContain('C:\\dev\\coin-inventory\\Half Dollars\\a.jpg');
  });

  it('allows an import whose paths resolve', async () => {
    const files = [pickedFile('a.jpg', 'Half Dollars/a.jpg')];

    expect((await verifyBaseFolder('D:\\Coin Pictures', files, allPresent)).ok).toBe(true);
  });

  // No base folder means paths are not recorded; not an error.
  it('does not block when no base folder is set at all', async () => {
    const probe = vi.fn(allPresent);

    const verdict = await verifyBaseFolder('', [pickedFile('a.jpg', 'x/a.jpg')], probe);

    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe('no-base-folder');
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not block when there is nothing selected to check', async () => {
    const probe = vi.fn(allPresent);

    expect((await verifyBaseFolder('D:\\Pics', [], probe)).ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  // A wrong root fails every path; a partial failure is individual.
  it('allows the import when only some paths are missing', async () => {
    const files = [
      pickedFile('a.jpg', 'Coins/a.jpg'),
      pickedFile('b.jpg', 'Coins/b.jpg')
    ];

    const halfMissing = async (paths: string[]) =>
      Object.fromEntries(paths.map((p, i) => [p, i === 0]));

    expect((await verifyBaseFolder('D:\\Pics', files, halfMissing)).ok).toBe(true);
  });

  // Fails open.
  it('allows the import when the check itself fails', async () => {
    const broken = () => Promise.reject(new Error('backend down'));

    const verdict = await verifyBaseFolder('D:\\Pics', [pickedFile('a.jpg', 'x/a.jpg')], broken);

    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe('check-failed');
  });

  it('treats a path absent from the response as unknown, not as missing', async () => {
    const empty = async () => ({});

    expect((await verifyBaseFolder('D:\\Pics', [pickedFile('a.jpg', 'x/a.jpg')], empty)).ok)
      .toBe(true);
  });
});

describe('verdictMessage', () => {
  it('names a real failing path and points at the control that fixes it', async () => {
    const files = [pickedFile('a.jpg', 'Half Dollars/a.jpg')];
    const verdict = await verifyBaseFolder('C:\\dev\\coin-inventory', files, allMissing);

    const message = verdictMessage(verdict);

    expect(message).toContain('C:\\dev\\coin-inventory\\Half Dollars\\a.jpg');
    expect(message?.toLowerCase()).toContain('folder');
  });

  it('says nothing when the import is allowed', async () => {
    const files = [pickedFile('a.jpg', 'x/a.jpg')];

    expect(verdictMessage(await verifyBaseFolder('D:\\Pics', files, allPresent))).toBeNull();
  });
});
