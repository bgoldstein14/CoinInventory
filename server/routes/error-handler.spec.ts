/**
 * The app-wide error handler. Guards against an oversized upload being
 * reported as a generic 500 instead of body-parser's 413. Uses a real
 * express.json() with a 1 KB limit (production is 50 MB).
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { globalErrorHandler, errorStatusFor, errorMessageFor } from './error-handler';

/**
 * A minimal app wired like server.ts: express.json(), a route, then the error handler.
 *
 * @param limit - The body size limit to give express.json().
 */
function buildTestApp(limit: string) {
  const testApp = express();
  testApp.use(express.json({ limit }));
  testApp.post('/api/thing', (_req, res) => {
    res.status(201).json({ ok: true });
  });
  // Passes a deliberate error to the handler, for the generic path.
  testApp.get('/api/boom', () => {
    throw new Error('Connection string: Server=MYSERVER;Password=hunter2');
  });
  testApp.use(globalErrorHandler);
  return testApp;
}

// The 413 regression

describe('oversized request bodies', () => {
  it('surfaces body-parser PayloadTooLargeError as 413, not 500', async () => {
    const testApp = buildTestApp('1kb');

    // Over the limit, shaped like an image upload.
    const oversized = { images: ['data:image/jpeg;base64,' + 'A'.repeat(4096)] };

    const res = await request(testApp).post('/api/thing').send(oversized);

    expect(res.status).toBe(413);
    // The message must name the actual problem.
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
    // Generic on purpose: error text can contain paths or SQL.
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('hunter2');
  });
});

// errorStatusFor / errorMessageFor unit coverage

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
    // Non-HTTP `status` values; res.status() would throw on them.
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
