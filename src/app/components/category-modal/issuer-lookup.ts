/*
 * Messages and proposal handling for the online denomination lookup.
 *
 * - Nothing is written without the user ticking it: `chosenLabels` is the only
 *   route to a write. Proposals start ticked; the Add button shows the count.
 * - No results or no network is a normal outcome, so messages carry no error
 *   wording and point to adding denominations manually.
 * - Every outcome states how many denominations were added, including zero.
 */

import {
  DenominationLookupOutcome,
  DenominationLookupResult,
} from '../../types/reference-data.model';

// Re-exported for convenience; declared in types/ because ApiService uses them.
export type { DenominationLookupOutcome, DenominationLookupResult };

/**
 * The source name shown in the consent label before any request. The
 * server's `source` in the response replaces it afterwards.
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
 * Candidates the issuer does not already have (case-insensitive, de-duplicated),
 * all ticked. Duplicate labels under one issuer would make coin matching ambiguous.
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

/** The ticked labels: the only route from a proposal to a write. */
export function chosenLabels(proposals: readonly DenominationProposal[]): string[] {
  return proposals.filter((proposal) => proposal.chosen).map((proposal) => proposal.label);
}

/** Flip one tick. Returns a new array for signal state. */
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
 * The consent checkbox label. States plainly that the request leaves the
 * machine, since it is the app's only outbound request of this kind.
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
 * What happened, in a sentence, ending with the manual route. No error
 * wording: no results or no network are normal outcomes.
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

/** The message when the user declined the lookup: confirms nothing was sent. */
export function describeLookupDeclined(issuerName: string): string {
  return (
    `Added ${issuerName}. The online lookup is switched off, so nothing left this machine ` +
    `and it has no denominations yet. Add ${issuerName}’s denominations below.`
  );
}

/** The outcome of the write, including zero. */
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
