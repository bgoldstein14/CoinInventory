/*
 * routes/lookups/denomination-lookup.spec.ts — every way the lookup fails,
 * exercised.
 *
 * *** THIS FILE IS THE REASON THE FEATURE COULD BE BUILT AT ALL. *** The
 * note that used to sit at the bottom of category-modal.ts refused to build
 * this lookup, and the decisive reason was that "a lookup whose correct
 * behaviour is 'returns nothing, and that is not an error' is
 * indistinguishable from one that is broken, or one that was never wired
 * up". It is distinguishable if the failing paths are tested, which is what
 * `setLookupFetch` is for: no network is reached here, and the suite does
 * not depend on a third party being up while it runs.
 *
 * WHAT IS NOT TESTED HERE, DELIBERATELY: that Wikidata has good data. It
 * does not, for ancients, and the measured hit rate is written down in
 * wikidata-denominations.ts. That is why nothing is auto-inserted.
 */

import { describe, expect, it, afterEach } from 'vitest';
import request from 'supertest';

import { app } from '../../server';
import { LOOKUP_TIMEOUT_MS, setLookupFetch } from './denomination-lookup';
import { LOOKUP_USER_AGENT } from './wikidata-denominations';

type Fetched = { url: string; headers: Record<string, string> };

/** Install a fetch that records its call and answers however the test says. */
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

    // Nothing resembling a path, a user name or a machine name travels.
    expect(call.url).not.toMatch(/%5C|\\/);
    expect(JSON.stringify(call.headers)).not.toMatch(/@/);
  });

  it('calls a well-formed empty answer "none", not an error', async () => {
    // THE COMMONEST OUTCOME for an ancient issuer. A 500 here would put an
    // error dialog in front of the normal case.
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
    // Measured: the endpoint really does answer 504 for an expensive
    // query, and it took 65 seconds to do it.
    const stub = stubFetch(() => ({ ok: false, status: 504, json: async () => ({}) }));
    restore = stub.restore;

    const res = await request(app).get('/api/denomination-lookup?name=Burma').expect(200);
    expect(res.body.outcome).toBe('unavailable');
    expect(res.body.reason).toContain('504');
  });

  it('gives up rather than leaving the user in front of a stalled form', async () => {
    // The abort fires on the route's own timer. Simulated by throwing what
    // an aborted fetch throws, so the branch that distinguishes a timeout
    // from a dead network is the one under test.
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
    // The caller being broken IS an error, unlike the world being
    // unhelpful. And no packet leaves for an empty name.
    const stub = stubFetch(() => okResponse([]));
    restore = stub.restore;

    await request(app).get('/api/denomination-lookup').expect(400);
    await request(app).get('/api/denomination-lookup?name=%20%20').expect(400);
    expect(stub.calls).toEqual([]);
  });

  it('treats a repeated or object-shaped name parameter as a single string', async () => {
    const stub = stubFetch(() => okResponse([]));
    restore = stub.restore;

    // A genuinely repeated parameter still arrives as an ARRAY, and still
    // collapses to the first value.
    await request(app).get('/api/denomination-lookup?name=Burma&name=Siam').expect(200);
    expect(decodeURIComponent(stub.calls[0].url)).toContain('"Burma"');

    /*
     * `?name[0]=x` USED to arrive as an array under `name`, because Express 4
     * parsed query strings with `qs` ("extended"). Express 5 defaults to the
     * plain `querystring` parser, so the key is the literal string
     * `name[0]` and there is no `name` parameter at all — hence 400, the
     * same answer as omitting it.
     *
     * This is stricter, and better: the route never wanted a nested
     * structure, and nothing in this server does (five `req.query` reads,
     * every one a plain scalar). Asserted here so the change is recorded
     * rather than rediscovered, and so that restoring
     * `app.set('query parser', 'extended')` to make something else work
     * fails this test and gets argued about first.
     */
    await request(app).get('/api/denomination-lookup?name[0]=Siam').expect(400);
    expect(stub.calls).toHaveLength(1);

    /*
     * `?name[key]=x` was an OBJECT under Express 4's `qs` parser, and
     * calling `.trim()` on it would have been a TypeError inside the handler
     * and a 500 for the caller — which is why the defensive collapse in
     * `toSingleValue` exists.
     *
     * Under Express 5 it is simply the literal key `name[key]`, so there is
     * no `name` and the answer is 400 for the ordinary reason. Same status,
     * reached a safer way. The defence stays because a genuinely repeated
     * parameter still produces an array (asserted above) and because the
     * parser is a setting someone could change back.
     */
    await request(app).get('/api/denomination-lookup?name[key]=Burma').expect(400);
    expect(stub.calls).toHaveLength(1);
  });

  it('writes nothing to the database, whatever comes back', async () => {
    // The route holds no database handle at all, which is the strongest
    // form of this guarantee. Asserted on the module's text so that adding
    // one is a deliberate act somebody has to also delete this test for.
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(path.join(__dirname, 'denomination-lookup.ts'), 'utf8');

    expect(source).not.toContain('withDb');
    expect(source).not.toContain('INSERT');
  });
});
