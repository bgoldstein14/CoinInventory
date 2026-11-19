/**
 * Only non-default setting: `setupFiles`. test-support/vitest-setup.ts points
 * the data layer at an in-memory database for every spec and fails any test
 * that leaves it pointing elsewhere, so tests never touch the real collection.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test-support/vitest-setup.ts'],
  },
});
