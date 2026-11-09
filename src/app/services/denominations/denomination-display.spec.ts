 /*
 * denomination-display.spec.ts — the ONE place the display rule lives
 *
 * The rule (design §4.1) is three lines long, which is exactly why it is
 * dangerous: it is short enough that the next person writing a grid cell, a
 * report row or a tooltip will re-derive it inline rather than import it.
 * Then one of the copies says `Other (8 Reales)` and another says
 * `Other - 8 Reales`, and the same coin reads two ways on two screens.
 *
 * So these tests cover the rule AND the uniqueness of the rule. The last
 * describe block greps the source tree.
  */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { denominationDisplay, OTHER_DENOMINATION_PREFIX, NO_DENOMINATION } from './denomination-display';
// Imported ONLY so the drift test below can compare the two spellings of the
// sentinel. The module under test deliberately does not import it.
import { CUSTOM_OPTION_SENTINEL } from '../../components/coin-editor-form/custom-option-mode';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '../../..');
const THIS_MODULE = resolve(HERE, 'denomination-display.ts');

describe('denominationDisplay — the three cases of design §4.1', () => {
  it('shows the lookup Label when the id resolved to one', () => {
    // The id is authoritative. Even when the recorded text disagrees with it
    // — which is the normal state after an import that resolved — the label
    // wins, because the label is what the user picked or what the resolver
    // established and the text is only what the source happened to say.
    expect(denominationDisplay('8 Reales', 'Pillar Dollar')).toBe('8 Reales');
  });

  it('shows Other (<text>) when nothing resolved but something was recorded', () => {
    // This is the whole reason Coins.Denomination survives as a column. A
    // bare "Other" says something has been lost without saying what.
    expect(denominationDisplay(null, '8 Reales')).toBe('Other (8 Reales)');
  });

  it('shows the placeholder when there is neither an id nor any text', () => {
    expect(denominationDisplay(null, null)).toBe('—');
    expect(denominationDisplay(undefined, undefined)).toBe('—');
    expect(denominationDisplay('', '')).toBe('—');
  });

  it('treats whitespace as absent on both sides', () => {
    // A column that has held free text for years holds '   ' somewhere.
    // Rendering 'Other (   )' would be a visible bug on a row the user can
    // do nothing about.
    expect(denominationDisplay('   ', '  ')).toBe('—');
    expect(denominationDisplay('   ', 'Trade Dollar')).toBe('Other (Trade Dollar)');
  });

  it('trims what it shows, but does not otherwise rewrite it', () => {
    // Trimming is presentation. Changing the user's spelling is not: the text
    // is evidence of what the source said and it is shown verbatim so the
    // owner can recognise it and re-map it.
    expect(denominationDisplay('  50¢  ', null)).toBe('50¢');
    expect(denominationDisplay(null, '  3¢ Silver  ')).toBe('Other (3¢ Silver)');
    expect(denominationDisplay(null, 'half DOLLAR')).toBe('Other (half DOLLAR)');
  });

  it('exports the pieces it is built from, so nobody has to retype them', () => {
    expect(OTHER_DENOMINATION_PREFIX).toBe('Other (');
    expect(NO_DENOMINATION).toBe('—');
  });
});

 /*
 * EXACTLY ONE IMPLEMENTATION
  */

/**
 * A source file with its comments removed — `//`, `/* *``/` and `<!-- -->`.
 *
 * Only CODE can build a label. A file that merely talks about the rule is
 * doing the right thing, and flagging it would push the next author into
 * deleting the explanation rather than the duplicate.
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
    // If `stripComments` ever stopped matching, every file would look empty
    // of the string and the test below would pass by accident — cover that
    // is not cover. This module's own doc comment discusses `Other (8
    // Reales)` at length and must disappear; its CODE must not.
    const stripped = stripComments(readFileSync(THIS_MODULE, 'utf8'));
    expect(stripped).not.toContain('Other (8 Reales)');
    expect(stripped).toContain("OTHER_DENOMINATION_PREFIX = 'Other ('");
  });

  it('no other source file builds an "Other (...)" denomination label', () => {
    // A second implementation is not a duplicate, it is a FORK: the moment
    // the wording or the trimming changes in one of them the app shows the
    // same coin two ways. Import denominationDisplay instead.
    //
    // Comments are stripped first: files are free to EXPLAIN the rule — the
    // resolution module's header argues at length that `Other (Crown)` is
    // more honest than a guessed issuer — they are just not free to build it.
    const offenders = files.filter((file) => stripComments(readFileSync(file, 'utf8')).includes('Other ('));
    expect(offenders).toEqual([]);
  });
});

 /*
 * The "__OTHER__" sentinel, found in real data by migration 014
 *
 * A Peruvian coin came back from 014's unresolved report holding the literal
 * string `__OTHER__`. That is the editor's "Other" option value, written to
 * the database by a defect that custom-option-mode.ts documents and has since
 * fixed. The row is residue, not data.
 *
 * Rendering it as `Other (__OTHER__)` would be worse than useless: it names
 * nothing, cannot be searched for, and reads as a fault in the app rather
 * than an empty field in the collection.
  */
describe('denominationDisplay — the __OTHER__ sentinel', () => {
  it('treats the sentinel as no denomination at all', () => {
    expect(denominationDisplay(null, '__OTHER__')).toBe(NO_DENOMINATION);
  });

  it('ignores surrounding whitespace on it', () => {
    expect(denominationDisplay(null, '  __OTHER__  ')).toBe(NO_DENOMINATION);
  });

  it('still prefers a real label when the coin has one', () => {
    // The id is the authority. A coin whose text is residue but whose id
    // resolves is simply a resolved coin.
    expect(denominationDisplay('100 Soles', '__OTHER__')).toBe('100 Soles');
  });

  it('does not suppress ordinary text that merely contains the word', () => {
    // Only the exact token is residue. "Other" is a plausible thing for a
    // person to have typed, and suppressing it would hide real data.
    expect(denominationDisplay(null, 'Other')).toBe('Other (Other)');
    expect(denominationDisplay(null, '__OTHER__ Dollar')).toBe('Other (__OTHER__ Dollar)');
  });

  /**
   * The spelling is duplicated rather than imported — this module is
   * dependency-free by design and custom-option-mode.ts lives in a component
   * folder. This test is what stops the two copies drifting.
   */
  it('agrees with the editor on how the sentinel is spelled', () => {
    expect(denominationDisplay(null, CUSTOM_OPTION_SENTINEL)).toBe(NO_DENOMINATION);
  });
});
