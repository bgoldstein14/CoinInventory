/**
 * Tests for the original-image endpoints (file.ts, exists.ts) against the real
 * filesystem, using a temp directory removed in afterAll. The SQLite harness
 * is imported only so loading server.ts uses an in-memory database.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../../test-support/sqlite-test-db';
import { app } from '../../server';
import { MAX_PATHS_PER_REQUEST } from './exists';

// Temp fixtures

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-images-spec-'));

  // A space in the name, as in real folders like "C:\Coin Pictures\".
  pngPath = path.join(tempDir, '1921 morgan obverse.png');
  fs.writeFileSync(pngPath, PNG_BYTES);

  // Upper-case extension, as cameras produce.
  upperCaseJpgPath = path.join(tempDir, 'IMG_0042.JPG');
  fs.writeFileSync(upperCaseJpgPath, 'jpeg-bytes');

  tifPath = path.join(tempDir, 'scan.tif');
  fs.writeFileSync(tifPath, 'tiff-bytes');

  textPath = path.join(tempDir, 'notes.txt');
  fs.writeFileSync(textPath, 'not an image');

  // Never created: the "file was moved" case.
  missingPath = path.join(tempDir, 'deleted-yesterday.png');

  // A directory named like an image; the route must reject it up front.
  directoryNamedLikeImage = path.join(tempDir, 'looks-like-a-file.jpg');
  fs.mkdirSync(directoryNamedLikeImage);
});

afterAll(() => {
  // force: true so a half-built directory can't fail cleanup too.
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// GET /api/images/file

describe('GET /api/images/file', () => {
  it('streams an existing file with the right Content-Type, length and bytes', async () => {
    const res = await request(app)
      .get('/api/images/file')
      .query({ path: pngPath })
      // So res.body is the raw Buffer sent.
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');

    // Lets the browser show progress on large originals.
    expect(res.headers['content-length']).toBe(String(PNG_BYTES.length));

    // The bytes arrive unmodified.
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
    // Served even though browsers download TIFFs rather than display them.
    const res = await request(app)
      .get('/api/images/file')
      .query({ path: tifPath })
      .responseType('blob');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/tiff');
  });

  it('returns 404 when the original file is no longer there', async () => {
    // The UI shows this as a greyed-out filename.
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
    // A bracketed key must give a 400, not a TypeError and 500.
    const res = await request(app).get('/api/images/file?path[key]=C:%5Ca.png');

    expect(res.status).toBe(400);
  });

  it('returns 400 for a disallowed extension, even though the file exists', async () => {
    // The allow-list applies even to readable files (notes.txt exists, so a
    // 404 would mean the check was skipped).
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

// POST /api/images/exists

describe('POST /api/images/exists', () => {
  it('reports true/false per path in a single request', async () => {
    // One request for all of a coin's photos.
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
   * The log names each missing path, not just a count. Asserted on
   * console.log, where log() echoes every level.
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
      // ...at WARN...
      expect(logged).toMatch(/WARN/);
      // ...and the readable one isn't in the warning block (it may appear in
      // the routine summary line).
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
    // Many missing at once (a dropped share): capped, with an exact count.
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
    // Illegal characters, a reserved name, a missing share: all false, never 500.
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
    // Duplicates are checked once; the response is keyed by path.
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
