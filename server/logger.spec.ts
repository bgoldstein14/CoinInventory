/**
 * The logger against a real directory: dated files, rolling at the cap,
 * adopting a legacy app.log, pruning, and reading the newest lines across a
 * roll. The policy arithmetic is in log-rotation.spec.ts.
 *
 * COIN_LOG_DIR gives each test a temp directory. Each test imports the logger
 * fresh, since it memoises its directory and startup housekeeping.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir: string;

/** A logger bound to this test's throwaway directory. */
async function freshLogger() {
  vi.resetModules();
  process.env['COIN_LOG_DIR'] = dir;
  return await import('./logger');
}

/** Everything in the throwaway directory, sorted for stable assertions. */
function names(): string[] {
  return fs.readdirSync(dir).sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-logger-'));
  // Silence the console echo; restored by vi.restoreAllMocks().
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env['COIN_LOG_DIR'];
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('where lines go', () => {
  it('writes into a dated file, never into the old unbounded app.log', async () => {
    const logger = await freshLogger();
    logger.logInfo('hello');

    const written = names();
    expect(written).not.toContain('app.log');
    expect(written.some(n => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(n))).toBe(true);
  });

  it('keeps the existing line format exactly', async () => {
    const logger = await freshLogger();
    logger.logInfo('a message');
    logger.logError('boom', new Error('detail'));

    const contents = fs.readFileSync(path.join(dir, names()[0]), 'utf8');
    expect(contents).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] a message$/m);
    expect(contents).toMatch(/\[ERROR\] boom \| detail/);
  });

  it('creates the log directory if it is missing', async () => {
    const nested = path.join(dir, 'deep', 'logs');
    vi.resetModules();
    process.env['COIN_LOG_DIR'] = nested;
    const logger = await import('./logger');
    logger.logInfo('hello');

    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.readdirSync(nested).length).toBe(1);
  });

  it('exposes the directory it is using', async () => {
    const logger = await freshLogger();
    expect(logger.getLogDirectory()).toBe(dir);
  });
});

describe('rolling at the size cap', () => {
  it('starts a new sequence file once the current one is full', async () => {
    const logger = await freshLogger();
    logger.setLogRotationLimits({ maxFileBytes: 300 });

    // Each line is well over 30 bytes, so ten of them clear a 300-byte cap.
    for (let i = 0; i < 20; i++) logger.logInfo(`line number ${i} padded out a bit`);

    const rolled = names().filter(n => /^app-\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(n));
    expect(rolled.length).toBeGreaterThan(0);
  });

  it('no single file ends up grossly over the cap', async () => {
    const logger = await freshLogger();
    logger.setLogRotationLimits({ maxFileBytes: 300 });
    for (let i = 0; i < 40; i++) logger.logInfo(`line number ${i} padded out a bit`);

    for (const name of names()) {
      // At most one line over the cap (size is checked before the write).
      expect(fs.statSync(path.join(dir, name)).size).toBeLessThan(300 + 200);
    }
  });
});

describe('adopting the pre-rotation app.log', () => {
  it('renames an existing app.log into the dated scheme on first write', async () => {
    fs.writeFileSync(path.join(dir, 'app.log'), 'forty thousand old lines\n');

    const logger = await freshLogger();
    logger.logInfo('new line');

    expect(fs.existsSync(path.join(dir, 'app.log'))).toBe(false);
    const adopted = names().filter(n => /^app-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(n));
    const joined = adopted.map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
    expect(joined).toContain('forty thousand old lines');
  });
});

describe('pruning', () => {
  it('deletes logs older than the retention window on first write', async () => {
    fs.writeFileSync(path.join(dir, 'app-2019-03-01.log'), 'ancient');
    fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'not ours');

    const logger = await freshLogger();
    logger.logInfo('new line');

    expect(fs.existsSync(path.join(dir, 'app-2019-03-01.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'keep-me.txt'))).toBe(true);
  });

  it('keeps a log from inside the window', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, `app-${yesterday}.log`), 'recent');

    const logger = await freshLogger();
    logger.logInfo('new line');

    expect(fs.existsSync(path.join(dir, `app-${yesterday}.log`))).toBe(true);
  });
});

describe('readRecentLogLines — what the support bundle reads', () => {
  it('returns the most recent lines, newest last', async () => {
    const logger = await freshLogger();
    for (let i = 0; i < 50; i++) logger.logInfo(`entry ${i}`);

    const lines = logger.readRecentLogLines(10);

    expect(lines).toHaveLength(10);
    expect(lines[9]).toContain('entry 49');
    expect(lines[0]).toContain('entry 40');
  });

  it('reaches back into the previous file when the newest one is short', async () => {
    const logger = await freshLogger();
    logger.setLogRotationLimits({ maxFileBytes: 400 });
    for (let i = 0; i < 40; i++) logger.logInfo(`entry ${i}`);

    const lines = logger.readRecentLogLines(40);

    // Across the roll: the oldest entry asked for predates the current file.
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.join('\n')).toContain('entry 0');
    expect(lines[lines.length - 1]).toContain('entry 39');
  });

  it('asks for more lines than exist and simply gets what there is', async () => {
    const logger = await freshLogger();
    logger.logInfo('only one');
    expect(logger.readRecentLogLines(500)).toHaveLength(1);
  });

  it('an empty log directory yields no lines rather than throwing', async () => {
    const logger = await freshLogger();
    expect(logger.readRecentLogLines(100)).toEqual([]);
  });

  it('lists the log files with sizes, newest first', async () => {
    const logger = await freshLogger();
    logger.logInfo('hello');

    const files = logger.listLogFiles();
    expect(files).toHaveLength(1);
    expect(files[0].bytes).toBeGreaterThan(0);
  });
});

describe('the logger never throws', () => {
  it('survives a log directory it cannot create', async () => {
    vi.resetModules();
    // A path whose parent is a FILE, so mkdir cannot succeed.
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    process.env['COIN_LOG_DIR'] = path.join(blocker, 'logs');

    const logger = await import('./logger');
    expect(() => logger.logInfo('still fine')).not.toThrow();
  });
});
