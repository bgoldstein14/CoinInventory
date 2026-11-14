/**
 * The read-only guard and the SQL builder.
 *
 * These are the only two things standing between a string in this tool and
 * the owner's single copy of his collection, so they are tested as the
 * safety devices they are rather than as helpers: every refusal is asserted
 * individually, and the detector is checked against the forms it must NOT
 * refuse as well as the ones it must.
 */

import { describe, it, expect } from 'vitest';

import {
  assertReadOnlySql,
  buildSelect,
  column,
  guidAsLowerText,
  idSelectItem,
  quoteIdentifier,
  ReadOnlyViolationError,
} from './source-reader';

describe('quoteIdentifier', () => {
  it('brackets a plain identifier', () => {
    expect(quoteIdentifier('Coins')).toBe('[Coins]');
    expect(quoteIdentifier('PmWeightGrams')).toBe('[PmWeightGrams]');
    expect(quoteIdentifier('_private1')).toBe('[_private1]');
  });

  it('refuses anything that is not one', () => {
    // Every name this tool uses is one of its own constants or a column
    // read back from INFORMATION_SCHEMA, so these are bugs, not quoting
    // problems, and a bracket would hide them.
    for (const bad of ['Coins; DROP TABLE Coins', 'Coins]', 'dbo.Coins', '', '1Coins', 'a b']) {
      expect(() => quoteIdentifier(bad)).toThrow(/Refusing to build SQL/);
    }
  });
});

describe('buildSelect', () => {
  it('builds the one shape of statement the tool may send', () => {
    expect(
      buildSelect({ table: 'Coins', select: [column('CoinId'), column('Weight')] })
    ).toBe('SELECT [CoinId] AS [CoinId], [Weight] AS [Weight] FROM [Coins]');
  });

  it('adds an ORDER BY when one is asked for', () => {
    expect(
      buildSelect({
        table: 'CoinImages',
        select: [column('ImageId')],
        orderBy: ['CoinId', 'SortOrder'],
      })
    ).toBe('SELECT [ImageId] AS [ImageId] FROM [CoinImages] ORDER BY [CoinId], [SortOrder]');
  });

  it('refuses to build a SELECT with no columns', () => {
    expect(() => buildSelect({ table: 'Coins', select: [] })).toThrow(/no columns/);
  });

  it('reads a UNIQUEIDENTIFIER as lower-cased text, and leaves text alone', () => {
    // Not cosmetic: SQLite's CoinId column is BINARY-collated, so a coin
    // stored as 'A1B2…' is not found by a request for 'a1b2…'.
    expect(guidAsLowerText('CoinId').expression).toBe(
      'LOWER(CONVERT(NVARCHAR(36), [CoinId]))'
    );

    const guid = idSelectItem({
      name: 'CoinId',
      dataType: 'uniqueidentifier',
      maxLength: null,
      precision: null,
      scale: null,
    });
    expect(guid.expression).toContain('LOWER(CONVERT');

    const text = idSelectItem({
      name: 'CoinId',
      dataType: 'nvarchar',
      maxLength: 36,
      precision: null,
      scale: null,
    });
    expect(text.expression).toBe('[CoinId]');
  });
});

describe('assertReadOnlySql', () => {
  it('accepts the statements the tool actually builds', () => {
    expect(() =>
      assertReadOnlySql('SELECT [CoinId] AS [CoinId] FROM [Coins] ORDER BY [CoinId]')
    ).not.toThrow();
    expect(() => assertReadOnlySql('SELECT COUNT(*) AS [n] FROM [CoinImages]')).not.toThrow();
    expect(() =>
      assertReadOnlySql(
        'SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, ' +
          'NUMERIC_SCALE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = SCHEMA_NAME() ' +
          'AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION'
      )
    ).not.toThrow();
    expect(() =>
      assertReadOnlySql(
        "SELECT TABLE_NAME AS [name] FROM INFORMATION_SCHEMA.TABLES " +
          "WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = SCHEMA_NAME()"
      )
    ).not.toThrow();
    expect(() =>
      assertReadOnlySql(
        'SELECT LOWER(CONVERT(NVARCHAR(36), [CoinId])) AS [CoinId] FROM [Coins]'
      )
    ).not.toThrow();
  });

  it('refuses anything that does not begin with SELECT', () => {
    expect(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x')).toThrow(
      ReadOnlyViolationError
    );
    expect(() => assertReadOnlySql('')).toThrow(ReadOnlyViolationError);
  });

  it('refuses a statement that could be two statements', () => {
    expect(() => assertReadOnlySql('SELECT 1; DELETE FROM Coins')).toThrow(/semicolon/);
    expect(() => assertReadOnlySql('SELECT 1 -- and then')).toThrow(/comment/);
    expect(() => assertReadOnlySql('SELECT /* hidden */ 1')).toThrow(/comment/);
  });

  it('refuses every writing keyword, by name', () => {
    const cases: Array<[string, string]> = [
      ['SELECT * FROM Coins INSERT INTO x VALUES (1)', 'INSERT'],
      ['SELECT * FROM Coins UPDATE y', 'UPDATE'],
      ['SELECT * FROM Coins DELETE z', 'DELETE'],
      ['SELECT * FROM Coins MERGE q', 'MERGE'],
      ['SELECT * FROM Coins DROP TABLE q', 'DROP'],
      ['SELECT * FROM Coins CREATE TABLE q', 'CREATE'],
      ['SELECT * FROM Coins ALTER TABLE q', 'ALTER'],
      ['SELECT * FROM Coins TRUNCATE TABLE q', 'TRUNCATE'],
      ['SELECT * FROM Coins EXEC sp_who', 'EXEC'],
      ['SELECT * INTO #t FROM Coins', 'INTO'],
      ['SELECT * FROM Coins OUTPUT INSERTED.CoinId', 'OUTPUT'],
      ['SELECT * FROM Coins WAITFOR DELAY', 'WAITFOR'],
      ['SELECT * FROM Coins SET x = 1', 'SET'],
      ['SELECT * FROM Coins USE master', 'USE'],
      ['SELECT * FROM Coins BACKUP DATABASE q', 'BACKUP'],
    ];

    for (const [sql, keyword] of cases) {
      expect(() => assertReadOnlySql(sql), sql).toThrow(new RegExp(`keyword ${keyword}`));
    }
  });

  it('does not trip on a column whose name merely contains a keyword', () => {
    // `OFFSET` ends in SET, `CHARACTER_MAXIMUM_LENGTH` and `ORDINAL_POSITION`
    // are full of substrings. A guard that fired on those would be turned off
    // by the next person who needed one of them, which is how a safety device
    // dies.
    expect(() => assertReadOnlySql('SELECT [Offset] AS [Offset] FROM [Coins]')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT [Created] AS [Created] FROM [Coins]')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT [Dealer] AS [Dealer] FROM [Coins]')).not.toThrow();
  });

  it('names the statement it refused, so the operator can see which one', () => {
    try {
      assertReadOnlySql('UPDATE Coins SET Weight = 0');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReadOnlyViolationError);
      expect((err as Error).message).toContain('UPDATE Coins SET Weight = 0');
      expect((err as Error).message).toContain('read-only');
    }
  });
});
