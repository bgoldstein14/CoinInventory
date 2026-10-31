/**
 * db/connection.spec.ts — tests for the connection half of the database layer:
 * db/config.ts, db/pool.ts and db/errors.ts.
 *
 * This file carries the regression test for the production crash. If you only
 * read one spec in this project, read the "crash regression" describe below.
 *
 * Note it deliberately does NOT import the Express app — everything here is
 * exercised through the db/ API directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../test-support/mssql-mock');
  return createMssqlMock();
});

import {
  mockPool,
  mockRequest,
  poolConstructorSpy,
  resetMssqlMock,
} from '../test-support/mssql-mock';

import {
  buildDbConfig,
  getPool,
  resetPool,
  withDb,
  isConnectionError,
} from './index';

beforeEach(() => {
  resetMssqlMock();
});

describe('buildDbConfig', () => {
  it('normalizes SQL Server host/port values when server includes a comma', () => {
    const previousServer = process.env.DB_SERVER;
    const previousPort = process.env.DB_PORT;
    const previousUser = process.env.DB_USER;

    try {
      process.env.DB_SERVER = 'localhost,1433';
      process.env.DB_PORT = '1433';
      delete process.env.DB_USER;

      const config = buildDbConfig();
      expect(config.server).toBe('localhost');
      expect(config.port).toBe(1433);
    } finally {
      if (previousServer === undefined) delete process.env.DB_SERVER;
      else process.env.DB_SERVER = previousServer;

      if (previousPort === undefined) delete process.env.DB_PORT;
      else process.env.DB_PORT = previousPort;

      if (previousUser === undefined) delete process.env.DB_USER;
      else process.env.DB_USER = previousUser;
    }
  });

  it('configures the pool to keep a warm connection and bounded timeouts', () => {
    const config = buildDbConfig();
    expect(config.pool).toMatchObject({
      max: 10,
      min: 1,
      idleTimeoutMillis: 60000,
      acquireTimeoutMillis: 15000,
    });
    expect(config.connectionTimeout).toBe(15000);
    expect(config.requestTimeout).toBe(30000);
    expect(config.options).toMatchObject({
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    });
  });
});

// ============================================================
// REGRESSION TEST FOR THE PRODUCTION CRASH
// ============================================================
//
// The bug: db.ts created the pool without attaching an 'error' listener.
// mssql's ConnectionPool is an EventEmitter, and a Node EventEmitter with zero
// 'error' listeners THROWS when emit('error') is called. That throw happened
// inside a socket callback, so it became an uncaught exception and killed the
// whole Express process the moment SQL Server dropped an idle connection.
//
// These tests would have caught it: they emit 'error' on the pool and assert
// nothing throws. The listener now lives in createPooledConnection() in
// db/pool.ts — delete that one line and the first test below fails.

describe('connection pool error handling (crash regression)', () => {
  afterEach(async () => {
    await resetPool();
  });

  it('does not throw when the pool emits an error (this used to kill the process)', async () => {
    await resetPool();
    const pool = await getPool();

    // The whole point: at least one 'error' listener must be attached.
    expect((pool as unknown as EventEmitter).listenerCount('error')).toBeGreaterThan(0);

    // Before the fix this line threw an unhandled "Unhandled error. (boom)" and
    // took the process down with it.
    expect(() => {
      (pool as unknown as EventEmitter).emit('error', new Error('boom'));
    }).not.toThrow();
  });

  it('marks the pool unhealthy after an error so the next caller gets a fresh one', async () => {
    await resetPool();
    const pool = await getPool();

    poolConstructorSpy.mockClear();
    mockPool.connect.mockClear();

    (pool as unknown as EventEmitter).emit('error', new Error('socket died'));

    // The unhealthy pool is torn down and rebuilt on the next request.
    await getPool();
    expect(poolConstructorSpy).toHaveBeenCalledTimes(1);
    expect(mockPool.connect).toHaveBeenCalledTimes(1);
  });

  it('shares a single connect attempt between concurrent callers (single-flight)', async () => {
    await resetPool();
    poolConstructorSpy.mockClear();
    mockPool.connect.mockClear();

    // The Angular app fires ~7 requests in parallel on load. Without the
    // single-flight guard each of them opened a competing pool.
    await Promise.all([getPool(), getPool(), getPool(), getPool(), getPool(), getPool(), getPool()]);

    expect(poolConstructorSpy).toHaveBeenCalledTimes(1);
    expect(mockPool.connect).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale generation reset so a late failure cannot kill a fresh pool', async () => {
    await resetPool();
    await getPool();

    // Generation 1 is live. A request that started on an older generation asks
    // us to reset generation 0 — that must be a no-op.
    mockPool.close.mockClear();
    await resetPool(0);
    expect(mockPool.close).not.toHaveBeenCalled();
  });

  it('does not run a SELECT 1 health check on every request', async () => {
    await resetPool();
    await getPool();

    mockRequest.query.mockClear();
    await getPool();

    // The old getPool() issued 'SELECT 1' before handing back the pool,
    // doubling round trips and racing with in-flight queries.
    expect(mockRequest.query).not.toHaveBeenCalled();
  });
});

describe('isConnectionError', () => {
  it('recognises mssql/tedious connection failure codes', () => {
    for (const code of ['ECONNCLOSED', 'ESOCKET', 'ETIMEOUT', 'ECONNRESET', 'ENOTOPEN', 'ELOGIN', 'EALREADYCONNECTED', 'ENOTFOUND']) {
      const err = Object.assign(new Error('nope'), { code });
      expect(isConnectionError(err), code).toBe(true);
    }
  });

  it('recognises connection failures by message', () => {
    expect(isConnectionError(new Error('Connection is closed.'))).toBe(true);
    expect(isConnectionError(new Error('socket hang up'))).toBe(true);
  });

  it('is conservative: ordinary query errors are NOT connection errors', () => {
    // If this ever returns true we would tear down the shared pool because of a
    // constraint violation — the exact defect this work removed.
    const constraintViolation = Object.assign(new Error('Violation of PRIMARY KEY constraint'), { number: 2627 });
    expect(isConnectionError(constraintViolation)).toBe(false);
    expect(isConnectionError(new Error('Invalid column name'))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });
});

describe('withDb', () => {
  afterEach(async () => {
    await resetPool();
  });

  it('retries exactly once on a connection-class error', async () => {
    await resetPool();

    const work = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Connection is closed.'), { code: 'ECONNCLOSED' }))
      .mockResolvedValueOnce('second attempt');

    await expect(withDb(work)).resolves.toBe('second attempt');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry — and does not reset the pool — on an ordinary query error', async () => {
    await resetPool();
    await getPool();

    mockPool.close.mockClear();

    const queryError = Object.assign(new Error('Violation of UNIQUE KEY constraint'), { number: 2601 });
    const work = vi.fn().mockRejectedValue(queryError);

    await expect(withDb(work)).rejects.toBe(queryError);
    expect(work).toHaveBeenCalledTimes(1);
    // The shared pool must survive an ordinary query failure.
    expect(mockPool.close).not.toHaveBeenCalled();
  });
});
