/**
 * db/driver-isolation.spec.ts — THE SQLITE PACKAGE IS NAMED IN EXACTLY ONE
 * FILE, AND THIS IS WHAT MAKES THAT TRUE.
 *
 * db/driver.ts is the only file allowed to import a SQLite package. The whole
 * value of that rule is a promise about a change nobody has had to make yet:
 * design §4.3 records that Electron bundles its own Node, that the bundled
 * Node may not expose `node:sqlite`, and that if it does not, the fallback to
 * `better-sqlite3` must cost one file rather than a rewrite of the data
 * layer.
 *
 * A promise like that decays silently. One `import { DatabaseSync } from
 * 'node:sqlite'` added to a route during a debugging session, left in,
 * reviewed by nobody — and the one-file swap is a two-file swap, then a
 * five-file swap, and the decision the spec made is quietly undone. So it is
 * checked mechanically on every run.
 *
 * The same test also forbids importing `mssql` from production code. Those
 * packages deliberately STAY in package.json — Stage 2's one-time import
 * needs them to read the owner's live SQL Server — so nothing else stops a
 * stray import compiling.
 *
 * *** THE mssql RULE NOW HAS EXACTLY ONE NAMED EXCEPTION, AND IT IS THE ONE
 * THIS FILE'S ORIGINAL COMMENT PREDICTED. *** Stage 2 has been built:
 * migrate-sqlserver/mssql-source-reader.ts reads the owner's live SQL
 * Server. The rule it must still enforce is unchanged in spirit — mssql is
 * out of the RUNTIME path — so rather than deleting the check, the check now
 * says where the one permitted import is, and adds two assertions that keep
 * the exception from rotting into a loophole:
 *
 *   - the reader really does import mssql (so the exception is not an
 *     entry for a file that stopped needing it);
 *   - migrate-sqlserver/ is excluded from tsconfig.build.json, so nothing
 *     in it can reach dist/ and therefore nothing in the shipped server can
 *     reach mssql.
 *
 * If you are reading this because you want a SECOND exception: don't. The
 * whole folder is deleted once the owner's data has moved.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER_ROOT = path.join(__dirname, '..');

/** The one file permitted to name a SQLite package, relative to server/. */
const DRIVER_FILE = path.join('db', 'driver.ts');

/**
 * This file. Skipped, and NOT as an allow-list entry — it contains
 * import-shaped STRING LITERALS as fixtures for the detector below, so a
 * scan that read it would report itself. Nothing is being exempted: a real
 * import here would import nothing into the application, because this file
 * is a spec and is not in the runtime graph.
 *
 * If you are reading this because you want to add a second entry: don't.
 * Route the need through db/driver.ts's interfaces. That is the whole point
 * of the rule, and the moment there are two exceptions there will be five.
 */
const THIS_FILE = path.join('db', 'driver-isolation.spec.ts');

/** Packages that must not be imported anywhere else. */
const SQLITE_PACKAGES = ['node:sqlite', 'better-sqlite3', 'sqlite3', 'bun:sqlite'];

/** Packages that may not be imported by RUNTIME code at all any more. */
const SQL_SERVER_PACKAGES = ['mssql', 'msnodesqlv8'];

/**
 * The one file permitted to name a SQL Server package, relative to server/.
 * Stage 2's one-time import. See this file's header before adding another.
 */
const MSSQL_READER_FILE = path.join('migrate-sqlserver', 'mssql-source-reader.ts');

/** The folder that one file lives in. Nothing in it ships. */
const MIGRATION_TOOL_DIRECTORY = 'migrate-sqlserver';

/** Directories that hold no source of ours. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'logs', '.git']);

/** Every .ts file under server/, as paths relative to server/. */
function sourceFiles(directory: string = SERVER_ROOT): string[] {
  const found: string[] = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(path.relative(SERVER_ROOT, full));
    }
  }

  return found;
}

/**
 * True when `source` imports `packageName`.
 *
 * Matches `from 'pkg'`, `require('pkg')`, `import('pkg')` AND the bare
 * side-effect form `import 'pkg';`. That last one is easy to leave out and
 * is the obvious way to slip past a check like this by accident — it loads
 * the module just as completely as the others. Deliberately crude otherwise:
 * the point is to catch a real import being added, not to parse TypeScript.
 *
 * It must NOT match the package name appearing in prose, which these files
 * do constantly — db/index.ts, db/schema.sql's header and half the specs
 * discuss `mssql` by name at length — so every alternative below requires an
 * import-shaped token immediately before the quote.
 */
function importsPackage(source: string, packageName: string): boolean {
  const quoted = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:from|require\\s*\\(|import\\s*\\(|^\\s*import)\\s*['"]${quoted}['"]`,
    'm'
  ).test(source);
}

describe('the SQLite driver is isolated to db/driver.ts', () => {
  const files = sourceFiles();

  it('found the source tree (a guard against this whole file silently passing)', () => {
    // A directory walk that returns nothing makes every assertion below
    // trivially true, which is worse than having no test.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(DRIVER_FILE);
  });

  it('recognises every import form, including the bare side-effect one', () => {
    // The detector is the whole test. If it stops matching a form, the rule
    // it enforces quietly stops being enforced for that form.
    expect(importsPackage("import { DatabaseSync } from 'node:sqlite';", 'node:sqlite')).toBe(true);
    expect(importsPackage("const s = require('node:sqlite');", 'node:sqlite')).toBe(true);
    expect(importsPackage("await import('node:sqlite')", 'node:sqlite')).toBe(true);
    expect(importsPackage("import 'node:sqlite';", 'node:sqlite')).toBe(true);
    expect(importsPackage("  import 'node:sqlite';", 'node:sqlite')).toBe(true);
    // ...and does not fire on the package being discussed in a comment,
    // which half the files in this folder do at length.
    expect(importsPackage(' * mssql trimmed the value before sending it.', 'mssql')).toBe(false);
    expect(importsPackage("// we no longer use 'mssql' here", 'mssql')).toBe(false);
  });

  it('db/driver.ts really does import the SQLite package', () => {
    // The other half: if the driver stopped importing it, the rule below
    // would hold for a reason nobody intended.
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

    // If this fails: do not add the file to an allow-list. Route the need
    // through db/driver.ts's interfaces instead — that is the entire point.
    expect(offenders).toEqual([]);
  });

  it('only the Stage 2 reader imports mssql or msnodesqlv8', () => {
    // They stay INSTALLED — Stage 2's one-time migration script reads the
    // owner's live SQL Server with them, and they are deleted only after he
    // confirms his data has moved. Exactly one file may name them, and
    // nothing but this test says so.
    const offenders: string[] = [];

    for (const file of files) {
      if (file === THIS_FILE || file === MSSQL_READER_FILE) continue;
      const source = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
      for (const pkg of SQL_SERVER_PACKAGES) {
        if (importsPackage(source, pkg)) offenders.push(`${file} imports ${pkg}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the Stage 2 reader really is the file that imports mssql', () => {
    // The other half of the exception. Without this, the allow-list entry
    // could outlive the need for it and quietly become a hole.
    const reader = fs.readFileSync(path.join(SERVER_ROOT, MSSQL_READER_FILE), 'utf8');
    expect(importsPackage(reader, 'mssql')).toBe(true);
  });

  it('the Stage 2 folder is excluded from the production build', () => {
    // This is what makes the exception safe rather than merely declared:
    // `npm run build` compiles tsconfig.build.json, so a folder it excludes
    // cannot reach dist/, and `node dist/server.js` can therefore never
    // load mssql however many files in migrate-sqlserver/ import it.
    const buildConfig = fs.readFileSync(
      path.join(SERVER_ROOT, 'tsconfig.build.json'),
      'utf8'
    );
    const excluded = buildConfig
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(excluded).toContain(`"${MIGRATION_TOOL_DIRECTORY}"`);
  });

  it('nothing in the application imports the Stage 2 folder', () => {
    // The folder is deleted once the owner's data has moved, so anything
    // that grew a dependency on it would break at exactly the wrong moment.
    const offenders: string[] = [];

    for (const file of files) {
      if (file === THIS_FILE) continue;
      if (file.startsWith(`${MIGRATION_TOOL_DIRECTORY}${path.sep}`)) continue;
      const source = fs.readFileSync(path.join(SERVER_ROOT, file), 'utf8');
      if (/from\s+['"][^'"]*migrate-sqlserver\//.test(source)) {
        offenders.push(`${file} imports from migrate-sqlserver/`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('mssql and msnodesqlv8 are still declared in package.json', () => {
    // The other direction, and it matters just as much: removing them before
    // the owner's data is out of SQL Server would strand the only route his
    // collection has out of it.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.['mssql']).toBeDefined();
    expect(manifest.dependencies?.['msnodesqlv8']).toBeDefined();
  });
});
