/*
 * Year, Coin Type and the custom mint mark hold text like "155-135 BC" that
 * wraps onto a second line, so they are two-line textareas that still behave
 * like one-line fields (Enter doesn't add a line break). Text scan, since the
 * suite has no DOM.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { singleLine } from './wrapping-field';

const TEMPLATE = readFileSync(join(__dirname, 'coin-editor-form.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const FIELD_STYLES = readFileSync(join(__dirname, '..', '..', 'styles', '_field.scss'), 'utf8');

/** The textarea inside the label carrying `className`. */
function fieldControl(className: string): string {
  const start = TEMPLATE.indexOf(className);
  expect(start, className).toBeGreaterThan(-1);
  return TEMPLATE.slice(start, TEMPLATE.indexOf('</label>', start));
}

describe('wrapping single-value fields', () => {
  for (const field of ['detail-field--year', 'detail-field--coin-type', 'detail-field--custom-mint-mark']) {
    it(`${field} is a two-line textarea that Enter does not break`, () => {
      const control = fieldControl(field);
      expect(control).toContain('<textarea');
      expect(control).toContain('rows="2"');
      expect(control).toContain('(keydown.enter)="$event.preventDefault()"');
      expect(control).toContain('singleLine($event)');
    });
  }

  it('styles textareas like the other inputs, without a resize handle', () => {
    expect(FIELD_STYLES).toMatch(/input, select, textarea \{/);
    expect(FIELD_STYLES).toMatch(/textarea \{[^}]*resize:\s*none/);
  });
});

describe('singleLine', () => {
  it('turns pasted line breaks into single spaces', () => {
    expect(singleLine('155-135\nBC')).toBe('155-135 BC');
    expect(singleLine('a \r\n  b')).toBe('a b');
  });

  it('leaves ordinary text alone', () => {
    expect(singleLine('Tiberius  Tribute Penny ')).toBe('Tiberius  Tribute Penny ');
  });
});
