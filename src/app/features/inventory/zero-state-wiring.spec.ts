/*
 * Checks that the templates actually use the zero-state helpers. The suite has
 * no DOM, so this reads the source as text; comments are stripped first so
 * documentation can't satisfy an assertion.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** This file lives at src/app/features/inventory, so src/ is three up. */
const SRC_ROOT = resolve(HERE, '..', '..', '..');

function read(relative: string): string {
  return readFileSync(resolve(SRC_ROOT, relative), 'utf8');
}

/** HTML and TS comments out, so documentation cannot satisfy a test. */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const GRID_TEMPLATE = stripComments(read('app/components/inventory-table/inventory-table.html'));
const GRID_COMPONENT = stripComments(read('app/components/inventory-table/inventory-table.ts'));

describe('the inventory grid asks the shared module what to say', () => {
  it('renders the zero-state message rather than deciding for itself', () => {
    expect(GRID_TEMPLATE).toContain('zeroState().message');
  });

  it('no longer branches on the raw coin count', () => {
    // Can't tell "no coins" from "not fetched yet".
    expect(GRID_TEMPLATE).not.toContain('inv.inventory().length === 0');
  });

  it('builds its zero state from the connection signals, not just the list', () => {
    // `connected` is set only once the coin fetch has come back.
    expect(GRID_COMPONENT).toContain('collectionZeroState');
    expect(GRID_COMPONENT).toContain('this.inv.connected()');
    expect(GRID_COMPONENT).toContain('this.inv.connectionError()');
  });
});

describe('the screens that show aggregates do not report zeros before the data lands', () => {
  // Both screens use the same helper rather than a second rule.

  it('the statistics modal guards its body on the load state', () => {
    const template = stripComments(read('app/components/statistics-modal/statistics-modal.html'));
    const component = stripComments(read('app/components/statistics-modal/statistics-modal.ts'));

    expect(component).toContain('collectionNotReadyNotice');
    expect(template).toContain('notReadyNotice()');
  });

  it('the report summary guards its figures on the load state', () => {
    const template = stripComments(read('app/components/report-modal/report-modal.html'));
    const component = stripComments(read('app/components/report-modal/report-modal.ts'));

    expect(component).toContain('collectionNotReadyNotice');
    expect(template).toContain('notReadyNotice()');
  });
});

describe('the connection banner reports the stage it was told about', () => {
  // A fixed "Database unavailable" heading would be wrong for non-database failures.
  const APP_TEMPLATE = stripComments(read('app/app.html'));

  it('takes its heading from the classified failure', () => {
    expect(APP_TEMPLATE).toContain('inv.loadFailure()');
    expect(APP_TEMPLATE).not.toContain('<strong>Database unavailable</strong>');
  });

  it('shows the technical detail as its own element, not inside the sentence', () => {
    // Technical detail gets its own dimmed element.
    expect(APP_TEMPLATE).toContain('failure.detail');
    expect(APP_TEMPLATE).toContain('db-error-banner__detail');
  });
});
