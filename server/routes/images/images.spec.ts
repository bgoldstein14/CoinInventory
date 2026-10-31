/**
 * routes/images/images.spec.ts — tests for the original-image-file endpoints
 * (routes/images/file.ts and routes/images/exists.ts).
 *
 * Unlike every other spec in this backend these tests touch the REAL
 * filesystem, because that is the thing under test: "is this file still on
 * disk, and can we hand it to the browser?" is not a question a mock can answer
 * meaningfully. A throwaway directory is created in the OS temp area in
 * beforeAll and deleted in afterAll, so nothing is left behind and no path
 * inside the project is written to.
 *
 * `mssql` is still mocked, only because importing server.ts pulls in the whole
 * database layer. Neither endpoint under test goes anywhere near it.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import { app } from '../../server';
import { MAX_PATHS_PER_REQUEST } from './exists';

// ============================================================
// Temp fixtures
// ============================================================

/** The throwaway directory holding this file's fixtures. */
let tempDir = '';

/** An 8-byte "PNG" — not a real image, but real bytes we can compare against. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let pngPath = '';
let upperCaseJpgPath = '';
let tifPath = '';
let textPath = '';
let missingPath = '';
let directoryNamedLikeImage = '';

beforeAll(() => {
  // mkdtempSync appends random characters, so parallel runs cannot collide.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-images-spec-'));

  // A space in the filename is deliberate: real coin photos live in folders
  // like "C:\Coin Pictures\", and a space is exactly the kind of character
  // that breaks naive URL handling.
  pngPath = path.join(tempDir, '1921 morgan obverse.png');
  fs.writeFileSync(pngPath, PNG_BYTES);

  // Windows filenames routinely arrive shouting from a camera.
  upperCaseJpgPath = path.join(tempDir, 'IMG_0042.JPG');
  fs.writeFileSync(upperCaseJpgPath, 'jpeg-bytes');

  tifPath = path.join(tempDir, 'scan.tif');
  fs.writeFileSync(tifPath, 'tiff-bytes');

  textPath = path.join(tempDir, 'notes.txt');
  fs.writeFileSync(textPath, 'not an image');

  // Never created — this is the "the user moved the file" case.
  missingPath = path.join(tempDir, 'deleted-yesterday.png');

  // A directory whose name ends in .jpg. Unusual, but streaming a directory
  // handle would fail mid-response, so the route has to reject it up front.
  directoryNamedLikeImage = path.join(tempDir, 'looks-like-a-file.jpg');
  fs.mkdirSync(directoryNamedLikeImage);
});

afterAll(() => {
  // force:true so a failed test that left the directory half-built cannot turn
  // cleanup into a second failure.
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================
// GET /api/images/file
// ============================================================

describe('GET /api/images/file', () => {
  it('streams an existing file with the right Content-Type, length and bytes', async () => {
    const res = await request(app)
      .get('/api/images/file')
      .query({ path: pngPath })
      // responseType('blob') stops superagent trying to parse the body as text,
      // so res.body is the raw Buffer the server actually sent.
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');

    // Content-Length is what lets the browser show download progress on a
    // 46 MB original instead of spinning with no feedback.
    expect(res.headers['content-length']).toBe(String(PNG_BYTES.length));

    // The bytes must survive the trip unmodified.
    expect(Buffer.from(res.body).equals(PNG_BYTES)).toBe(true);
  });

  it('matches the extension case-insensitively (IMG_0042.JPG -> image/jpeg)', async () => {
    const res = await request(app)
      .get('/api/images/file')
      .query({ path: upperCaseJpgPath })
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
  });

  it('serves .tif even though browsers may only offer to download it', async () => {
    // Deliberate: the point of the feature is to let the user REACH the
    // original file. What the browser then chooses to do with a TIFF is its
    // business, not ours.
    const res = await request(app)
      .get('/api/images/file')
      .query({ path: tifPath })
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/tiff');
  });

  it('returns 404 when the original file is no longer there', async () => {
    // This is the state the UI renders as a greyed-out, non-clickable filename.
    const res = await request(app).get('/api/images/file').query({ path: missingPath });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  it('returns 404 for a directory that happens to be named like an image', async () => {
    const res = await request(app)
      .get('/api/images/file')
      .query({ path: directoryNamedLikeImage });

    expect(res.status).toBe(404);
  });

  it('returns 400 when the path parameter is missing', async () => {
    const res = await request(app).get('/api/images/file');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('path');
  });

  it('returns 400 when the path parameter is blank', async () => {
    const res = await request(app).get('/api/images/file').query({ path: '   ' });

    expect(res.status).toBe(400);
  });

  it('returns 400 (not a crash) when path arrives as something other than a string', async () => {
    // Express's query parser turns `?path[key]=x` into the OBJECT { key: 'x' }.
    // Calling .trim() on that would throw a TypeError inside the handler, which
    // the global error handler would then report as a 500.
    const res = await request(app).get('/api/images/file?path[key]=C:%5Ca.png');

    expect(res.status).toBe(400);
  });

  it('returns 400 for a disallowed extension, even though the file exists', async () => {
    // The extension allowlist is the only thing narrowing this route, so it
    // must be enforced regardless of whether the file is readable. notes.txt
    // really is on disk here — a 404 would mean the check was skipped.
    const res = await request(app).get('/api/images/file').query({ path: textPath });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('image files');
  });

  it('returns 400 for a path with no extension at all', async () => {
    const res = await request(app)
      .get('/api/images/file')
      .query({ path: path.join(tempDir, 'no-extension') });

    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST /api/images/exists
// ============================================================

describe('POST /api/images/exists', () => {
  it('reports true/false per path in a single request', async () => {
    // The batching is the point: a coin with eight photos must cost ONE
    // request, not eight.
    const res = await request(app)
      .post('/api/images/exists')
      .send({ paths: [pngPath, missingPath, upperCaseJpgPath] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual({
      [pngPath]: true,
      [missingPath]: false,
      [upperCaseJpgPath]: true,
    });
  });

  it('returns an empty result set for an empty list', async () => {
    const res = await request(app).post('/api/images/exists').send({ paths: [] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual({});
  });

  /**
   * THE BUG THIS PINS
   * The endpoint used to log only a count — "4 missing" — which is a dead end
   * for whoever reads it: it says a problem exists but not which file, so
   * there is no way to tell a renamed folder from a dropped share from a
   * stale database row. The owner hit precisely that.
   *
   * The assertion is on `console.log` rather than on the logger module
   * because the Terminal is where the owner actually read the message, and
   * `log()` echoes every level there. Testing the console is testing the
   * thing he asked for.
   */
  it('names each unreadable path in the log, not just a count', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await request(app)
        .post('/api/images/exists')
        .send({ paths: [pngPath, missingPath] });

      const logged = consoleSpy.mock.calls.map((args) => String(args[0])).join('\n');

      // The missing one is named...
      expect(logged).toContain(missingPath);
      // ...flagged as something to act on...
      expect(logged).toMatch(/WARN/);
      // ...and the one that is fine is NOT reported as unreadable. (It may
      // still appear in the routine "checked N paths" line, so this asserts
      // on the warning block specifically.)
      const warnBlock = consoleSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('could not be read'))
        .join('\n');
      expect(warnBlock).toContain(missingPath);
      expect(warnBlock).not.toContain(pngPath);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('caps the named list but keeps the count exact when many are missing', async () => {
    // A disconnected network share can make every path in the request fail at
    // once. The log must stay readable without lying about the scale.
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const manyMissing = Array.from({ length: 40 }, (_, i) =>
        path.join(tempDir, `never-existed-${i}.png`)
      );

      await request(app).post('/api/images/exists').send({ paths: manyMissing });

      const logged = consoleSpy.mock.calls.map((args) => String(args[0])).join('\n');

      expect(logged).toContain('40 original image path(s) could not be read');
      expect(logged).toContain('...and 15 more'); // 40 - 25 shown
      expect(logged).toContain('never-existed-0.png');
      expect(logged).not.toContain('never-existed-39.png');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('answers false rather than throwing for malformed or unreachable paths', async () => {
    // Every one of these makes the OS unhappy in a different way (illegal
    // characters, a reserved device name, a share that is not there). None of
    // them may produce a 500 — "we cannot open it" is just false.
    const nonsense = 'C:\\<>|?*\\nope.png';
    const reserved = '\\\\?\\bad\\path\\x.png';
    const deadShare = '\\\\no-such-host-12345\\share\\x.png';

    const res = await request(app)
      .post('/api/images/exists')
      .send({ paths: [nonsense, reserved, deadShare, ''] });

    expect(res.status).toBe(200);
    expect(res.body.results[nonsense]).toBe(false);
    expect(res.body.results[reserved]).toBe(false);
    expect(res.body.results[deadShare]).toBe(false);
    expect(res.body.results['']).toBe(false);
  });

  it('de-duplicates repeated paths', async () => {
    // The same original file can back more than one image row; checking it
    // twice is pointless because the response is keyed by path.
    const res = await request(app)
      .post('/api/images/exists')
      .send({ paths: [pngPath, pngPath, pngPath] });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.results)).toEqual([pngPath]);
  });

  it('ignores non-string entries instead of failing the whole batch', async () => {
    const res = await request(app)
      .post('/api/images/exists')
      .send({ paths: [pngPath, 42, null, { nope: true }] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual({ [pngPath]: true });
  });

  it('returns 400 when the body has no paths array', async () => {
    const res = await request(app).post('/api/images/exists').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('paths');
  });

  it('returns 400 when paths is not an array', async () => {
    const res = await request(app)
      .post('/api/images/exists')
      .send({ paths: 'C:\\pics\\a.png' });

    expect(res.status).toBe(400);
  });

  it(`returns 400 for more than ${MAX_PATHS_PER_REQUEST} paths`, async () => {
    const tooMany = Array.from(
      { length: MAX_PATHS_PER_REQUEST + 1 },
      (_unused, i) => `C:\\pics\\${i}.png`
    );

    const res = await request(app).post('/api/images/exists').send({ paths: tooMany });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Too many paths');
  });

  it(`accepts exactly ${MAX_PATHS_PER_REQUEST} paths (the cap is inclusive)`, async () => {
    const atLimit = Array.from(
      { length: MAX_PATHS_PER_REQUEST },
      (_unused, i) => `C:\\pics\\${i}.png`
    );

    const res = await request(app).post('/api/images/exists').send({ paths: atLimit });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.results)).toHaveLength(MAX_PATHS_PER_REQUEST);
  });
});
