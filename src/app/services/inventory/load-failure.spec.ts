 /*
  * Tests for describeLoadFailure: a non-technical user must be able to tell "my
  * data is broken" from "the app had a problem showing it". E.g. the server
  * reads all coins but fails to serialise the response; that must not be
  * reported as a database connection failure. The server reports the failing
  * stage (server/routes/failure-report.ts). The technical line is available but
  * isn't the headline.
  */

import { describe, expect, it } from 'vitest';
import { describeLoadFailure } from './load-failure';

/** The shape Angular's HttpClient rejects with. */
function httpError(status: number, statusText: string, body: unknown): unknown {
  return { status, statusText, error: body };
}

/** What the server sends when res.json() couldn't build the response. */
const DELIVERY_BODY = {
  error:
    'The coin list could not be sent to the screen. Your data is safe and the database is working — the problem is in sending it, not reading it.',
  stage: 'delivery',
  detail: 'RangeError: Invalid string length in GET /api/coins',
};

describe('describeLoadFailure — the 2026-11-08 delivery failure', () => {
  it('does not say the database failed', () => {
    const failure = describeLoadFailure(httpError(500, 'Internal Server Error', DELIVERY_BODY));

    // The database was fine, so the title must not say it is unavailable.
    expect(failure.title).not.toMatch(/database unavailable/i);
    expect(failure.message).not.toMatch(/cannot connect/i);
    expect(failure.message).not.toMatch(/failed to connect/i);
  });

  it('leads with what failed and promises what is safe', () => {
    const failure = describeLoadFailure(httpError(500, 'Internal Server Error', DELIVERY_BODY));

    expect(failure.stage).toBe('delivery');
    expect(failure.message).toContain('could not be sent to the screen');
    expect(failure.message).toMatch(/your data is safe/i);
    expect(failure.dataSafe).toBe(true);
  });

  it('keeps the technical line available but out of the headline', () => {
    const failure = describeLoadFailure(httpError(500, 'Internal Server Error', DELIVERY_BODY));

    expect(failure.detail).toBe('RangeError: Invalid string length in GET /api/coins');
    expect(failure.title).not.toContain('RangeError');
    expect(failure.message).not.toContain('RangeError');
  });

  it('gives the status bar a short label that still tells the truth', () => {
    const failure = describeLoadFailure(httpError(500, 'Internal Server Error', DELIVERY_BODY));

    expect(failure.statusLabel).not.toMatch(/database unavailable/i);
    expect(failure.statusLabel.length).toBeLessThan(40);
  });
});

describe('describeLoadFailure — a genuine connection failure', () => {
  it('names the database when the server says the connection is the problem', () => {
    const failure = describeLoadFailure(
      httpError(503, 'Service Unavailable', {
        error: 'The database is currently unreachable. Please try again in a moment.',
        stage: 'connection',
        detail: 'ConnectionError: Connection is closed. in GET /api/coins',
      })
    );

    expect(failure.stage).toBe('connection');
    expect(failure.title).toMatch(/database unavailable/i);
    // The database was never reached, so nothing is claimed about the data.
    expect(failure.dataSafe).toBe(false);
    expect(failure.message).not.toMatch(/your data is safe/i);
  });

  it('treats a request that never reached the server as a connection failure', () => {
    // status 0: backend down, DNS, CORS, offline; no body.
    const failure = describeLoadFailure(httpError(0, 'Unknown Error', null));

    expect(failure.stage).toBe('connection');
    expect(failure.title).toMatch(/database unavailable/i);
    expect(failure.message).toMatch(/backend server/i);
  });

  it('treats a 503 with no body as a connection failure', () => {
    // An older backend, or a proxy answering for it.
    const failure = describeLoadFailure(httpError(503, 'Service Unavailable', null));

    expect(failure.stage).toBe('connection');
  });
});

describe('describeLoadFailure — everything else', () => {
  it('reports a database-stage error as a database problem, with no reassurance', () => {
    const failure = describeLoadFailure(
      httpError(500, 'Internal Server Error', {
        error: 'Failed to retrieve coins',
        stage: 'database',
        detail: 'RequestError: Invalid column name Wibble in GET /api/coins',
      })
    );

    expect(failure.stage).toBe('database');
    expect(failure.dataSafe).toBe(false);
    expect(failure.message).not.toMatch(/your data is safe/i);
    expect(failure.detail).toContain('Invalid column name Wibble');
  });

  it('does not guess when the body says nothing about the stage', () => {
    // An old server or a proxy's 500 page: "unknown", never "database unavailable".
    const failure = describeLoadFailure(httpError(500, 'Internal Server Error', null));

    expect(failure.stage).toBe('unknown');
    expect(failure.dataSafe).toBe(false);
    expect(failure.title).not.toMatch(/database unavailable/i);
  });

  it('copes with a plain Error thrown before any request went out', () => {
    const failure = describeLoadFailure(new Error('something local broke'));

    expect(failure.stage).toBe('unknown');
    expect(failure.detail).toContain('something local broke');
    expect(failure.message).toBeTruthy();
  });

  it('ignores a stage value it does not recognise', () => {
    // An unknown future stage must not be mistaken for a known one.
    const failure = describeLoadFailure(
      httpError(500, 'Internal Server Error', { error: 'something', stage: 'wibble' })
    );

    expect(failure.stage).toBe('unknown');
    expect(failure.dataSafe).toBe(false);
  });

  it('never leaves the user with an empty message', () => {
    for (const error of [null, undefined, 'a string', 42, httpError(500, '', {})]) {
      expect(describeLoadFailure(error).message.length).toBeGreaterThan(0);
      expect(describeLoadFailure(error).title.length).toBeGreaterThan(0);
    }
  });
});
