/**
 * The UTF-8 BOM: exports prepend it so Excel decodes `¢` correctly (without it
 * Excel shows `Â¢`), and imports strip it so a re-imported export's first header
 * still maps. The round-trip tests matter most.
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
    // A U+FEFF mid-file is data (zero-width no-break space), not a BOM.
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
    // U+00A0 separates words; removing it would weld `Cert` and `No` together.
    expect(cleanHeaderText('Cert No')).toBe('Cert No');
  });

  it('survives a null or undefined cell', () => {
    expect(cleanHeaderText(null as unknown as string)).toBe('');
    expect(cleanHeaderText(undefined as unknown as string)).toBe('');
  });
});
