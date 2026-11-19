/* The CAC checkbox only applies to a graded coin. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gradeEdit, hasGrade } from '../../types/cac-sticker';

const TEMPLATE = readFileSync(join(__dirname, 'coin-editor-form.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

describe('hasGrade', () => {
  it('is false for a blank grade', () => {
    for (const blank of ['', '   ', null, undefined]) expect(hasGrade(blank)).toBe(false);
  });
  it('is true for any grade text', () => {
    expect(hasGrade('MS64')).toBe(true);
  });
});

describe('gradeEdit', () => {
  it('just saves the grade normally', () => {
    expect(gradeEdit('MS65', true)).toEqual({ grade: 'MS65' });
    expect(gradeEdit('', false)).toEqual({ grade: '' });
  });
  it('clears CAC when the grade is cleared', () => {
    expect(gradeEdit(' ', true)).toEqual({ grade: ' ', hasCacSticker: false });
  });
});

describe('the template', () => {
  it('disables the CAC checkbox without a grade', () => {
    expect(TEMPLATE).toMatch(/type="checkbox"[^>]*\[disabled\]="!hasGrade\(coin\(\)\.grade\)"[^>]*\(change\)="toggleCacSticker\(\)"/);
  });
  it('saves grade edits through onGradeChanged', () => {
    expect(TEMPLATE).toContain('(ngModelChange)="onGradeChanged($event)"');
  });
});
