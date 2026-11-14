/*
 * routes/lookups/denomination-lookup.ts — the app's ONLY outbound request.
 *
 *   GET /api/denomination-lookup?name=Burma
 *     -> { outcome, source, proposals: string[], reason }
 *
 * Nothing here writes to the database and nothing here can. It fetches a
 * list of candidate denomination names for an issuer the user has just
 * named, and the user decides, one by one, which of them are real. See
 * wikidata-denominations.ts for why Wikidata, why the query is shaped as it
 * is, and what the measured hit rate actually was.
 *
 * *** THE REQUEST IS MADE SERVER-SIDE ON PURPOSE. ***
 * It is one place to time out, one place to log, and one place a test can
 * replace `fetch`. Putting it in the browser would also make the Angular
 * app's behaviour depend on a third party's CORS headers.
 *
 * *** THIS ROUTE DOES NOT DECIDE WHETHER TO ASK. ***
 * The checkbox on the issuer form does, and the client must not call this
 * at all when it is unticked. "Unchecked must skip the request entirely,
 * not make it and discard the answer" was explicit, and the only way to
 * honour it is for the caller not to call. A route cannot un-send a packet.
 *
 * FOUR THINGS ARE NOT NEGOTIABLE HERE
 *
 * 1. IT NEVER RETURNS AN ERROR STATUS FOR A FAILED LOOKUP. No network, a
 *    504 from the endpoint, a timeout and a well-formed empty answer all
 *    come back as HTTP 200 with an `outcome` saying which. A lookup that
 *    finds nothing is a NORMAL OUTCOME, and a 500 would make the screen
 *    show an error dialog for the commonest case. A missing `name` is still
 *    a 400, because that is the caller being broken rather than the world
 *    being unhelpful.
 *
 * 2. IT TIMES OUT, AND SHORT. The endpoint is a shared public service and
 *    has been seen to take 65 seconds before answering 504. The user is
 *    standing in front of a form they have just filled in.
 *
 * 3. IT SENDS THE ISSUER NAME AND NOTHING ELSE. No machine name, no user
 *    name, no collection detail, and a User-Agent that identifies the
 *    application rather than its owner.
 *
 * 4. THE PROPOSALS ARE NOT TRUSTED. Everything shaping them is in the pure
 *    module, including the cap, the length limit and the de-duplication
 *    that stops two spellings of one coin being offered as two coins.
 */

import { Router, Request, Response } from 'express';

import { logInfo, logWarn } from '../../logger';

import {
  LOOKUP_SOURCE_NAME,
  LOOKUP_USER_AGENT,
  buildDenominationQueryUrl,
  parseDenominationResults,
} from './wikidata-denominations';

const router = Router();

/**
 * How long the user waits before the lookup is abandoned.
 *
 * Eight seconds. The measured successful queries took 0.2 to 6 seconds; the
 * failures took a minute. There is nothing to gain from the gap between
 * those two, and giving up lands on the same offline path the user would
 * have reached with no network at all.
 */
export const LOOKUP_TIMEOUT_MS = 8000;

/** What happened, in the only three ways it is allowed to happen. */
export type LookupOutcome = 'results' | 'none' | 'unavailable';

export interface DenominationLookupResponse {
  outcome: LookupOutcome;
  /** Named so the screen can say where a proposal came from. */
  source: string;
  proposals: string[];
  /** For the log and the screen's one-line explanation. Never an error. */
  reason: string | null;
}

/**
 * The `fetch` this route uses.
 *
 * Injectable so the route's own spec can run every branch -- a refusal, a
 * timeout, a 504, a malformed body -- without a network and without
 * depending on a third party being up while the test suite runs. That is
 * precisely the objection that kept this feature unbuilt: a path whose
 * correct behaviour is "returns nothing, and that is not an error" is
 * indistinguishable from a broken one unless it is exercised.
 */
type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

let fetchImpl: FetchLike = (url: string, init): ReturnType<FetchLike> =>
  fetch(url, init) as unknown as ReturnType<FetchLike>;

/** Swap the fetch in. Returns the previous one so a spec can put it back. */
export function setLookupFetch(next: FetchLike): FetchLike {
  const previous = fetchImpl;
  fetchImpl = next;
  return previous;
}

/**
 * Ask Wikidata. Resolves, always -- it is the caller's job to read
 * `outcome`, not to catch.
 */
export async function lookUpDenominations(issuerName: string): Promise<DenominationLookupResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetchImpl(buildDenominationQueryUrl(issuerName), {
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': LOOKUP_USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      logWarn(`Denomination lookup for "${issuerName}" got HTTP ${response.status}`);
      return {
        outcome: 'unavailable',
        source: LOOKUP_SOURCE_NAME,
        proposals: [],
        reason: `${LOOKUP_SOURCE_NAME} answered ${response.status}`,
      };
    }

    const proposals = parseDenominationResults(await response.json());
    logInfo(`Denomination lookup for "${issuerName}": ${proposals.length} candidate(s)`);

    return {
      outcome: proposals.length > 0 ? 'results' : 'none',
      source: LOOKUP_SOURCE_NAME,
      proposals,
      reason: null,
    };
  } catch (error) {
    // A DNS failure on a machine with no internet, an abort when the timer
    // fired, a body that was not JSON. None of them is an error the user
    // did anything about, and all of them mean the same thing to them.
    const aborted = (error as { name?: string } | null)?.name === 'AbortError';
    logWarn(`Denomination lookup for "${issuerName}" failed: ${aborted ? 'timed out' : String(error)}`);

    return {
      outcome: 'unavailable',
      source: LOOKUP_SOURCE_NAME,
      proposals: [],
      reason: aborted ? `${LOOKUP_SOURCE_NAME} did not answer in time` : 'no connection',
    };
  } finally {
    clearTimeout(timer);
  }
}

router.get('/denomination-lookup', async (req: Request, res: Response) => {
  // `?name=a&name=b` hands back an array and `?name[0]=x` an OBJECT.
  // Collapse, and treat a non-string as absent rather than calling .trim()
  // on an object and turning the caller's 400 into a 500.
  const rawName = req.query['name'];
  const firstName = Array.isArray(rawName) ? rawName[0] : rawName;
  const name = typeof firstName === 'string' ? firstName.trim() : '';

  if (!name) {
    // The caller is broken, not the world. This is the one 400 here.
    res.status(400).json({ error: 'name is required' });
    return;
  }

  res.json(await lookUpDenominations(name));
});

export default router;
