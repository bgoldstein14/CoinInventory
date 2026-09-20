/**
 * test-support/mssql-mock.ts — the fake `mssql` module every spec file shares.
 *
 * ------------------------------------------------------------------
 * Why this exists
 * ------------------------------------------------------------------
 * db/pool.ts no longer calls the global `sql.connect()`. It constructs
 * `new sql.ConnectionPool(config)` and — critically — attaches an 'error'
 * listener to it before connecting. So the mock pool must be a real
 * EventEmitter, otherwise the crash regression test in db/connection.spec.ts
 * cannot emit 'error' on it.
 *
 * Getting that right is fiddly, so it is written once here rather than copied
 * into each spec file. A spec opts in with:
 *
 *   vi.mock('mssql', async () => {
 *     const { createMssqlMock } = await import('../test-support/mssql-mock');
 *     return createMssqlMock();
 *   });
 *
 * and then imports `mockRequest`, `resetMssqlMock`, etc. from this module to
 * drive it. Vitest gives every spec FILE its own module registry, so the
 * mutable state below is never shared between files.
 *
 * NOTE: this is test scaffolding, not production code. Nothing under db/ or
 * routes/ may import it.
 */

import { vi } from 'vitest';
import { EventEmitter } from 'events';

/** One recorded `.input(name, type, value)` call. */
export interface CapturedInput {
  name: string;
  type: unknown;
  value: unknown;
}

/** Every .input(name, type, value) the code under test makes, in order. */
export const capturedInputs: CapturedInput[] = [];

/** Default recordset / rowsAffected handed back by `query()`. */
export const mockRecordset: Record<string, unknown>[] = [];
export const mockRowsAffected = [1];

export const mockRequest = {
  query: vi.fn().mockResolvedValue({ recordset: mockRecordset, rowsAffected: mockRowsAffected }),
};

export const mockTransaction = {
  begin: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue(undefined),
  rollback: vi.fn().mockResolvedValue(undefined),
};

/** Builds a chainable request object that records its bound parameters. */
function makeRecordingRequest(): Record<string, unknown> {
  const req: Record<string, unknown> = {
    input(name: string, type: unknown, value: unknown) {
      capturedInputs.push({ name, type, value });
      return req;
    },
    query: mockRequest.query,
  };
  return req;
}

/**
 * One shared pool object. Returning the same object from every construction
 * keeps the tests simple and lets them emit 'error' on "the" pool.
 */
export const mockPool = {
  connected: true,
  request: vi.fn(makeRecordingRequest),
  close: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
};

/**
 * Give the mock pool genuine Node EventEmitter behaviour.
 *
 * Using the real EventEmitter matters: the production crash was Node's
 * "emit('error') with no listeners throws" rule, and a hand-rolled stub would
 * not reproduce it.
 */
Object.setPrototypeOf(mockPool, EventEmitter.prototype);
EventEmitter.call(mockPool as unknown as EventEmitter);
// Each new pool generation attaches its own 'error' listener; across a whole
// test file that exceeds Node's default warning threshold of 10.
(mockPool as unknown as EventEmitter).setMaxListeners(0);

/** Records every `new sql.ConnectionPool(config)` so tests can count them. */
export const poolConstructorSpy = vi.fn();

/**
 * Builds the object that stands in for the real `mssql` module.
 * Pass the result straight back out of a `vi.mock('mssql', ...)` factory.
 */
export function createMssqlMock() {
  const NVarChar = (len?: number) => ({ type: 'nvarchar', length: len });
  (NVarChar as unknown as { MAX: string }).MAX = 'max';

  class MockTransaction {
    begin = mockTransaction.begin;
    commit = mockTransaction.commit;
    rollback = mockTransaction.rollback;
  }

  // `new sql.Request(transaction)` — records its parameters the same way the
  // pool-backed request does, so tests can assert on parameter types/lengths.
  class MockRequest {
    input(name: string, type: unknown, value: unknown): this {
      capturedInputs.push({ name, type, value });
      return this;
    }
    query = mockRequest.query;
  }

  // mssql's real ConnectionError subclasses Error; isConnectionError() checks
  // `err instanceof sql.ConnectionError`, so the mock must provide the class.
  class MockConnectionError extends Error {}

  return {
    default: {
      ConnectionPool: function ConnectionPool(_config: unknown) {
        poolConstructorSpy(_config);
        return mockPool;
      } as unknown as new (config: unknown) => unknown,
      ConnectionError: MockConnectionError,
      connect: vi.fn().mockResolvedValue(mockPool),
      NVarChar,
      Int: { type: 'int' },
      Bit: { type: 'bit' },
      Date: { type: 'date' },
      Decimal: () => ({ type: 'decimal' }),
      Transaction: MockTransaction,
      Request: MockRequest,
      MAX: 'max',
    },
  };
}

/**
 * Returns the mock to its default state. Call from `beforeEach` in every spec.
 *
 * `vi.clearAllMocks()` drops mock implementations in Vitest 4, so the ones the
 * pool needs have to be restored afterwards on every test.
 */
export function resetMssqlMock(): void {
  vi.clearAllMocks();

  mockRecordset.length = 0;
  mockRowsAffected[0] = 1;
  capturedInputs.length = 0;
  mockPool.connected = true;

  mockPool.request.mockImplementation(makeRecordingRequest);
  mockPool.close.mockResolvedValue(undefined);
  mockPool.connect.mockResolvedValue(undefined);
  mockRequest.query.mockResolvedValue({ recordset: mockRecordset, rowsAffected: mockRowsAffected });
}
