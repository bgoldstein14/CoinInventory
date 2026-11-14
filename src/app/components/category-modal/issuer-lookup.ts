/*
 * issuer-lookup.ts — what the user is told about the denomination lookup,
 * and what they are asked to agree to.
 *
 * THE BUG THIS WHOLE FEATURE EXISTS FOR
 *
 * `POST /issuers` inserted one row and stopped. Adding an issuer left it
 * with no denominations and said nothing about it, so the next thing the
 * user did was look for the denomination they actually wanted and not find
 * it. An indicator alone would have been worse than silence -- it would
 * have advertised a lookup that did not exist -- so the behaviour was built
 * first and this is what narrates it.
 *
 * THREE RULES, AND NONE OF THEM IS A PREFERENCE
 *
 * 1. NOTHING IS WRITTEN WITHOUT THE USER SAYING SO. Denominations are
 *    reference data that coins link to BY ID. A wrong row is a wrong
 *    foreign key that outlives whatever created it, and the user has no
 *    reason to doubt something the app filled in. So the lookup PROPOSES:
 *    `toProposals` builds a tick-list and `chosenLabels` is the only way
 *    anything reaches the database.
 *
 *    The boxes start TICKED, and the confirmation is the press of a button
 *    that carries the count. Starting them unticked would have made the
 *    careless path "add nothing", which sounds safer and is in fact just
 *    the old bug with extra clicks; the count on the button is what makes
 *    the user agree to a NUMBER rather than to a dialog.
 *
 * 2. A MISS IS A NORMAL OUTCOME. Measured against the live endpoint,
 *    Wikidata answered with nothing at all for Athens and found one
 *    candidate for Parthia. `describeLookupOutcome` therefore has no error
 *    wording in it: no network, no results and a declined lookup all say
 *    what happened in a sentence and all end by pointing at the manual
 *    route, which is the one that always works.
 *
 * 3. THE OUTCOME IS ALWAYS STATED, INCLUDING ZERO. "Added Burma" on its
 *    own is the sentence that started this; every message below says how
 *    many denominations arrived and by what route.
 *
 * Pure and DOM-free: testable under Node with no jsdom, which is the only
 * way the no-results and no-network wordings get exercised at all.
 */

import {
  DenominationLookupOutcome,
  DenominationLookupResult,
} from '../../types/reference-data.model';

// Re-exported so the screen and its spec need one import, not two. The
// shapes live in types/ because ApiService fetches them and the HTTP layer
// must not import from a component folder.
export type { DenominationLookupOutcome, DenominationLookupResult };

/**
 * What the source is called before any answer has arrived.
 *
 * The consent checkbox has to name it BEFORE the request, so the user can
 * decide knowing where their typing is going. The server sends its own
 * `source` back with the answer and that one wins afterwards, which is
 * what stops this constant silently becoming a lie if the endpoint
 * changes.
 */
export const LOOKUP_SOURCE = 'Wikidata';

/** Where the issuer form is in the add-then-offer sequence. */
export type LookupPhase =
  /** Nothing in flight; the form is just a form. */
  | 'idle'
  /** The request is out. */
  | 'asking'
  /** Candidates are on screen waiting to be ticked. */
  | 'proposing'
  /** Over, one way or another. The message says which. */
  | 'settled';

/** One candidate, and whether the user wants it. */
export interface DenominationProposal {
  label: string;
  chosen: boolean;
}

/**
 * Candidates the issuer does not already have, ticked.
 *
 * `alreadyHave` matters even though a brand-new issuer has nothing: the
 * user can run the lookup, accept four, and the screen must not then offer
 * the same four again. Folded, because two rows with one label under one
 * issuer make every coin carrying that text resolve as AMBIGUOUS, and
 * ambiguous resolves to NULL -- the duplicate would delete a denomination
 * rather than add one.
 */
export function toProposals(
  labels: readonly string[],
  alreadyHave: readonly string[] = []
): DenominationProposal[] {
  const have = new Set(alreadyHave.map((label) => label.trim().toLowerCase()));
  const seen = new Set<string>();
  const proposals: DenominationProposal[] = [];

  for (const raw of labels) {
    const label = raw.trim();
    if (label.length === 0) continue;

    const folded = label.toLowerCase();
    if (have.has(folded) || seen.has(folded)) continue;
    seen.add(folded);

    proposals.push({ label, chosen: true });
  }

  return proposals;
}

/** The ones that will actually be written. The ONLY route to a write. */
export function chosenLabels(proposals: readonly DenominationProposal[]): string[] {
  return proposals.filter((proposal) => proposal.chosen).map((proposal) => proposal.label);
}

/** Flip one tick. Returns a new array, because the caller holds a signal. */
export function toggleProposal(
  proposals: readonly DenominationProposal[],
  label: string
): DenominationProposal[] {
  return proposals.map((proposal) =>
    proposal.label === label ? { ...proposal, chosen: !proposal.chosen } : proposal
  );
}

/** Tick or untick everything at once. */
export function setAllProposals(
  proposals: readonly DenominationProposal[],
  chosen: boolean
): DenominationProposal[] {
  return proposals.map((proposal) => ({ ...proposal, chosen }));
}

/**
 * What the checkbox means, written out beside it.
 *
 * It says the request LEAVES THE MACHINE, in those words. "Look up
 * denominations" would describe the benefit and hide the cost, and this is
 * the application's only unsolicited outbound request -- the one thing a
 * user of an offline collection manager would want to be asked about.
 */
export function describeLookupConsent(source: string): string {
  return (
    `Ask ${source} what denominations this issuer struck. ` +
    `This sends the issuer name you typed over the internet. Nothing else leaves this machine.`
  );
}

/** The one-line status while the request is out. */
export function describeLookupInProgress(issuerName: string, source: string): string {
  return `Asking ${source} about ${issuerName}…`;
}

/**
 * What happened, in a sentence, with the manual route named at the end.
 *
 * NO ERROR WORDING ANYWHERE. A lookup that finds nothing is the expected
 * result for most ancients, and a machine with no internet is a supported
 * way to run this application.
 */
export function describeLookupOutcome(issuerName: string, result: DenominationLookupResult): string {
  const tail = `Add ${issuerName}’s denominations below.`;

  if (result.outcome === 'results' && result.proposals.length > 0) {
    const count = result.proposals.length;
    return (
      `${result.source} suggests ${count} denomination${count === 1 ? '' : 's'} for ${issuerName}. ` +
      `Untick anything that is wrong — nothing is saved until you confirm.`
    );
  }

  if (result.outcome === 'unavailable') {
    const why = result.reason ? ` (${result.reason})` : '';
    return `Could not reach ${result.source}${why}, so ${issuerName} has no denominations yet. ${tail}`;
  }

  return (
    `${result.source} had nothing for ${issuerName}. ` +
    `That is normal — its coverage of older and smaller issuers is thin. ${tail}`
  );
}

/**
 * What happened when the user declined the lookup.
 *
 * It says NOTHING WAS SENT, because that is the promise the checkbox made
 * and the user has no way to check it otherwise.
 */
export function describeLookupDeclined(issuerName: string): string {
  return (
    `Added ${issuerName}. The online lookup is switched off, so nothing left this machine ` +
    `and it has no denominations yet. Add ${issuerName}’s denominations below.`
  );
}

/**
 * The outcome of the write, INCLUDING ZERO.
 *
 * "how many were added and by what route" is the whole requirement, and
 * the zero case is the one that used to be silent.
 */
export function describeDenominationsAdded(
  issuerName: string,
  count: number,
  source: string
): string {
  const whole = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;

  if (whole === 0) {
    return `Added ${issuerName} with no denominations. Add them below.`;
  }

  return (
    `Added ${whole} denomination${whole === 1 ? '' : 's'} to ${issuerName}, from ${source}. ` +
    `Check them before you file a coin under one.`
  );
}
