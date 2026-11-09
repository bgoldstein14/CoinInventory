/*
 * The templates are actually plugged in.
 *
 * WHY A GREP AND NOT A REAL TEST
 *
 * This suite runs under Node with NO jsdom, so nothing here can render an
 * Angular template and read the text out of it. `collection-zero-state.spec.ts`
 * tests the DECISION exhaustively; the decision is worthless if the grid
 * never asks for it, and that wiring lives entirely inside .html files.
 *
 * A source grep is the only instrument available. It is a weak test of a
 * strong requirement, and it catches precisely the mutation that matters: a
 * template deciding for itself, on `inventory().length === 0` alone, that
 * the user owns no coins.
 *
 * `denomination-lookup-wiring.spec.ts` and `no-unguarded-image-paths.spec.ts`
 * are the other checks of this shape.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY ASSERTION. A grep test that reads its
 * own documentation is not a test — the files searched here carry long
 * comments quoting the very strings being searched for, and without the
 * stripping those comments alone would satisfy the assertions.
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
    // `inv.inventory().length === 0` is true both for "you own no coins" and
    // for "we have not fetched them yet", and the template cannot tell those
    // apart.
    expect(GRID_TEMPLATE).not.toContain('inv.inventory().length === 0');
  });

  it('builds its zero state from the connection signals, not just the list', () => {
    // `connected` is set only once the coin fetch has actually come back
    // (ConnectionManager.hydrate phase 1), which is what makes "the list has
    // arrived" knowable at all.
    expect(GRID_COMPONENT).toContain('collectionZeroState');
    expect(GRID_COMPONENT).toContain('this.inv.connected()');
    expect(GRID_COMPONENT).toContain('this.inv.connectionError()');
  });
});

describe('the screens that show aggregates do not report zeros before the data lands', () => {
  // A hero figure of "$0.00" and a "no coin is recorded as gold" message are
  // the same lie as "No coins yet", told with numbers. Both screens read the
  // same pure helper rather than inventing a second rule.

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
  // The other half of the same principle: a single hard-coded "Database
  // unavailable" heading is wrong for failures where the database answered
  // perfectly well, so the heading comes from the classified failure.
  const APP_TEMPLATE = stripComments(read('app/app.html'));

  it('takes its heading from the classified failure', () => {
    expect(APP_TEMPLATE).toContain('inv.loadFailure()');
    expect(APP_TEMPLATE).not.toContain('<strong>Database unavailable</strong>');
  });

  it('shows the technical detail as its own element, not inside the sentence', () => {
    // `RangeError: Invalid string length in GET /api/coins` is what whoever
    // is debugging needs and what a non-technical user cannot act on, so it
    // gets its own dimmed element beside the sentence rather than being
    // spliced into it.
    expect(APP_TEMPLATE).toContain('failure.detail');
    expect(APP_TEMPLATE).toContain('db-error-banner__detail');
  });
});
