/**
 * Tests for the referenced-mode encoder.
 *
 * TWO PROPERTIES, AND THEY ARE THE WHOLE MODE:
 *
 *  1. NO BYTES ARE READ, and nothing that could become a picture is
 *     produced. If this ever returned a data URL the database would start
 *     carrying pictures again and "referenced" would be a label on nothing.
 *  2. A PHOTO WITH NOWHERE TO POINT IS A FAILURE, not a silent pass. A row
 *     with neither a picture nor a path is a photograph thrown away.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeReferencedEncoder, NO_BASE_FOLDER_MESSAGE } from './referenced-encoder';
import { sourcePathFromReferenceUrl } from './reference-url';

/**
 * A File with a webkitRelativePath, which is all the browser gives us about
 * where a picked file lives. `arrayBuffer` is spied on so the test can prove
 * the bytes are never touched.
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

    // The path the database will record, recoverable from what was produced.
    expect(sourcePathFromReferenceUrl(encoded.dataUrl)).toBe(
      'C:\\Coin Pictures\\Coins\\1921-morgan.jpg'
    );
    // NOT a picture. This is the assertion that the mode is real.
    expect(encoded.dataUrl).not.toContain('base64');
    expect(encoded.storedBytes).toBe(0);
    // The original's size is still reported, because the import summary
    // honestly says how much was looked at.
    expect(encoded.originalBytes).toBe(4_000_000);
    // And the 4 MB was never pulled over the share.
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('uses the URL builder it is given, so the reference is absolute', async () => {
    // Under `ng serve` the page is on :4200 and the API on :3000; a relative
    // URL would be fetched from the dev server and 404.
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
      // The runner catches this per file and records it as a named failure,
      // so the photo is reported rather than quietly dropped.
      await expect(encode(file)).rejects.toThrow(NO_BASE_FOLDER_MESSAGE);
    }
  });

  it('says what to do about it', () => {
    // The message is shown to a non-technical user as the reason an import
    // was refused; it has to name both ways out.
    expect(NO_BASE_FOLDER_MESSAGE).toContain('folder');
    expect(NO_BASE_FOLDER_MESSAGE).toContain('Settings');
  });
});
