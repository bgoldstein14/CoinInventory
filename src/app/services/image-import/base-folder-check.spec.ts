/* ===========================================================================
 * base-folder-check.spec.ts
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT (it really happened, 2026-10-31)
 * ---------------------------------------------------------------------------
 * The owner imported a folder of photos and every resulting row was stamped
 * with a path under his DEVELOPMENT folder — "making up directories under
 * Development by denomination" — instead of the folder he had picked.
 *
 * Nothing was made up. The directory picker cannot supply an absolute path
 * (see source-path.ts), so only the RELATIVE half comes from the picked
 * folder; the absolute prefix comes solely from the base-folder text box. That
 * box had been left holding its fallback, which is the folder the app itself
 * is installed in. So his real subfolder names were glued onto the wrong root,
 * and every image resolved to nothing.
 *
 * The screen already showed a live preview of the path about to be stored.
 * It was ADVISORY. The README had predicted this exact failure in those exact
 * terms -- "it does not fail loudly -- it stamps every imported row with a
 * location that resolves to nothing" -- and defended against it with a hint
 * that a user is under no obligation to read.
 *
 * So the preview is no longer the only defence. Before anything is written,
 * the paths that WOULD be stored are checked against the disk, and an import
 * whose paths resolve to nothing is refused outright.
 * =========================================================================== */

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SAMPLED_PATHS,
  samplePathsToVerify,
  verifyBaseFolder,
  verdictMessage
} from './base-folder-check';

/**
 * A File as a directory picker produces it. Node's File has no
 * `webkitRelativePath`, and it is read-only in the browser, hence
 * defineProperty rather than assignment.
 */
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

  /**
   * Spread rather than "the first five". A selection is ordered, so the first
   * five files are usually all in the SAME subfolder — which would check one
   * corner of the tree and call the whole import verified.
   */
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
    // The offending path is carried out so the message can name it.
    expect(verdict.checked).toContain('C:\\dev\\coin-inventory\\Half Dollars\\a.jpg');
  });

  it('allows an import whose paths resolve', async () => {
    const files = [pickedFile('a.jpg', 'Half Dollars/a.jpg')];

    expect((await verifyBaseFolder('D:\\Coin Pictures', files, allPresent)).ok).toBe(true);
  });

  /**
   * A base folder that is simply absent is a DIFFERENT state, already handled
   * elsewhere: sourcePathForFile records null and the screen shows its own
   * "no folder given" warning. Importing without recording paths is a
   * legitimate, long-standing choice, so this must not block it.
   */
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

  /**
   * PARTIAL failure is NOT the wrong-base-folder signature and must not be
   * treated as one. The user picked these files moments ago, so they exist;
   * if the root were wrong, EVERY path would fail. A few missing means
   * something individual happened (a file removed between pick and attach, a
   * permission oddity), which is the pre-existing "crossed out in the grid"
   * behaviour and not a reason to refuse 1,700 good rows.
   */
  it('allows the import when only some paths are missing', async () => {
    const files = [
      pickedFile('a.jpg', 'Coins/a.jpg'),
      pickedFile('b.jpg', 'Coins/b.jpg')
    ];

    const halfMissing = async (paths: string[]) =>
      Object.fromEntries(paths.map((p, i) => [p, i === 0]));

    expect((await verifyBaseFolder('D:\\Pics', files, halfMissing)).ok).toBe(true);
  });

  /**
   * FAILS OPEN, deliberately. This check is a safety net, not a dependency.
   * Blocking a legitimate import because a diagnostic endpoint hiccupped
   * would be a worse bug than the one being prevented — the user would have
   * no way to proceed at all.
   */
  it('allows the import when the check itself fails', async () => {
    const broken = () => Promise.reject(new Error('backend down'));

    const verdict = await verifyBaseFolder('D:\\Pics', [pickedFile('a.jpg', 'x/a.jpg')], broken);

    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBe('check-failed');
  });

  it('treats a path absent from the response as unknown, not as missing', async () => {
    // The endpoint keys its answer by path and drops anything it could not
    // use. A missing KEY is not the same as `false`, and reading it as false
    // would block a perfectly good import.
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

    // The actual path, so the user can see WHY it is wrong rather than being
    // told abstractly that something is.
    expect(message).toContain('C:\\dev\\coin-inventory\\Half Dollars\\a.jpg');
    // And where to fix it.
    expect(message?.toLowerCase()).toContain('folder');
  });

  it('says nothing when the import is allowed', async () => {
    const files = [pickedFile('a.jpg', 'x/a.jpg')];

    expect(verdictMessage(await verifyBaseFolder('D:\\Pics', files, allPresent))).toBeNull();
  });
});
