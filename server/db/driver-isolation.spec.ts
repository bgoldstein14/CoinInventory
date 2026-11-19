/**
 * Only db/driver.ts may import a SQLite package, so swapping the driver (for a
 * host without node:sqlite) stays a one-file change.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = path.join(__dirname, '..');
const DRIVER_FILE = path.join('db', 'driver.ts');
const THIS_FILE = path.join('db', 'driver-isolation.spec.ts');
const SQLITE_PACKAGES = ['node:sqlite', 'better-sqlite3', 'sqlite3', 'bun:sqlite'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'logs', '.git']);

/** Every .ts file under server/, relative to server/. */
function sourceFiles(directory: string = SERVER_ROOT): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) found.push(...sourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(path.relative(SERVER_ROOT, full));
    }
  }
  return found;
}

/** True when `source` imports `packageName` (from, require, dynamic or bare import; not prose). */
function importsPackage(source: string, packageName: string): boolean {
  const quoted = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:from|require\\s*\\(|import\\s*\\(|^\\s*import)\\s*['"]${quoted}['"]`, 'm').test(source);
}

describe('the SQLite driver is isolated to db/driver.ts', () => {
  const files = sourceFiles();

  it('found the source tree', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(DRIVER_FILE);
  });

  it('recognises every import form, and not the package named in a comment', () => {
    expect(importsPackage("import { DatabaseSync } from 'node:sqlite';", 'node:sqlite')).toBe(true);
    expect(importsPackage("const s = require('node:sqlite');", 'node:sqlite')).toBe(true);
    expect(importsPackage("await import('node:sqlite')", 'node:sqlite')).toBe(true);
    expect(importsPackage("  import 'node:sqlite';", 'node:sqlite')).toBe(true);
    expect(importsPackage("// opens 'node:sqlite' lazily", 'node:sqlite')).toBe(false);
  });

  it('db/driver.ts imports the SQLite package', () => {
    const driver = fs.readFileSync(path.join(SERVER_ROOT, DRIVER_FILE), 'utf8');
    expect(SQLITE_PACKAGES.some((pkg) => importsPackage(driver, pkg))).toBe(true);
  });

  it('no other file imports a SQLite package', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === DRIVER_FILE || file === THIS_FILE) continue;
      const source = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
      for (const pkg of SQLITE_PACKAGES) {
        if (importsPackage(source, pkg)) offenders.push(`${file} imports ${pkg}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
