 /*
  * Tests for the denomination display rule (design §4.1), and that it is
  * implemented in only one place: the last describe block scans the source tree.
  */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { denominationDisplay, OTHER_DENOMINATION_PREFIX, NO_DENOMINATION } from './denomination-display';
// Imported only for the drift test; the module under test doesn't import it.
import { CUSTOM_OPTION_SENTINEL } from '../../components/coin-editor-form/custom-option-mode';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '../../..');
const THIS_MODULE = resolve(HERE, 'denomination-display.ts');

describe('denominationDisplay — the three cases of design §4.1', () => {
  it('shows the lookup Label when the id resolved to one', () => {
    // The label wins even when the recorded text disagrees.
    expect(denominationDisplay('8 Reales', 'Pillar Dollar')).toBe('8 Reales');
  });

  it('shows Other (<text>) when nothing resolved but something was recorded', () => {
    // Unresolved text is named rather than shown as a bare "Other".
    expect(denominationDisplay(null, '8 Reales')).toBe('Other (8 Reales)');
  });

  it('shows the placeholder when there is neither an id nor any text', () => {
    expect(denominationDisplay(null, null)).toBe('—');
    expect(denominationDisplay(undefined, undefined)).toBe('—');
    expect(denominationDisplay('', '')).toBe('—');
  });

  it('treats whitespace as absent on both sides', () => {
    // Whitespace-only values must not render as 'Other (   )'.
    expect(denominationDisplay('   ', '  ')).toBe('—');
    expect(denominationDisplay('   ', 'Trade Dollar')).toBe('Other (Trade Dollar)');
  });

  it('trims what it shows, but does not otherwise rewrite it', () => {
    // Trimmed for display, but the spelling is shown as stored.
    expect(denominationDisplay('  50¢  ', null)).toBe('50¢');
    expect(denominationDisplay(null, '  3¢ Silver  ')).toBe('Other (3¢ Silver)');
    expect(denominationDisplay(null, 'half DOLLAR')).toBe('Other (half DOLLAR)');
  });

  it('exports the pieces it is built from, so nobody has to retype them', () => {
    expect(OTHER_DENOMINATION_PREFIX).toBe('Other (');
    expect(NO_DENOMINATION).toBe('—');
  });
});

 /* Exactly one implementation */

/**
 * Removes `//`, `/* *``/` and `<!-- -->` comments, so files may explain the
 * rule without being flagged.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every .ts and .html file under src/, excluding specs and this module. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      sourceFiles(full, found);
      continue;
    }
    if (!/\.(ts|html)$/.test(entry)) continue;
    if (entry.endsWith('.spec.ts')) continue;
    if (resolve(full) === THIS_MODULE) continue;
    found.push(full);
  }
  return found;
}

describe('the rule is written down in exactly one place', () => {
  const files = sourceFiles(SRC_ROOT);

  it('found a source tree to scan, so the check below is not vacuous', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('the comment-stripper really removes prose, so the check below is not vacuous', () => {
    // Proves stripComments works: the module's doc comment mentions
    // `Other (8 Reales)` and must disappear, while its code must remain.
    const stripped = stripComments(readFileSync(THIS_MODULE, 'utf8'));
    expect(stripped).not.toContain('Other (8 Reales)');
    expect(stripped).toContain("OTHER_DENOMINATION_PREFIX = 'Other ('");
  });

  it('no other source file builds an "Other (...)" denomination label', () => {
    // No other file may build the label; import denominationDisplay instead.
    const offenders = files.filter((file) => stripComments(readFileSync(file, 'utf8')).includes('Other ('));
    expect(offenders).toEqual([]);
  });
});

 /*
  * `__OTHER__` (the editor's "Other" option value) exists in older rows from a
  * since-fixed bug and must not render as `Other (__OTHER__)`.
  */
describe('denominationDisplay — the __OTHER__ sentinel', () => {
  it('treats the sentinel as no denomination at all', () => {
    expect(denominationDisplay(null, '__OTHER__')).toBe(NO_DENOMINATION);
  });

  it('ignores surrounding whitespace on it', () => {
    expect(denominationDisplay(null, '  __OTHER__  ')).toBe(NO_DENOMINATION);
  });

  it('still prefers a real label when the coin has one', () => {
    // A resolved id wins regardless of the text.
    expect(denominationDisplay('100 Soles', '__OTHER__')).toBe('100 Soles');
  });

  it('does not suppress ordinary text that merely contains the word', () => {
    // Only the exact token is residue; "Other" could be real data.
    expect(denominationDisplay(null, 'Other')).toBe('Other (Other)');
    expect(denominationDisplay(null, '__OTHER__ Dollar')).toBe('Other (__OTHER__ Dollar)');
  });

  /** The spelling is duplicated (not imported); this test stops the copies drifting. */
  it('agrees with the editor on how the sentinel is spelled', () => {
    expect(denominationDisplay(null, CUSTOM_OPTION_SENTINEL)).toBe(NO_DENOMINATION);
  });
});
