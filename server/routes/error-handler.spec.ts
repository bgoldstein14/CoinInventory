/**
 * routes/error-handler.spec.ts — tests for the app-wide Express error handler.
 *
 * The regression being guarded is the one described at the top of
 * error-handler.ts: an oversized upload used to be reported as 500 "Internal
 * server error", hiding the 413 that body-parser had already worked out. During
 * a batch photo import that sent the user looking for a broken server instead
 * of simply sending fewer images.
 *
 * The 413 test drives a REAL express.json() with a tiny 1 KB limit rather than
 * mocking the error. That exercises the exact code path the defect lived on —
 * body-parser rejecting a request and calling next(err) with a
 * PayloadTooLargeError — without having to send 50 MB through the test. The
 * production limit is 50mb; only the number differs.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { globalErrorHandler, errorStatusFor, errorMessageFor } from './error-handler';

/**
 * Builds a minimal app wired the same way server.ts is: express.json() first,
 * a route, then the global error handler last.
 *
 * @param limit - The body size limit to give express.json().
 */
function buildTestApp(limit: string) {
  const testApp = express();
  testApp.use(express.json({ limit }));
  testApp.post('/api/thing', (_req, res) => {
    res.status(201).json({ ok: true });
  });
  // A route that hands a deliberate error to the error handler, so the
  // "nothing useful known about this error" path can be tested too.
  testApp.get('/api/boom', () => {
    throw new Error('Connection string: Server=BRUCE_PC;Password=hunter2');
  });
  testApp.use(globalErrorHandler);
  return testApp;
}

// ============================================================
// The 413 regression
// ============================================================

describe('oversized request bodies', () => {
  it('surfaces body-parser PayloadTooLargeError as 413, not 500', async () => {
    const testApp = buildTestApp('1kb');

    // Comfortably over the limit, and shaped like a real image upload.
    const oversized = { images: ['data:image/jpeg;base64,' + 'A'.repeat(4096)] };

    const res = await request(testApp).post('/api/thing').send(oversized);

    expect(res.status).toBe(413);
    // The message has to name the actual problem — "Internal server error"
    // gives the user nothing to act on.
    expect(res.body.error).toMatch(/too large/i);
    expect(res.body.error).toMatch(/fewer images/i);
  });

  it('still accepts a body under the limit', async () => {
    const testApp = buildTestApp('1kb');

    const res = await request(testApp).post('/api/thing').send({ images: ['small'] });

    expect(res.status).toBe(201);
  });

  it('keeps reporting 500 for errors that carry no usable status', async () => {
    const testApp = buildTestApp('1kb');

    const res = await request(testApp).get('/api/boom');

    expect(res.status).toBe(500);
    // The generic message is deliberate: an unexpected error's text can contain
    // connection strings, file paths or SQL, none of which belongs in a
    // response body. The detail goes to app.log instead.
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('hunter2');
  });
});

// ============================================================
// errorStatusFor / errorMessageFor unit coverage
// ============================================================

describe('errorStatusFor', () => {
  it('honours body-parser PayloadTooLargeError', () => {
    const err = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      type: 'entity.too.large',
    });
    expect(errorStatusFor(err)).toBe(413);
  });

  it('honours statusCode when only that is set', () => {
    expect(errorStatusFor(Object.assign(new Error('nope'), { statusCode: 404 }))).toBe(404);
  });

  it('defaults to 500 for an ordinary Error', () => {
    expect(errorStatusFor(new Error('boom'))).toBe(500);
  });

  it('ignores a status outside the 400-599 HTTP range', () => {
    // Some libraries use `status` for something else entirely (an exit code, an
    // enum, a plain 0). res.status() throws on those, and a throw inside the
    // error handler would leave the request hanging with no response at all.
    for (const bogus of [0, -1, 200, 302, 600, 1001]) {
      expect(errorStatusFor(Object.assign(new Error('x'), { status: bogus }))).toBe(500);
    }
  });

  it('ignores a non-integer or non-numeric status', () => {
    expect(errorStatusFor(Object.assign(new Error('x'), { status: '413' }))).toBe(500);
    expect(errorStatusFor(Object.assign(new Error('x'), { status: 413.5 }))).toBe(500);
    expect(errorStatusFor(null)).toBe(500);
    expect(errorStatusFor(undefined)).toBe(500);
  });
});

describe('errorMessageFor', () => {
  it('explains the upload limit for 413', () => {
    const message = errorMessageFor(new Error('request entity too large'), 413);
    expect(message).toMatch(/50 MB/);
    expect(message).toMatch(/fewer images/i);
  });

  it('stays generic for every other status', () => {
    expect(errorMessageFor(new Error('secret detail'), 500)).toBe('Internal server error');
    expect(errorMessageFor(new Error('secret detail'), 404)).toBe('Internal server error');
  });
});
