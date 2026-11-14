/**
 * vitest.config.ts — exists for exactly one reason: `setupFiles`.
 *
 * Every other setting is Vitest's default and is left alone deliberately,
 * so that reading this file tells you the one thing that is not default.
 *
 * test-support/vitest-setup.ts points the data layer at an in-memory
 * database for every spec file, whether or not that file remembers to
 * import the test harness, and fails any test that leaves the setting
 * pointing elsewhere. Read its header: the failure it prevents has already
 * happened once, and it happened silently.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test-support/vitest-setup.ts'],
  },
});
