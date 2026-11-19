/**
 * The parameter boundary (db/bind-values.ts). SQLite enforces no widths, so
 * this is where over-long values are refused. Error numbers matter too:
 * routes/db-error-response.ts maps 8152 (too long) and 8114 (not convertible)
 * to 400. Decimals are covered in db/numeric-storage.spec.ts.
 */

import { describe, it, expect } from 'vitest';

import {
  toBindValue,
  DbValueError,
  ERR_VALUE_TOO_LONG,
  ERR_VALUE_NOT_CONVERTIBLE,
} from './bind-values';
import { NVarChar, Char, Int, Bit, MAX } from './column-types';

describe('null and undefined', () => {
  it('both mean SQL NULL', () => {
    expect(toBindValue('x', NVarChar(10), null)).toBeNull();
    expect(toBindValue('x', NVarChar(10), undefined)).toBeNull();
    expect(toBindValue('x', Int, undefined)).toBeNull();
  });

  it('are converted here even though most routes already normalised them', () => {
    // Otherwise the driver's error would name only a parameter position.
    expect(toBindValue('notes', NVarChar(MAX), undefined)).toBeNull();
  });
});

describe('text width', () => {
  it('accepts a value at exactly the declared width', () => {
    expect(toBindValue('grade', NVarChar(50), 'G'.repeat(50))).toBe('G'.repeat(50));
  });

  it('REFUSES one character more, rather than trimming it', () => {
    // Refused rather than truncated, so the user can retype it.
    try {
      toBindValue('grade', NVarChar(50), 'G'.repeat(51));
      throw new Error('expected a DbValueError');
    } catch (err) {
      expect(err).toBeInstanceOf(DbValueError);
      expect((err as DbValueError).number).toBe(ERR_VALUE_TOO_LONG);
      // The message names the field, for logs and support reports.
      expect((err as DbValueError).message).toContain('grade');
      expect((err as DbValueError).message).toContain('NVARCHAR(50)');
    }
  });

  it('places no limit on NVARCHAR(MAX)', () => {
    const long = 'n'.repeat(200_000);
    expect(toBindValue('notes', NVarChar(MAX), long)).toBe(long);
  });

  it('counts characters, not bytes', () => {
    // Length is in characters, not bytes ('½', '¢', '£' and accents are common).
    expect(toBindValue('label', NVarChar(3), '½¢£')).toBe('½¢£');
  });
});

describe('CHAR(2) — the only fixed-width column in the schema', () => {
  it('stores exactly what it was given, with no padding', () => {
    // No padding (SQL Server's CHAR padded 'M' to 'M ').
    expect(toBindValue('isoCode', Char(2), 'MX')).toBe('MX');
    expect(toBindValue('isoCode', Char(2), 'M')).toBe('M');
  });

  it('still refuses a third character', () => {
    // Not truncated to 'MM'. The route also validates exactly two letters.
    expect(() => toBindValue('isoCode', Char(2), 'MMR')).toThrow(DbValueError);
  });
});

describe('integers', () => {
  it('accepts a whole number', () => {
    expect(toBindValue('catalogId', Int, 3)).toBe(3);
    expect(toBindValue('validFrom', Int, -509)).toBe(-509);
  });

  it('accepts a numeric string, because a CSV round trip produces one', () => {
    // A CSV round trip delivers "3" rather than 3.
    expect(toBindValue('catalogId', Int, '3')).toBe(3);
    expect(toBindValue('catalogId', Int, ' 3 ')).toBe(3);
  });

  it('refuses a fraction, with the number that produces a 400', () => {
    try {
      toBindValue('catalogId', Int, 3.5);
      throw new Error('expected a DbValueError');
    } catch (err) {
      expect((err as DbValueError).number).toBe(ERR_VALUE_NOT_CONVERTIBLE);
    }
  });

  it('refuses a word, rather than storing it as text in an INTEGER column', () => {
    // SQLite would store 'Sear' in an INTEGER column; the import screen can send it.
    expect(() => toBindValue('catalogId', Int, 'Sear')).toThrow(DbValueError);
    expect(() => toBindValue('catalogId', Int, '3 sheep')).toThrow(DbValueError);
    expect(() => toBindValue('catalogId', Int, '')).toThrow(DbValueError);
  });
});

describe('BIT', () => {
  it('reduces anything truthy to 1 and anything falsy to 0', () => {
    // All BIT columns are NOT NULL DEFAULT 0.
    expect(toBindValue('hasCacSticker', Bit, true)).toBe(1);
    expect(toBindValue('hasCacSticker', Bit, 1)).toBe(1);
    expect(toBindValue('hasCacSticker', Bit, 'yes')).toBe(1);
    expect(toBindValue('hasCacSticker', Bit, false)).toBe(0);
    expect(toBindValue('hasCacSticker', Bit, 0)).toBe(0);
    expect(toBindValue('hasCacSticker', Bit, '')).toBe(0);
  });
});

describe('types the driver cannot bind at all', () => {
  it('turns a Date into YYYY-MM-DD for the text date columns', () => {
    // Date columns are TEXT; a Date is stored as 'YYYY-MM-DD'.
    expect(toBindValue('purchaseDate', NVarChar(30), new Date('2024-01-15T10:30:00Z'))).toBe(
      '2024-01-15'
    );
  });

  it('turns a boolean or a number destined for a text column into its text', () => {
    expect(toBindValue('year', NVarChar(50), 1921)).toBe('1921');
    expect(toBindValue('source', NVarChar(50), true)).toBe('true');
  });

  it('refuses an object, rather than storing "[object Object]"', () => {
    // Don't store "[object Object]".
    expect(() => toBindValue('notes', NVarChar(MAX), { a: 1 })).toThrow(DbValueError);
    expect(() => toBindValue('notes', NVarChar(MAX), ['a'])).toThrow(DbValueError);
  });
});
