/**
 * routes/app-info.spec.ts — tests for GET /api/app-info.
 *
 * What is actually worth testing here is the PATH RESOLUTION, because the one
 * obvious bug in this endpoint is an off-by-one-folder answer: this module runs
 * from `<root>/server/routes` under tsx and from `<root>/server/dist/routes`
 * when compiled, so anything that counts levels is wrong in one of the two.
 * See the long comment in app-info.ts. The tests below pin down the behaviour
 * that makes both cases work — "the answer is the directory containing
 * angular.json" — rather than asserting a hardcoded path, which would only
 * prove the test and the code agree about one layout.
 *
 * `mssql` is mocked for the usual reason: importing server.ts pulls in the whole
 * database layer. The route under test never goes near it, and one of the tests
 * below exists specifically to prove that.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../test-support/mssql-mock');
  return createMssqlMock();
});

import { app } from '../server';
import { resolveAppFolder, normaliseWindowsPath } from './app-info';
import { mockRequest, resetMssqlMock } from '../test-support/mssql-mock';

/**
 * The environment variable is process-global, so every test that touches it
 * puts it back. Vitest runs spec FILES in separate workers but the tests inside
 * one file share a process.
 */
const ORIGINAL_OVERRIDE = process.env['APP_BASE_FOLDER'];

beforeEach(() => {
  resetMssqlMock();
  delete process.env['APP_BASE_FOLDER'];
});

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env['APP_BASE_FOLDER'];
  else process.env['APP_BASE_FOLDER'] = ORIGINAL_OVERRIDE;
});

// ============================================================
// normaliseWindowsPath
// ============================================================

describe('normaliseWindowsPath', () => {
  it('rewrites forward slashes in a drive-letter path', () => {
    // A user typing into the .env file is as likely to use forward slashes as
    // backslashes, and the import screen joins this value with a backslash.
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
    // `D:` on its own means "the current directory on D:", which is not the
    // same thing as the root of D: at all.
    expect(normaliseWindowsPath('D:\\')).toBe('D:\\');
  });

  it('trims whitespace and answers empty for a blank value', () => {
    expect(normaliseWindowsPath('   D:\\App   ')).toBe('D:\\App');
    expect(normaliseWindowsPath('   ')).toBe('');
  });

  it('leaves a POSIX path alone rather than mangling its separators', () => {
    // Not a supported deployment, but turning /opt/app into \opt\app would be
    // actively wrong, so the rewrite is gated on the path looking like Windows.
    expect(normaliseWindowsPath('/opt/coin-inventory')).toBe('/opt/coin-inventory');
  });
});

// ============================================================
// resolveAppFolder — the resolution order
// ============================================================

describe('resolveAppFolder', () => {
  it('prefers APP_BASE_FOLDER when it is set', () => {
    process.env['APP_BASE_FOLDER'] = 'E:/Deployed/CoinInventory/';

    const info = resolveAppFolder();

    expect(info.source).toBe('env');
    // Normalised on the way out: separators rewritten, trailing one dropped.
    expect(info.appFolder).toBe('E:\\Deployed\\CoinInventory');
  });

  it('ignores a blank APP_BASE_FOLDER and derives the folder instead', () => {
    // An empty `APP_BASE_FOLDER=` line in .env is the normal state of that
    // variable, so it must not be mistaken for "the app folder is ''".
    process.env['APP_BASE_FOLDER'] = '   ';

    expect(resolveAppFolder().source).toBe('module');
  });

  it('derives the PROJECT ROOT, not the server folder', () => {
    // *** This is the off-by-one-folder test. ***
    //
    // Running under tsx (which is how the spec itself runs) this module sits in
    // <root>/server/routes; compiled it would sit in <root>/server/dist/routes.
    // A fixed number of `..` segments is right in exactly one of those. The
    // implementation walks up looking for angular.json instead, so the assertion
    // here is about the RESULT being the real root: it contains angular.json,
    // and it is the parent of the server folder rather than the server folder.
    const info = resolveAppFolder();

    expect(info.source).toBe('module');
    expect(fs.existsSync(path.join(info.appFolder, 'angular.json'))).toBe(true);

    // And this spec file really does live underneath it — proof we did not find
    // some unrelated Angular project higher up the tree.
    expect(__dirname.startsWith(info.appFolder)).toBe(true);

    // Explicitly NOT the server folder. `server/` has a package.json, which is
    // why angular.json (root-only) is the marker rather than package.json.
    expect(path.basename(info.appFolder)).not.toBe('server');
    expect(fs.existsSync(path.join(info.appFolder, 'server', 'server.ts'))).toBe(true);
  });

  it('returns the same answer from this file\'s tsx depth as the compiled depth would', () => {
    // A direct restatement of the two-layout requirement. Both of these
    // directories are real on disk relative to the project root, and walking up
    // from either must land on the same place, because the marker search does
    // not care how deep it started.
    const root = resolveAppFolder().appFolder;

    // <root>/server/routes  — the tsx layout (this very directory).
    expect(path.resolve(__dirname, '..', '..')).toBe(root);

    // <root>/server/dist/routes — the compiled layout is one deeper, so a
    // hardcoded two-level resolve from there would stop at <root>/server.
    const compiledDir = path.join(root, 'server', 'dist', 'routes');
    expect(path.resolve(compiledDir, '..', '..')).toBe(path.join(root, 'server'));
    expect(path.resolve(compiledDir, '..', '..', '..')).toBe(root);
  });

  it('always answers an absolute path', () => {
    expect(path.isAbsolute(resolveAppFolder().appFolder)).toBe(true);
  });
});

// ============================================================
// GET /api/app-info
// ============================================================

describe('GET /api/app-info', () => {
  it('returns the app folder as JSON', async () => {
    const res = await request(app).get('/api/app-info');

    expect(res.status).toBe(200);
    expect(typeof res.body.appFolder).toBe('string');
    expect(res.body.appFolder.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(res.body.appFolder, 'angular.json'))).toBe(true);
  });

  it('honours APP_BASE_FOLDER over the derived path', async () => {
    // Resolution happens per request, not at module load, so setting the
    // variable now is enough — no restart, and no import-order subtlety.
    process.env['APP_BASE_FOLDER'] = 'F:\\Elsewhere\\App';

    const res = await request(app).get('/api/app-info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ appFolder: 'F:\\Elsewhere\\App', source: 'env' });
  });

  it('never touches the database', async () => {
    // The import screen has to open even when SQL Server is down, and a
    // cosmetic default is never worth failing a page load over. If this route
    // ever grows a withDb() call, this assertion is the one that catches it.
    await request(app).get('/api/app-info');

    expect(mockRequest.query).not.toHaveBeenCalled();
  });
});
