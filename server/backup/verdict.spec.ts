/**
 * The restore decision rules, exhaustively and at the boundaries.
 * backup/restore.spec.ts covers the same refusals against real files.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../db';
import { classifyRestoreCandidate, REQUIRED_TABLES, TABLES_CREATED_ON_OPEN, type CandidateFacts } from './verdict';

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

  it('refuses a NEWER schema version, and says what to do about it', () => {
    const decision = classifyRestoreCandidate(
      goodFile({ schemaVersion: SCHEMA_VERSION + 1 })
    );
    expect(decision.verdict).toBe('newer-schema');
    expect(decision.acceptable).toBe(false);
    // Both versions, and the fix.
    expect(decision.message).toContain(String(SCHEMA_VERSION + 1));
    expect(decision.message).toContain(String(SCHEMA_VERSION));
    expect(decision.message).toMatch(/update coin inventory/i);
    // And reassurance that nothing was changed.
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
    // Version 0 (pre-stamping) is accepted on its tables, with a note that
    // the version couldn't be confirmed.
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
    // Only newer versions are refused.
    const decision = classifyRestoreCandidate(goodFile({ schemaVersion: SCHEMA_VERSION }));
    expect(decision.acceptable).toBe(true);
  });
});

describe('classifyRestoreCandidate — the order of the checks', () => {
  it('reports "not SQLite" rather than "missing tables" for a text file', () => {
    // Both are true of a renamed JPEG; report the first.
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
    // A foreign database with a high user_version is refused as foreign.
    const decision = classifyRestoreCandidate(
      goodFile({ tables: ['something-else'], schemaVersion: 500 })
    );
    expect(decision.verdict).toBe('not-this-app');
  });
});

describe('a backup made before catalogue references were a table', () => {
  it('is accepted, since opening it creates and fills CoinCatalogRefs', () => {
    const decision = classifyRestoreCandidate(goodFile({ schemaVersion: 1 }));
    expect(decision.acceptable).toBe(true);
  });
});

describe('REQUIRED_TABLES', () => {
  /**
   * REQUIRED_TABLES is hand-written (see verdict.ts); this flags when a table
   * is added to schema.sql so SCHEMA_VERSION gets considered.
   */
  it('matches the tables db/schema.sql actually creates', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    const created = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
      .map((match) => match[1]!)
      .sort();

    expect([...REQUIRED_TABLES, ...TABLES_CREATED_ON_OPEN].sort()).toEqual(created);
  });

  it('is not empty, which would make every file acceptable', () => {
    expect(REQUIRED_TABLES.length).toBeGreaterThan(5);
  });
});
