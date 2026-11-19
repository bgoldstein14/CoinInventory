/**
 * Global vitest setup (every spec file): keeps the suite off the real
 * collection database under %LOCALAPPDATA%.
 *
 *   beforeEach  forces COIN_INVENTORY_DB_PATH to ':memory:'.
 *   afterEach   fails the test if it left the variable pointing elsewhere.
 *
 * A test that needs a different path must restore it before it ends,
 * e.g. with `await rebuildTestDatabase()`.
 */

import { afterEach, beforeEach, expect } from 'vitest';

import { DB_PATH_ENV_VAR, DB_DIR_ENV_VAR, IN_MEMORY_DATABASE } from '../db/config';

// Applied as this module loads, before any spec is imported.
process.env[DB_PATH_ENV_VAR] = IN_MEMORY_DATABASE;
delete process.env[DB_DIR_ENV_VAR];

beforeEach(() => {
  process.env[DB_PATH_ENV_VAR] = IN_MEMORY_DATABASE;
  delete process.env[DB_DIR_ENV_VAR];
});

afterEach(() => {
  // Assert rather than reset, so the offending test is the one that fails.
  expect(
    process.env[DB_PATH_ENV_VAR],
    `This test left ${DB_PATH_ENV_VAR} pointing somewhere other than ':memory:'. ` +
      `The next spec file would open the real collection under %LOCALAPPDATA% and ` +
      `delete rows from it. Restore it before the test ends — rebuildTestDatabase() does.`
  ).toBe(IN_MEMORY_DATABASE);
});
