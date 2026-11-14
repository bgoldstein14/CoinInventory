/**
 * db/bind-values.spec.ts — the parameter boundary, which is now the ONLY
 * place a column's declared width means anything.
 *
 * Under SQL Server there were two gates. `mssql` trimmed a string to the
 * declared parameter length before sending it, and the column itself refused
 * anything longer. SQLite has neither: it stores a four-thousand-character
 * string in a column this project calls NVarChar(50), silently, and the
 * problem surfaces months later as a wrecked grid or a truncated export from
 * a tool that does care.
 *
 * So db/bind-values.ts is the gate, and this file is what proves it is shut.
 * The decimal half of the same job has its own file, db/numeric-storage.spec.ts,
 * because the argument behind it is longer and more consequential.
 *
 * The error NUMBERS matter as much as the refusals. routes/db-error-response.ts
 * classifies on a SQL Server error number and was deliberately not rewritten
 * for this migration, so 8152 has to keep meaning "too long" and 8114 has to
 * keep meaning "not convertible", or a perfectly good 400 becomes a 500.
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
    // Doing it twice costs nothing, and means a path that forgot cannot
    // reach the driver — where the error would read "Provided value cannot
    // be bound to SQLite parameter 7" and name nothing the user typed.
    expect(toBindValue('notes', NVarChar(MAX), undefined)).toBeNull();
  });
});

describe('text width', () => {
  it('accepts a value at exactly the declared width', () => {
    expect(toBindValue('grade', NVarChar(50), 'G'.repeat(50))).toBe('G'.repeat(50));
  });

  it('REFUSES one character more, rather than trimming it', () => {
    // The deliberate behaviour change. `mssql` cut the 51st character off
    // and told nobody, so a grade the user typed came back shorter with
    // nothing to explain it. A refused value can be retyped; a truncated
    // one cannot be recovered.
    try {
      toBindValue('grade', NVarChar(50), 'G'.repeat(51));
      throw new Error('expected a DbValueError');
    } catch (err) {
      expect(err).toBeInstanceOf(DbValueError);
      expect((err as DbValueError).number).toBe(ERR_VALUE_TOO_LONG);
      // The message has to name the field, because it reaches a log line
      // and a support report where "parameter 7" would be useless.
      expect((err as DbValueError).message).toContain('grade');
      expect((err as DbValueError).message).toContain('NVARCHAR(50)');
    }
  });

  it('places no limit on NVARCHAR(MAX)', () => {
    const long = 'n'.repeat(200_000);
    expect(toBindValue('notes', NVarChar(MAX), long)).toBe(long);
  });

  it('counts characters, not bytes', () => {
    // Labels in this schema contain '½', '¢' and '£', and issuer names
    // contain accents. A byte-length check would reject a 100-character
    // label whose UTF-8 form is 150 bytes — a column the old NVARCHAR
    // (two bytes per character) accepted without complaint.
    expect(toBindValue('label', NVarChar(3), '½¢£')).toBe('½¢£');
  });
});

describe('CHAR(2) — the only fixed-width column in the schema', () => {
  it('stores exactly what it was given, with no padding', () => {
    // SQL Server PADDED 'M' to 'M ', and the padded value then compared
    // unequal to 'M' everywhere, so the issuer quietly stopped matching
    // anything. SQLite's TEXT does not pad, so that failure mode is gone.
    expect(toBindValue('isoCode', Char(2), 'MX')).toBe('MX');
    expect(toBindValue('isoCode', Char(2), 'M')).toBe('M');
  });

  it('still refuses a third character', () => {
    // SQL Server silently truncated 'MMR' to 'MM'. The route refuses
    // anything that is not exactly two letters before it gets here; this is
    // the second line of that defence.
    expect(() => toBindValue('isoCode', Char(2), 'MMR')).toThrow(DbValueError);
  });
});

describe('integers', () => {
  it('accepts a whole number', () => {
    expect(toBindValue('catalogId', Int, 3)).toBe(3);
    expect(toBindValue('validFrom', Int, -509)).toBe(-509);
  });

  it('accepts a numeric string, because a CSV round trip produces one', () => {
    // A coin exported to CSV and imported again carries the STRING "3"
    // rather than the number 3 — the importer copies a mapped cell
    // verbatim. See the notes on catalogId in db/coin-fields.ts.
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
    // SQLite WOULD store 'Sear' in an INTEGER column. It would then fail
    // every `=` and every JOIN against a real id while looking perfectly
    // normal in a SELECT. This is a user-reachable input: the import screen
    // lets a column of catalogue NAMES be mapped onto the id field.
    expect(() => toBindValue('catalogId', Int, 'Sear')).toThrow(DbValueError);
    expect(() => toBindValue('catalogId', Int, '3 sheep')).toThrow(DbValueError);
    expect(() => toBindValue('catalogId', Int, '')).toThrow(DbValueError);
  });
});

describe('BIT', () => {
  it('reduces anything truthy to 1 and anything falsy to 0', () => {
    // The BIT columns in this schema are all NOT NULL DEFAULT 0, so there
    // is no third state to preserve.
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
    // PurchaseDate / SoldDate are TEXT, not dates. A raw
    // Date throws at the driver; a locale-formatted one would not round-trip
    // back through rowToCoin().
    expect(toBindValue('purchaseDate', NVarChar(30), new Date('2024-01-15T10:30:00Z'))).toBe(
      '2024-01-15'
    );
  });

  it('turns a boolean or a number destined for a text column into its text', () => {
    expect(toBindValue('year', NVarChar(50), 1921)).toBe('1921');
    expect(toBindValue('source', NVarChar(50), true)).toBe('true');
  });

  it('refuses an object, rather than storing "[object Object]"', () => {
    // The worst possible outcome of a caller bug: a row that looks populated
    // and holds nothing.
    expect(() => toBindValue('notes', NVarChar(MAX), { a: 1 })).toThrow(DbValueError);
    expect(() => toBindValue('notes', NVarChar(MAX), ['a'])).toThrow(DbValueError);
  });
});
