/**
 * backup/verdict.spec.ts — the refusals, held still.
 *
 * backup/restore.spec.ts proves the refusals work against real files. This
 * file proves the RULE is right, exhaustively and instantly, because the
 * rule is pure. The two are not duplicates: an integration test can only
 * afford a handful of cases, and the interesting ones here are the
 * boundaries — exactly equal, one more, one less.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../db';
import { classifyRestoreCandidate, REQUIRED_TABLES, type CandidateFacts } from './verdict';

/** A file that is entirely fine, which each test then spoils one way. */
function goodFile(overrides: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    fileExists: true,
    looksLikeSqlite: true,
    openError: null,
    tables: [...REQUIRED_TABLES],
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

describe('classifyRestoreCandidate — the five refusals', () => {
  it('refuses a path with no file at it', () => {
    const decision = classifyRestoreCandidate(goodFile({ fileExists: false }));
    expect(decision.verdict).toBe('missing');
    expect(decision.acceptable).toBe(false);
  });

  it('refuses a file that is not SQLite', () => {
    const decision = classifyRestoreCandidate(goodFile({ looksLikeSqlite: false }));
    expect(decision.verdict).toBe('not-sqlite');
    expect(decision.acceptable).toBe(false);
  });

  it('refuses a SQLite file that will not open', () => {
    const decision = classifyRestoreCandidate(
      goodFile({ openError: 'database disk image is malformed' })
    );
    expect(decision.verdict).toBe('unreadable');
    expect(decision.acceptable).toBe(false);
  });

  it('refuses a database that is missing even ONE of our tables', () => {
    for (const table of REQUIRED_TABLES) {
      const decision = classifyRestoreCandidate(
        goodFile({ tables: REQUIRED_TABLES.filter((name) => name !== table) })
      );
      expect(decision.verdict, `dropping ${table} should be refused`).toBe('not-this-app');
      expect(decision.missingTables).toEqual([table]);
    }
  });

  it('refuses a database with none of our tables at all', () => {
    const decision = classifyRestoreCandidate(goodFile({ tables: ['sessions', 'users'] }));
    expect(decision.verdict).toBe('not-this-app');
    expect(decision.missingTables).toEqual([...REQUIRED_TABLES]);
  });

  /* *** THE ONE WITH NO WAY ROUND IT. *** */
  it('refuses a NEWER schema version, and says what to do about it', () => {
    const decision = classifyRestoreCandidate(
      goodFile({ schemaVersion: SCHEMA_VERSION + 1 })
    );
    expect(decision.verdict).toBe('newer-schema');
    expect(decision.acceptable).toBe(false);
    // Both numbers, so the user can see which is which, and the actual fix.
    expect(decision.message).toContain(String(SCHEMA_VERSION + 1));
    expect(decision.message).toContain(String(SCHEMA_VERSION));
    expect(decision.message).toMatch(/update coin inventory/i);
    // And the reassurance that matters most at that moment.
    expect(decision.message).toMatch(/not been touched/i);
  });

  it('refuses every version above this one, not just the next', () => {
    for (const version of [SCHEMA_VERSION + 1, SCHEMA_VERSION + 2, 99, 1_000_000]) {
      expect(classifyRestoreCandidate(goodFile({ schemaVersion: version })).acceptable).toBe(
        false
      );
    }
  });
});

describe('classifyRestoreCandidate — what it accepts', () => {
  it('accepts this build\'s own version', () => {
    const decision = classifyRestoreCandidate(goodFile());
    expect(decision.verdict).toBe('ok');
    expect(decision.acceptable).toBe(true);
  });

  it('accepts an UNSTAMPED file, because 0 is a date and not a fault', () => {
    // `PRAGMA user_version` defaults to 0 and this application never set it
    // before 2026-11-14. Those databases have the same eleven tables, so
    // they are accepted on their shape — but the user is told the version
    // could not be confirmed, because they are about to replace a
    // collection with it.
    const decision = classifyRestoreCandidate(goodFile({ schemaVersion: 0 }));
    expect(decision.verdict).toBe('unversioned');
    expect(decision.acceptable).toBe(true);
    expect(decision.message).toMatch(/cannot be confirmed|before Coin Inventory started/i);
  });

  it('treats a missing version the same as 0 rather than crashing on null', () => {
    const decision = classifyRestoreCandidate(goodFile({ schemaVersion: null }));
    expect(decision.verdict).toBe('unversioned');
    expect(decision.acceptable).toBe(true);
  });

  it('accepts an OLDER version, which is the whole point of having a number', () => {
    // Nothing is older than 1 yet, so this is the guard that stops a future
    // bump from accidentally refusing every file ever written. Only
    // "newer" is refused.
    const decision = classifyRestoreCandidate(goodFile({ schemaVersion: SCHEMA_VERSION }));
    expect(decision.acceptable).toBe(true);
  });
});

describe('classifyRestoreCandidate — the order of the checks', () => {
  it('reports "not SQLite" rather than "missing tables" for a text file', () => {
    // Both are true of a renamed JPEG. The useful answer is the first one.
    const decision = classifyRestoreCandidate(
      goodFile({ looksLikeSqlite: false, tables: [] })
    );
    expect(decision.verdict).toBe('not-sqlite');
  });

  it('reports "missing" above everything else', () => {
    const decision = classifyRestoreCandidate({
      fileExists: false,
      looksLikeSqlite: false,
      openError: 'nope',
      tables: [],
      schemaVersion: null,
    });
    expect(decision.verdict).toBe('missing');
  });

  it('checks the tables BEFORE the version', () => {
    // A stranger's database that happens to carry a high user_version
    // should be refused for being a stranger's, which is the sentence the
    // user can act on.
    const decision = classifyRestoreCandidate(
      goodFile({ tables: ['something-else'], schemaVersion: 500 })
    );
    expect(decision.verdict).toBe('not-this-app');
  });
});

describe('REQUIRED_TABLES', () => {
  /**
   * The list is hand-written rather than derived from db/schema.sql, and
   * the header of verdict.ts explains why: it is the contract for an
   * ACCEPTABLE FILE, not a description of what this build creates. That
   * only stays safe if somebody is told when the two diverge — adding a
   * table to schema.sql without thinking about SCHEMA_VERSION is exactly
   * the change this catches.
   */
  it('matches the tables db/schema.sql actually creates', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    const created = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
      .map((match) => match[1]!)
      .sort();

    expect([...REQUIRED_TABLES].sort()).toEqual(created);
  });

  it('is not empty, which would make every file acceptable', () => {
    expect(REQUIRED_TABLES.length).toBeGreaterThan(5);
  });
});
