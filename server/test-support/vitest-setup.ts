/**
 * test-support/vitest-setup.ts — THE GUARD THAT KEEPS THE SUITE OFF THE
 * OWNER'S COLLECTION.
 *
 * Loaded by vitest.config.ts into EVERY spec file, before any of them runs.
 *
 * *** WHY THIS IS NOT LEFT TO test-support/sqlite-test-db.ts. ***
 *
 * That module sets COIN_INVENTORY_DB_PATH to ':memory:' as a side effect of
 * being imported, which works perfectly for every spec that imports it — and
 * does nothing at all for a spec that does not. The suite is one forgotten
 * import away from `buildDbConfig()` resolving
 * `%LOCALAPPDATA%\CoinInventory\coin-inventory.db`, which is the user's real
 * collection, and from `resetTestDatabase()`'s `DELETE FROM Coins` running
 * against it.
 *
 * THIS IS NOT HYPOTHETICAL. It happened during the migration itself: an
 * intermediate version of one spec cleared the variable and did not put it
 * back, a later file in the same run opened the real path, and a
 * fully-seeded `coin-inventory.db` with the test fixtures in it appeared
 * under %LOCALAPPDATA%. Nothing failed. No test went red. The only reason it
 * was noticed was somebody listing the directory for an unrelated reason.
 *
 * So the setting is applied globally rather than per-import, and — because a
 * global default is still only a default — a test that changes it is caught
 * and named:
 *
 *   beforeEach  re-asserts ':memory:', so one careless test cannot poison
 *               every test after it.
 *   afterEach   FAILS if the variable was left pointing anywhere else, so
 *               the careless test is the one that goes red rather than some
 *               innocent file later in the run.
 *
 * A test that legitimately needs a different path — server.spec.ts and
 * routes/db-error-response.spec.ts point it at a directory to make the open
 * fail for real — must put it back before the test ends. That is what the
 * afterEach enforces, and it is cheap: `await rebuildTestDatabase()`.
 */

import { afterEach, beforeEach, expect } from 'vitest';

import { DB_PATH_ENV_VAR, DB_DIR_ENV_VAR, IN_MEMORY_DATABASE } from '../db/config';

/** Applied once, as this module loads, before any spec is imported. */
process.env[DB_PATH_ENV_VAR] = IN_MEMORY_DATABASE;
// A stale COIN_INVENTORY_DATA_DIR in the developer's shell would be ignored
// while the path override is set, but deleting it removes the question.
delete process.env[DB_DIR_ENV_VAR];

beforeEach(() => {
  process.env[DB_PATH_ENV_VAR] = IN_MEMORY_DATABASE;
  delete process.env[DB_DIR_ENV_VAR];
});

afterEach(() => {
  // Deliberately an assertion and not a silent reset: a test that leaves the
  // variable elsewhere has a bug, and a reset would hide it until the day
  // the ordering changed.
  expect(
    process.env[DB_PATH_ENV_VAR],
    `This test left ${DB_PATH_ENV_VAR} pointing somewhere other than ':memory:'. ` +
      `The next spec file would open the real collection under %LOCALAPPDATA% and ` +
      `delete rows from it. Restore it before the test ends — rebuildTestDatabase() does.`
  ).toBe(IN_MEMORY_DATABASE);
});
