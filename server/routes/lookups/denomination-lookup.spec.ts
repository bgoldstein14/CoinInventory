/*
 * Every failure path of the denomination lookup, with fetch stubbed via
 * setLookupFetch so no network is used. A lookup that correctly finds nothing
 * looks like a broken one unless these paths are tested. Wikidata's data
 * quality is not tested here.
 */

import { describe, expect, it, afterEach } from 'vitest';
import request from 'supertest';

import { app } from '../../server';
import { LOOKUP_TIMEOUT_MS, setLookupFetch } from './denomination-lookup';
import { LOOKUP_USER_AGENT } from './wikidata-denominations';

type Fetched = { url: string; headers: Record<string, string> };

/** Installs a fetch that records its call and answers as the test says. */
function stubFetch(answer: (call: Fetched) => unknown): { calls: Fetched[]; restore: () => void } {
  const calls: Fetched[] = [];
  const previous = setLookupFetch(async (url, init) => {
    const call = { url, headers: init.headers };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Error) throw result;
    return result as { ok: boolean; status: number; json(): Promise<unknown> };
  });
  return { calls, restore: () => setLookupFetch(previous) };
}

function okResponse(labels: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: { bindings: labels.map((value) => ({ denominationLabel: { value } })) },
    }),
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('GET /api/denomination-lookup', () => {
  it('returns the proposals it was given, sorted and de-duplicated', () => {
    const stub = stubFetch(() => okResponse(['kyat', 'Burmese rupee', 'Kyat']));
    restore = stub.restore;

    return request(app)
      .get('/api/denomination-lookup?name=Burma')
      .expect(200)
      .then((res) => {
        expect(res.body).toEqual({
          outcome: 'results',
          source: 'Wikidata',
          proposals: ['Burmese rupee', 'kyat'],
          reason: null,
        });
      });
  });

  it('sends the issuer name and nothing else about the machine it runs on', async () => {
    const stub = stubFetch(() => okResponse([]));
    restore = stub.restore;

    await request(app).get('/api/denomination-lookup?name=Burma').expect(200);

    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    expect(call.url).toContain('query.wikidata.org');
    expect(decodeURIComponent(call.url)).toContain('"Burma"');
    expect(call.headers['User-Agent']).toBe(LOOKUP_USER_AGENT);

    // No path, user name or machine name is sent.
    expect(call.url).not.toMatch(/%5C|\\/);
    expect(JSON.stringify(call.headers)).not.toMatch(/@/);
  });

  it('calls a well-formed empty answer "none", not an error', async () => {
    // The commonest outcome for an ancient issuer: not an error.
    const stub = stubFetch(() => okResponse([]));
    restore = stub.restore;

    const res = await request(app).get('/api/denomination-lookup?name=Athens').expect(200);
    expect(res.body.outcome).toBe('none');
    expect(res.body.proposals).toEqual([]);
    expect(res.body.reason).toBeNull();
  });

  it('answers 200 with outcome "unavailable" when there is no network', async () => {
    const stub = stubFetch(() => Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }));
    restore = stub.restore;

    const res = await request(app).get('/api/denomination-lookup?name=Burma').expect(200);
    expect(res.body.outcome).toBe('unavailable');
    expect(res.body.proposals).toEqual([]);
    expect(res.body.reason).toBe('no connection');
  });

  it('answers 200 with outcome "unavailable" when the endpoint says 504', async () => {
    // The endpoint really does answer 504 for expensive queries.
    const stub = stubFetch(() => ({ ok: false, status: 504, json: async () => ({}) }));
    restore = stub.restore;

    const res = await request(app).get('/api/denomination-lookup?name=Burma').expect(200);
    expect(res.body.outcome).toBe('unavailable');
    expect(res.body.reason).toContain('504');
  });

  it('gives up rather than leaving the user in front of a stalled form', async () => {
    // Simulates a timeout abort, distinct from a dead network.
    const stub = stubFetch(() => Object.assign(new Error('aborted'), { name: 'AbortError' }));
    restore = stub.restore;

    const res = await request(app).get('/api/denomination-lookup?name=Burma').expect(200);
    expect(res.body.outcome).toBe('unavailable');
    expect(res.body.reason).toContain('did not answer in time');
    expect(LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(10000);
  });

  it('survives a body that is not the JSON it asked for', async () => {
    const stub = stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    }));
    restore = stub.restore;

    const res = await request(app).get('/api/denomination-lookup?name=Burma').expect(200);
    expect(res.body.outcome).toBe('unavailable');
  });

  it('survives JSON of entirely the wrong shape', async () => {
    const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }));
    restore = stub.restore;

    const res = await request(app).get('/api/denomination-lookup?name=Burma').expect(200);
    expect(res.body.outcome).toBe('none');
    expect(res.body.proposals).toEqual([]);
  });

  it('refuses a missing name with a 400, and makes no request', async () => {
    // A missing name is the caller's error; nothing is sent.
    const stub = stubFetch(() => okResponse([]));
    restore = stub.restore;

    await request(app).get('/api/denomination-lookup').expect(400);
    await request(app).get('/api/denomination-lookup?name=%20%20').expect(400);
    expect(stub.calls).toEqual([]);
  });

  it('treats a repeated or object-shaped name parameter as a single string', async () => {
    const stub = stubFetch(() => okResponse([]));
    restore = stub.restore;

    // A repeated parameter arrives as an array; the first value is used.
    await request(app).get('/api/denomination-lookup?name=Burma&name=Siam').expect(200);
    expect(decodeURIComponent(stub.calls[0].url)).toContain('"Burma"');

    // Express 5's default query parser treats `name[0]` as a literal key, so
    // there is no `name` and the answer is 400. Fails if the 'extended'
    // parser is turned back on.
    await request(app).get('/api/denomination-lookup?name[0]=Siam').expect(400);
    expect(stub.calls).toHaveLength(1);

    // Likewise `name[key]` is a literal key under Express 5 (an object under
    // the old parser, which toSingleValue still defends against).
    await request(app).get('/api/denomination-lookup?name[key]=Burma').expect(400);
    expect(stub.calls).toHaveLength(1);
  });

  it('writes nothing to the database, whatever comes back', async () => {
    // Checked on the module's source: it must have no database access.
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, 'denomination-lookup.ts'), 'utf8');

    expect(source).not.toContain('withDb');
    expect(source).not.toContain('INSERT');
  });
});
