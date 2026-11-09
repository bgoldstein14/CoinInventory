/**
 * The UTF-8 BOM, both halves of it.
 *
 * REPORTED SYMPTOM
 *
 * "The report generator produced a report with all coins that had ¢ in the
 * denomination with the denomination output with nonsense characters."
 *
 * The data was fine. The exported `.csv` carried no byte-order mark, so Excel
 * decoded it as windows-1252 and showed the two UTF-8 bytes of `¢` as `Â¢`.
 *
 * THE SECOND HALF, WHICH IS THE REASON THESE TESTS ARE WORTH HAVING
 *
 * Fixing only the export would have been a downgrade. An exported file is
 * advertised as a re-importable template, and the importer did not strip a
 * BOM, so the first header would have come back as `﻿Coin Type` and the
 * first column would have arrived unmapped -- with no error, on a screen
 * where every other column was mapped correctly.
 *
 * So the round-trip assertions below matter more than the "does it start with
 * a BOM" ones. They are also why `serviceCapturing()` in
 * export-import-round-trip.spec.ts had to be strengthened: it used to replace
 * `downloadBlob` wholesale, which meant the exported text it captured was the
 * text BEFORE the BOM was added, and no test there could have seen this bug.
 */
import { describe, expect, it } from 'vitest';
import { BOM, cleanHeaderText, stripBom } from './byte-order-mark';

describe('stripBom', () => {
  it('removes a leading byte-order mark', () => {
    expect(stripBom(`${BOM}Coin Type,Year`)).toBe('Coin Type,Year');
  });

  it('leaves text without one untouched', () => {
    expect(stripBom('Coin Type,Year')).toBe('Coin Type,Year');
    expect(stripBom('')).toBe('');
  });

  it('removes only the first one, never characters from inside the data', () => {
    // A U+FEFF in the middle of a file is a zero-width no-break space in
    // somebody's cell. Deleting characters out of their data is not this
    // function's job.
    expect(stripBom(`${BOM}a${BOM}b`)).toBe(`a${BOM}b`);
  });
});

describe('cleanHeaderText', () => {
  it('strips the invisible characters that break an exact header match', () => {
    expect(cleanHeaderText(`${BOM}Coin Type`)).toBe('Coin Type');
    expect(cleanHeaderText('Coin​Type')).toBe('CoinType');
    expect(cleanHeaderText('  Purchase Price  ')).toBe('Purchase Price');
  });

  it('turns a non-breaking space into a real one rather than deleting it', () => {
    // U+00A0 separates words; removing it would weld `Cert` and `No`
    // together into a header that matches nothing at all.
    expect(cleanHeaderText('Cert No')).toBe('Cert No');
  });

  it('survives a null or undefined cell', () => {
    expect(cleanHeaderText(null as unknown as string)).toBe('');
    expect(cleanHeaderText(undefined as unknown as string)).toBe('');
  });
});
