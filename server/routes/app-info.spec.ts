/**
 * GET /api/app-info. Mostly tests path resolution: the module runs from
 * server/routes under tsx and server/dist/routes when compiled, so the answer
 * must be "the directory containing angular.json", not a fixed level count.
 * The SQLite harness is imported so loading server.ts uses `:memory:`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

import { executedSql } from '../test-support/sqlite-test-db';
import { app } from '../server';
import { resolveAppFolder, resolveDocumentsFolder, normaliseWindowsPath } from './app-info';

/** The env var is process-global, so tests that set it restore it. */
const ORIGINAL_OVERRIDE = process.env['APP_BASE_FOLDER'];

beforeEach(() => {
  delete process.env['APP_BASE_FOLDER'];
});

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env['APP_BASE_FOLDER'];
  else process.env['APP_BASE_FOLDER'] = ORIGINAL_OVERRIDE;
});

// normaliseWindowsPath

describe('normaliseWindowsPath', () => {
  it('rewrites forward slashes in a drive-letter path', () => {
    // Forward slashes are normalized; the import screen joins with a backslash.
    expect(normaliseWindowsPath('D:/Coin Inventory')).toBe('D:\\Coin Inventory');
  });

  it('collapses doubled separators without breaking a UNC prefix', () => {
    expect(normaliseWindowsPath('D:\\\\Coins\\\\App')).toBe('D:\\Coins\\App');
    // The leading \\ of a UNC path is the one doubled separator that must stay.
    expect(normaliseWindowsPath('\\\\host\\share\\App')).toBe('\\\\host\\share\\App');
    expect(normaliseWindowsPath('//host/share/App')).toBe('\\\\host\\share\\App');
  });

  it('strips a trailing separator, because the caller adds its own', () => {
    expect(normaliseWindowsPath('D:\\CoinInventory\\')).toBe('D:\\CoinInventory');
  });

  it('keeps the backslash on a bare drive root', () => {
    // `D:` alone means the current directory on D:, not its root.
    expect(normaliseWindowsPath('D:\\')).toBe('D:\\');
  });

  it('trims whitespace and answers empty for a blank value', () => {
    expect(normaliseWindowsPath('   D:\\App   ')).toBe('D:\\App');
    expect(normaliseWindowsPath('   ')).toBe('');
  });

  it('leaves a POSIX path alone rather than mangling its separators', () => {
    // POSIX paths aren't rewritten.
    expect(normaliseWindowsPath('/opt/coin-inventory')).toBe('/opt/coin-inventory');
  });
});

// resolveAppFolder — the resolution order

describe('resolveAppFolder', () => {
  it('prefers APP_BASE_FOLDER when it is set', () => {
    process.env['APP_BASE_FOLDER'] = 'E:/Deployed/CoinInventory/';

    const info = resolveAppFolder();

    expect(info.source).toBe('env');
    // Normalized: separators rewritten, trailing one dropped.
    expect(info.appFolder).toBe('E:\\Deployed\\CoinInventory');
  });

  it('ignores a blank APP_BASE_FOLDER and derives the folder instead', () => {
    // A blank override is the normal state, not "the folder is ''".
    process.env['APP_BASE_FOLDER'] = '   ';

    expect(resolveAppFolder().source).toBe('module');
  });

  it('derives the PROJECT ROOT, not the server folder', () => {
    // The off-by-one-folder test: the result is the real root (contains
    // angular.json, and is the parent of server/).
    const info = resolveAppFolder();

    expect(info.source).toBe('module');
    expect(fs.existsSync(path.join(info.appFolder, 'angular.json'))).toBe(true);

    // This spec lives under it, so it isn't some unrelated project higher up.
    expect(__dirname.startsWith(info.appFolder)).toBe(true);

    // Not server/, which also has a package.json.
    expect(path.basename(info.appFolder)).not.toBe('server');
    expect(fs.existsSync(path.join(info.appFolder, 'server', 'server.ts'))).toBe(true);
  });

  it('returns the same answer from this file\'s tsx depth as the compiled depth would', () => {
    // Walking up from either layout lands on the same root.
    const root = resolveAppFolder().appFolder;

    // <root>/server/routes: the tsx layout.
    expect(path.resolve(__dirname, '..', '..')).toBe(root);

    // <root>/server/dist/routes: one level deeper when compiled.
    const compiledDir = path.join(root, 'server', 'dist', 'routes');
    expect(path.resolve(compiledDir, '..', '..')).toBe(path.join(root, 'server'));
    expect(path.resolve(compiledDir, '..', '..', '..')).toBe(root);
  });

  it('always answers an absolute path', () => {
    expect(path.isAbsolute(resolveAppFolder().appFolder)).toBe(true);
  });
});

// GET /api/app-info

describe('GET /api/app-info', () => {
  it('returns the app folder as JSON', async () => {
    const res = await request(app).get('/api/app-info');

    expect(res.status).toBe(200);
    expect(typeof res.body.appFolder).toBe('string');
    expect(res.body.appFolder.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(res.body.appFolder, 'angular.json'))).toBe(true);
  });

  it('honours APP_BASE_FOLDER over the derived path', async () => {
    // Resolved per request, so setting it now is enough.
    process.env['APP_BASE_FOLDER'] = 'F:\\Elsewhere\\App';

    const res = await request(app).get('/api/app-info');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ appFolder: 'F:\\Elsewhere\\App', source: 'env' });
  });

  it('never touches the database', async () => {
    // The route must not query the database (executedSql() records every statement).
    await request(app).get('/api/app-info');

    expect(executedSql()).toEqual([]);
  });
});

// The user's Documents folder (default for the image import's folder box)

describe('resolveDocumentsFolder', () => {
  const ORIGINAL = process.env['COIN_DOCUMENTS_FOLDER'];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['COIN_DOCUMENTS_FOLDER'];
    else process.env['COIN_DOCUMENTS_FOLDER'] = ORIGINAL;
  });

  it('honours COIN_DOCUMENTS_FOLDER', () => {
    process.env['COIN_DOCUMENTS_FOLDER'] = 'E:/Docs/';
    expect(resolveDocumentsFolder()).toBe('E:\\Docs');
  });

  it('otherwise answers an absolute folder that exists', () => {
    delete process.env['COIN_DOCUMENTS_FOLDER'];
    const folder = resolveDocumentsFolder();
    expect(path.isAbsolute(folder)).toBe(true);
    expect(fs.existsSync(folder)).toBe(true);
  });

  it('is part of GET /api/app-info', async () => {
    process.env['COIN_DOCUMENTS_FOLDER'] = 'E:/Docs';
    const res = await request(app).get('/api/app-info');
    expect(res.body.documentsFolder).toBe('E:\\Docs');
  });
});
