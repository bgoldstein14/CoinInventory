/**
 * db/sql-api.spec.ts — the request-shaped adapter, and the two traps it
 * exists to close.
 *
 * db/sql-api.ts keeps the `.input(name, type, value).query(sql)` API the
 * twenty route modules already speak, so that moving off SQL Server changed
 * a route only where the dialect genuinely differs. Most of what it does is
 * therefore tested through those routes.
 *
 * What is tested HERE is the handful of things it does that `mssql` did not,
 * each of which closes a SILENT failure specific to this engine:
 *
 *   1. A MULTI-STATEMENT QUERY IS REFUSED. `node:sqlite`'s prepare()
 *      compiles the FIRST statement of a string and discards the rest
 *      without a word. The denominations DELETE used to be a four-statement
 *      T-SQL batch; translated naively it would have unlinked a
 *      denomination's coins, never deactivated the denomination, and
 *      returned 200.
 *   2. AN UNBOUND PARAMETER IS REFUSED. SQLite binds a named parameter
 *      nobody supplied to NULL and runs happily, so `WHERE CoinId = @coinid`
 *      is "no rows" rather than an error. `mssql` threw.
 *   3. SQLITE ERRORS CARRY SQL SERVER ERROR NUMBERS, so
 *      routes/db-error-response.ts — which is good, and well tested — did
 *      not have to be rewritten into this migration.
 *   4. ACCESS IS SERIALISED. `mssql` gave each transaction its own pooled
 *      connection; there is one SQLite handle and SQLite has no nested
 *      transactions, so two concurrent writes would interleave BEGIN/COMMIT
 *      and one request would commit the other's half-finished work.
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

    // And neither of them ran. Without the guard the first would have.
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
        // Note the case: @coinId was never bound, only @id.
        .query('SELECT * FROM Coins WHERE CoinId = @coinId')
    ).rejects.toThrow(/@coinId/);
  });

  it('allows an .input() the statement does not mention', async () => {
    // routes/coins/writes.ts binds every COIN_FIELDS entry and then names
    // only the columns the request body supplied. `mssql` ignored the
    // extras; so must this, or every partial update would fail.
    const connection = await getPool();

    const result = await connection
      .request()
      .input('id', DB_BINDINGS.coinId, 'abc')
      .input('unused', NVarChar(10), 'ignored')
      .query('SELECT @id AS bound');

    expect(result.recordset).toEqual([{ bound: 'abc' }]);
  });

  it('does not validate an unused binding, matching an unreferenced SQL Server parameter', async () => {
    // An over-long value bound to a parameter the statement never names is
    // not an error — nothing was going to be stored.
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
    // Exactly as an unrecognised `mssql` error did. Inventing a number here
    // would turn a server fault into a 409 the user is invited to fix.
    expect(translateSqliteError({ errcode: 1, message: 'no such table: Nope' }).number).toBeUndefined();
  });

  it('carries the driver code through under the name db/errors.ts reads', () => {
    // If this property is ever renamed, isConnectionError()'s code branch
    // goes dead and a closed database is recognised only by the wording of
    // its message. See the comment on DbQueryError.
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
    // Every 404 in this backend is `rowsAffected[0] === 0`.
    expect(missed.rowsAffected).toEqual([0]);
  });

  it('reports the row count for a statement that returns rows', async () => {
    const connection = await getPool();
    const result = await connection.request().query('SELECT CatalogId FROM Catalogs');
    expect(result.rowsAffected).toEqual([result.recordset.length]);
  });

  it('hands back plain objects, not null-prototype ones', async () => {
    // `node:sqlite` returns rows with a null prototype. Everything that
    // spreads a row, serialises it or compares it with toEqual is happier
    // with an ordinary object, and the copy costs one shallow clone.
    const connection = await getPool();
    const result = await connection.request().query('SELECT 1 AS one');
    expect(Object.getPrototypeOf(result.recordset[0])).toBe(Object.prototype);
  });
});

describe('transactions serialise access to the one handle', () => {
  it('runs two concurrent transactions one after the other, not interleaved', async () => {
    // Without the connection lock, the second BEGIN would fail ("cannot
    // start a transaction within a transaction") or — far worse — the first
    // COMMIT would commit the second transaction's half-finished work.
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
    // db/pool.ts's withDb() retries exactly this and nothing else, so the
    // classification has to come off a code rather than a sentence.
    const connection = await getPool();
    connection.close();

    try {
      await connection.request().query('SELECT 1');
      throw new Error('expected the closed connection to refuse the query');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ERR_INVALID_STATE');
    } finally {
      // Leave a working database behind for whatever runs next.
      await withTestDb(() => undefined).catch(() => undefined);
    }
  });
});
