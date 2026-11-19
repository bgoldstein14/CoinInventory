/**
 * The request-style adapter (db/sql-api.ts). Most of it is exercised through
 * the routes; this covers what it adds over mssql:
 *
 *   1. multi-statement queries are refused (prepare() would silently run only
 *      the first statement);
 *   2. unbound parameters are refused (SQLite would bind NULL);
 *   3. SQLite errors carry SQL Server error numbers;
 *   4. access to the single handle is serialised.
 */

import { describe, it, expect } from 'vitest';

import { withTestDb, queryRows } from '../test-support/sqlite-test-db';
import { getPool } from './pool';
import { DB_BINDINGS } from './bindings';
import { NVarChar, Int } from './column-types';
import {
  DbQueryError,
  DbRequest,
  DbTransaction,
  countStatements,
  parameterNamesIn,
  stripLiteralsAndComments,
  translateSqliteError,
  ERR_DUPLICATE_KEY,
  ERR_CONSTRAINT_VIOLATION,
  ERR_NULL_NOT_ALLOWED,
} from './sql-api';

describe('statement inspection', () => {
  it('does not see a semicolon inside a string literal', () => {
    expect(countStatements("SELECT * FROM Coins WHERE Notes = 'a; b'")).toBe(1);
    expect(countStatements("UPDATE Coins SET Notes = 'x;y;z' WHERE CoinId = @id")).toBe(1);
  });

  it('does not see a semicolon inside a comment', () => {
    expect(countStatements('SELECT 1 -- and then; something\n')).toBe(1);
    expect(countStatements('SELECT 1 /* a; b */')).toBe(1);
  });

  it('ignores a trailing semicolon and trailing whitespace', () => {
    expect(countStatements('SELECT 1;')).toBe(1);
    expect(countStatements('SELECT 1;\n\n  ')).toBe(1);
  });

  it('counts genuinely separate statements', () => {
    expect(countStatements('UPDATE a SET x = 1; UPDATE b SET y = 2;')).toBe(2);
  });

  it('does not read an @ inside a literal or a comment as a parameter', () => {
    expect(parameterNamesIn("SELECT * FROM Coins WHERE Notes = '@notAParam'")).toEqual([]);
    expect(parameterNamesIn('SELECT 1 -- bind @id here')).toEqual([]);
    expect(parameterNamesIn('SELECT * FROM Coins WHERE CoinId = @id AND Year = @year')).toEqual([
      'id',
      'year',
    ]);
  });

  it('handles an escaped quote inside a literal', () => {
    expect(stripLiteralsAndComments("SELECT 'it''s; fine'").trim()).toBe('SELECT');
  });
});

describe('a multi-statement query is refused', () => {
  it('throws rather than running only the first statement', async () => {
    const connection = await getPool();

    await expect(
      connection
        .request()
        .query("INSERT INTO Categories (CategoryName) VALUES ('one'); INSERT INTO Categories (CategoryName) VALUES ('two');")
    ).rejects.toThrow(/2 statements/);

    // Neither statement ran.
    expect(await queryRows("SELECT CategoryName FROM Categories WHERE CategoryName IN ('one','two')"))
      .toEqual([]);
  });

  it('names the alternative, because the caller has to do something', async () => {
    const connection = await getPool();
    await expect(connection.request().query('SELECT 1; SELECT 2;')).rejects.toThrow(/DbTransaction/);
  });

  it('refuses an empty statement', async () => {
    const connection = await getPool();
    await expect(connection.request().query('   ')).rejects.toThrow(/empty statement/);
  });
});

describe('an unbound parameter is refused', () => {
  it('throws instead of letting SQLite bind NULL and return the wrong rows', async () => {
    const connection = await getPool();

    await expect(
      connection
        .request()
        .input('id', DB_BINDINGS.coinId, 'abc')
    // Note the case: only @id was bound.
        .query('SELECT * FROM Coins WHERE CoinId = @coinId')
    ).rejects.toThrow(/@coinId/);
  });

  it('allows an .input() the statement does not mention', async () => {
    // writes.ts binds every COIN_FIELDS entry and names only some; extras must be ignored.
    const connection = await getPool();

    const result = await connection
      .request()
      .input('id', DB_BINDINGS.coinId, 'abc')
      .input('unused', NVarChar(10), 'ignored')
      .query('SELECT @id AS bound');

    expect(result.recordset).toEqual([{ bound: 'abc' }]);
  });

  it('does not validate an unused binding, matching an unreferenced SQL Server parameter', async () => {
    // An unused binding isn't validated: nothing was going to be stored.
    const connection = await getPool();
    await expect(
      connection
        .request()
        .input('id', DB_BINDINGS.coinId, 'abc')
        .input('tooLong', NVarChar(3), 'far too long')
        .query('SELECT @id AS bound')
    ).resolves.toMatchObject({ recordset: [{ bound: 'abc' }] });
  });
});

describe('SQLite errors carry the SQL Server error numbers the HTTP layer classifies', () => {
  it('maps a UNIQUE / PRIMARY KEY violation to 2627', () => {
    expect(translateSqliteError({ errcode: 2067, message: 'UNIQUE constraint failed' }).number).toBe(
      ERR_DUPLICATE_KEY
    );
    expect(translateSqliteError({ errcode: 1555, message: 'PRIMARY KEY' }).number).toBe(
      ERR_DUPLICATE_KEY
    );
  });

  it('maps a FOREIGN KEY or CHECK violation to 547', () => {
    expect(translateSqliteError({ errcode: 787, message: 'FOREIGN KEY' }).number).toBe(
      ERR_CONSTRAINT_VIOLATION
    );
    expect(translateSqliteError({ errcode: 275, message: 'CHECK' }).number).toBe(
      ERR_CONSTRAINT_VIOLATION
    );
  });

  it('maps a NOT NULL violation to 515', () => {
    expect(translateSqliteError({ errcode: 1299, message: 'NOT NULL' }).number).toBe(
      ERR_NULL_NOT_ALLOWED
    );
  });

  it('gives a non-constraint error NO number, so it reaches the generic 500', () => {
    // Unknown errors get no number, so they stay a 500.
    expect(translateSqliteError({ errcode: 1, message: 'no such table: Nope' }).number).toBeUndefined();
  });

  it('carries the driver code through under the name db/errors.ts reads', () => {
    // isConnectionError() reads `code`; renaming it would break that branch.
    const translated = translateSqliteError({ errcode: 2067, code: 'ERR_SQLITE_ERROR', message: 'x' });
    expect(translated.code).toBe('ERR_SQLITE_ERROR');
    expect(translated.errcode).toBe(2067);
  });

  it('produces a real 2627 from a real duplicate', async () => {
    const connection = await getPool();
    await connection.request().query("INSERT INTO Categories (CategoryName) VALUES ('Dup')");

    await expect(
      connection.request().query("INSERT INTO Categories (CategoryName) VALUES ('Dup')")
    ).rejects.toMatchObject({ number: ERR_DUPLICATE_KEY });
  });
});

describe('rowsAffected', () => {
  it('reports the number of rows changed by an UPDATE', async () => {
    const connection = await getPool();
    await connection
      .request()
      .input('id', DB_BINDINGS.coinId, 'rows-1')
      .query("INSERT INTO Coins (CoinId, Denomination) VALUES (@id, 'x')");

    const updated = await connection
      .request()
      .input('id', DB_BINDINGS.coinId, 'rows-1')
      .query("UPDATE Coins SET CoinType = 'y' WHERE CoinId = @id");
    expect(updated.rowsAffected).toEqual([1]);

    const missed = await connection
      .request()
      .input('id', DB_BINDINGS.coinId, 'nobody')
      .query("UPDATE Coins SET CoinType = 'y' WHERE CoinId = @id");
    expect(missed.rowsAffected).toEqual([0]);
  });

  it('reports the row count for a statement that returns rows', async () => {
    const connection = await getPool();
    const result = await connection.request().query('SELECT CatalogId FROM Catalogs');
    expect(result.rowsAffected).toEqual([result.recordset.length]);
  });

  it('hands back plain objects, not null-prototype ones', async () => {
    // node:sqlite returns null-prototype rows; they are copied to plain objects.
    const connection = await getPool();
    const result = await connection.request().query('SELECT 1 AS one');
    expect(Object.getPrototypeOf(result.recordset[0])).toBe(Object.prototype);
  });
});

describe('transactions serialise access to the one handle', () => {
  it('runs two concurrent transactions one after the other, not interleaved', async () => {
    // Without the lock, the second BEGIN would fail or the first COMMIT
    // would commit the other transaction's work.
    const connection = await getPool();

    const write = async (id: string) => {
      const transaction = new DbTransaction(connection);
      await transaction.begin();
      await new DbRequest(transaction)
        .input('id', DB_BINDINGS.coinId, id)
        .query("INSERT INTO Coins (CoinId, Denomination) VALUES (@id, 'x')");
      await new DbRequest(transaction)
        .input('id', DB_BINDINGS.coinId, id)
        .query("UPDATE Coins SET CoinType = 'done' WHERE CoinId = @id");
      await transaction.commit();
    };

    await Promise.all([write('tx-a'), write('tx-b'), write('tx-c')]);

    const rows = await queryRows('SELECT CoinId, CoinType FROM Coins ORDER BY CoinId');
    expect(rows).toEqual([
      { CoinId: 'tx-a', CoinType: 'done' },
      { CoinId: 'tx-b', CoinType: 'done' },
      { CoinId: 'tx-c', CoinType: 'done' },
    ]);
  });

  it('holds back an ordinary request until an open transaction finishes', async () => {
    const connection = await getPool();
    const order: string[] = [];

    const transaction = new DbTransaction(connection);
    await transaction.begin();

    const queued = connection
      .request()
      .query('SELECT COUNT(*) AS c FROM Coins')
      .then((result) => {
        order.push('outside');
        return result;
      });

    await new DbRequest(transaction)
      .input('id', DB_BINDINGS.coinId, 'locked')
      .query("INSERT INTO Coins (CoinId, Denomination) VALUES (@id, 'x')");
    order.push('inside');

    await transaction.commit();
    const result = await queued;

    expect(order).toEqual(['inside', 'outside']);
    // The waiting read sees the committed row, not a half-written one.
    expect(result.recordset[0]['c']).toBe(1);
  });

  it('rolls back, releases the lock, and lets the next caller through', async () => {
    const connection = await getPool();

    const transaction = new DbTransaction(connection);
    await transaction.begin();
    await new DbRequest(transaction)
      .input('id', DB_BINDINGS.coinId, 'gone')
      .query("INSERT INTO Coins (CoinId, Denomination) VALUES (@id, 'x')");
    await transaction.rollback();

    expect(await queryRows('SELECT CoinId FROM Coins')).toEqual([]);
    // Not deadlocked.
    await expect(connection.request().query('SELECT 1 AS ok')).resolves.toMatchObject({
      recordset: [{ ok: 1 }],
    });
  });

  it('refuses a second commit, which is what safeRollback() exists to absorb', async () => {
    const connection = await getPool();
    const transaction = new DbTransaction(connection);
    await transaction.begin();
    await transaction.commit();

    await expect(transaction.rollback()).rejects.toThrow(/No transaction is active/);
  });

  it('refuses a request bound to a transaction that has not begun', async () => {
    const connection = await getPool();
    const transaction = new DbTransaction(connection);

    await expect(
      new DbRequest(transaction).input('id', Int, 1).query('SELECT @id AS x')
    ).rejects.toThrow(DbQueryError);
  });
});

describe('a closed connection', () => {
  it('reports itself as a connection failure, by code', async () => {
    // withDb() retries only this, so it must be classified by code.
    const connection = await getPool();
    connection.close();

    try {
      await connection.request().query('SELECT 1');
      throw new Error('expected the closed connection to refuse the query');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ERR_INVALID_STATE');
    } finally {
    // Leave a working database for the next test.
      await withTestDb(() => undefined).catch(() => undefined);
    }
  });
});
