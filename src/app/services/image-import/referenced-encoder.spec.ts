/**
 * Tests for the referenced-mode encoder: no bytes are read and no picture is
 * produced, and a photo with no path to point at is a failure.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeReferencedEncoder, NO_BASE_FOLDER_MESSAGE } from './referenced-encoder';
import { sourcePathFromReferenceUrl } from './reference-url';

/**
 * A File with a webkitRelativePath. `arrayBuffer` is spied on to prove the
 * bytes are never read.
 */
function pickedFile(relativePath: string, size = 4_000_000) {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
  const file = {
    name: relativePath.split('/').pop(),
    size,
    webkitRelativePath: relativePath,
    arrayBuffer
  } as unknown as File;
  return { file, arrayBuffer };
}

describe('makeReferencedEncoder', () => {
  it('produces a reference to the original and reads nothing', async () => {
    const { file, arrayBuffer } = pickedFile('Coins/1921-morgan.jpg');
    const encode = makeReferencedEncoder('C:\\Coin Pictures');

    const encoded = await encode(file);

    expect(sourcePathFromReferenceUrl(encoded.dataUrl)).toBe(
      'C:\\Coin Pictures\\Coins\\1921-morgan.jpg'
    );
    // Not a picture.
    expect(encoded.dataUrl).not.toContain('base64');
    expect(encoded.storedBytes).toBe(0);
    // The original's size is still reported for the import summary.
    expect(encoded.originalBytes).toBe(4_000_000);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('uses the URL builder it is given, so the reference is absolute', async () => {
    // Under `ng serve` a relative URL would hit the dev server and 404.
    const { file } = pickedFile('Coins/a.jpg');
    const encode = makeReferencedEncoder(
      'C:\\Pics',
      path => `http://localhost:3000/api/images/file?path=${encodeURIComponent(path)}`
    );

    const encoded = await encode(file);

    expect(encoded.dataUrl.startsWith('http://localhost:3000/')).toBe(true);
    expect(sourcePathFromReferenceUrl(encoded.dataUrl)).toBe('C:\\Pics\\Coins\\a.jpg');
  });

  it('refuses the file when there is no folder to point at', async () => {
    const { file } = pickedFile('Coins/a.jpg');

    for (const folder of [undefined, '', '   ']) {
      const encode = makeReferencedEncoder(folder);
      // The runner records this as a per-file failure.
      await expect(encode(file)).rejects.toThrow(NO_BASE_FOLDER_MESSAGE);
    }
  });

  it('says what to do about it', () => {
    // The message must name both ways out.
    expect(NO_BASE_FOLDER_MESSAGE).toContain('folder');
    expect(NO_BASE_FOLDER_MESSAGE).toContain('Settings');
  });
});
