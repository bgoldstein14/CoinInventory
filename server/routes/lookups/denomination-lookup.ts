/*
 * Outbound lookup of denominations for an issuer:
 *
 *   GET /api/denomination-lookup?name=Burma
 *     -> { outcome, source, proposals: string[], reason }
 *
 * Fetches candidate denomination names for an issuer from Wikidata (see
 * wikidata-denominations.ts); the user confirms each one. Read-only: it has no
 * database access. Made server-side so there is one place to time out, log
 * and stub, with no CORS dependency. The client skips the call entirely when
 * the form's lookup checkbox is unticked.
 *
 * - A failed or empty lookup is HTTP 200 with an `outcome`, not an error
 *   status; only a missing `name` is a 400.
 * - Short timeout: the public endpoint has taken 65 s to answer 504.
 * - Sends only the issuer name, with a generic User-Agent.
 * - Proposals are capped, length-limited and de-duplicated.
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
 * How long before the lookup is abandoned. Successful queries took 0.2-6 s;
 * failures took a minute.
 */
export const LOOKUP_TIMEOUT_MS = 8000;

/** The three possible outcomes. */
export type LookupOutcome = 'results' | 'none' | 'unavailable';

export interface DenominationLookupResponse {
  outcome: LookupOutcome;
  /** Named so the screen can say where a proposal came from. */
  source: string;
  proposals: string[];
  /** For the log and the screen's one-line explanation. */
  reason: string | null;
}

/** The `fetch` this route uses; injectable so specs can run every branch without a network. */
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

/** Asks Wikidata. Always resolves; callers read `outcome`. */
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
    // No internet, timeout abort or non-JSON body: all mean "unavailable".
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
  // Repeated or bracketed query params arrive as arrays or objects; treat
  // non-strings as absent so this stays a 400, not a 500.
  const rawName = req.query['name'];
  const firstName = Array.isArray(rawName) ? rawName[0] : rawName;
  const name = typeof firstName === 'string' ? firstName.trim() : '';

  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  res.json(await lookUpDenominations(name));
});

export default router;
