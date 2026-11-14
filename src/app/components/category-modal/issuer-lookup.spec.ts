/*
 * issuer-lookup.spec.ts — the proposal list, and every sentence the user
 * can be shown about a lookup.
 *
 * The wordings are tested, not just the branching, because the WHOLE
 * point of this feature is that the user is told what happened. "Added
 * Burma" with no mention of denominations is the bug it replaced, so a
 * message that quietly stopped naming a count would be a regression that
 * nothing else in the suite could see.
 */

import { describe, expect, it } from 'vitest';

import {
  DenominationLookupResult,
  LOOKUP_SOURCE,
  chosenLabels,
  describeDenominationsAdded,
  describeLookupConsent,
  describeLookupDeclined,
  describeLookupInProgress,
  describeLookupOutcome,
  setAllProposals,
  toProposals,
  toggleProposal,
} from './issuer-lookup';

function result(over: Partial<DenominationLookupResult> = {}): DenominationLookupResult {
  return { outcome: 'results', source: 'Wikidata', proposals: [], reason: null, ...over };
}

describe('toProposals', () => {
  it('offers every candidate, ticked', () => {
    // TICKED, and the confirmation is a button carrying the count.
    // Starting unticked would make the careless path "add nothing", which
    // is the old bug with extra clicks.
    expect(toProposals(['kyat', 'pya'])).toEqual([
      { label: 'kyat', chosen: true },
      { label: 'pya', chosen: true },
    ]);
  });

  it('does not offer a label the issuer already has', () => {
    // Two rows with one label under one issuer make every coin carrying
    // that text resolve as AMBIGUOUS, and ambiguous resolves to NULL. The
    // duplicate would delete a denomination rather than add one.
    expect(toProposals(['kyat', 'pya'], ['Kyat'])).toEqual([{ label: 'pya', chosen: true }]);
  });

  it('does not offer the same label twice in one list', () => {
    expect(toProposals(['Kyat', 'kyat'])).toEqual([{ label: 'Kyat', chosen: true }]);
  });

  it('drops blanks and trims', () => {
    expect(toProposals([' kyat ', '', '   '])).toEqual([{ label: 'kyat', chosen: true }]);
  });

  it('is empty for an empty answer, which is the common case', () => {
    expect(toProposals([])).toEqual([]);
  });
});

describe('chosenLabels', () => {
  it('returns only what is ticked', () => {
    expect(
      chosenLabels([
        { label: 'kyat', chosen: true },
        { label: 'leprosy colony money', chosen: false },
        { label: 'pya', chosen: true },
      ])
    ).toEqual(['kyat', 'pya']);
  });

  it('returns nothing when nothing is ticked, so nothing can be written', () => {
    expect(chosenLabels([{ label: 'kyat', chosen: false }])).toEqual([]);
  });
});

describe('toggleProposal and setAllProposals', () => {
  it('flips one and leaves the rest', () => {
    const before = toProposals(['kyat', 'pya']);
    const after = toggleProposal(before, 'kyat');
    expect(after).toEqual([
      { label: 'kyat', chosen: false },
      { label: 'pya', chosen: true },
    ]);
    // A new array: the caller holds a signal and mutation would not notify.
    expect(after).not.toBe(before);
    expect(before[0].chosen).toBe(true);
  });

  it('ignores a label that is not in the list', () => {
    const before = toProposals(['kyat']);
    expect(toggleProposal(before, 'nope')).toEqual(before);
  });

  it('ticks or unticks everything', () => {
    const all = toProposals(['kyat', 'pya']);
    expect(chosenLabels(setAllProposals(all, false))).toEqual([]);
    expect(chosenLabels(setAllProposals(setAllProposals(all, false), true))).toEqual(['kyat', 'pya']);
  });
});

describe('describeLookupConsent', () => {
  it('says the request leaves the machine, in those words', () => {
    // NOT "look up denominations", which would describe the benefit and
    // hide the cost. This is the app's only unsolicited outbound request.
    const label = describeLookupConsent(LOOKUP_SOURCE);
    expect(label).toContain('Wikidata');
    expect(label.toLowerCase()).toContain('over the internet');
    expect(label).toContain('issuer name you typed');
  });

  it('promises that nothing else goes with it', () => {
    expect(describeLookupConsent('Wikidata')).toContain('Nothing else leaves this machine');
  });
});

describe('describeLookupInProgress', () => {
  it('names the issuer and the source', () => {
    const message = describeLookupInProgress('Burma', 'Wikidata');
    expect(message).toContain('Burma');
    expect(message).toContain('Wikidata');
  });
});

describe('describeLookupOutcome', () => {
  it('counts what came back and says nothing is saved yet', () => {
    const message = describeLookupOutcome('Burma', result({ proposals: ['kyat', 'pya'] }));
    expect(message).toContain('2 denominations');
    expect(message).toContain('Burma');
    expect(message).toContain('Wikidata');
    expect(message.toLowerCase()).toContain('until you confirm');
  });

  it('says "1 denomination", not "1 denominations"', () => {
    expect(describeLookupOutcome('Parthia', result({ proposals: ['Drachm'] }))).toContain('1 denomination ');
  });

  it('treats an empty answer as normal and points at the manual route', () => {
    // *** THE COMMONEST OUTCOME FOR AN ANCIENT ISSUER. *** Measured
    // against the live endpoint, Athens returned nothing at all. This
    // message must not read like a failure.
    const message = describeLookupOutcome('Athens', result({ outcome: 'none' }));
    expect(message).toContain('had nothing for Athens');
    expect(message).toContain('That is normal');
    expect(message).toContain('Add Athens');
    expect(message.toLowerCase()).not.toContain('error');
    expect(message.toLowerCase()).not.toContain('failed');
  });

  it('says it could not ask, with the reason, and still points at the manual route', () => {
    const message = describeLookupOutcome(
      'Burma',
      result({ outcome: 'unavailable', reason: 'no connection' })
    );
    expect(message).toContain('Could not reach Wikidata');
    expect(message).toContain('no connection');
    expect(message).toContain('Add Burma');
    expect(message.toLowerCase()).not.toContain('error');
  });

  it('copes with an unavailable answer that carries no reason', () => {
    const message = describeLookupOutcome('Burma', result({ outcome: 'unavailable', reason: null }));
    expect(message).toContain('Could not reach Wikidata');
    expect(message).not.toContain('()');
  });

  it('treats "results" with an empty list as the no-results wording', () => {
    // Defensive: a server that said 'results' and sent none would
    // otherwise produce "suggests 0 denominations".
    expect(describeLookupOutcome('Athens', result({ outcome: 'results', proposals: [] }))).toContain(
      'had nothing for Athens'
    );
  });

  it('never says a number it did not count', () => {
    const message = describeLookupOutcome('Burma', result({ proposals: ['a', 'b', 'c'] }));
    expect(message).toContain('3 denominations');
    expect(message).not.toContain('0 ');
  });
});

describe('describeLookupDeclined', () => {
  it('states that NOTHING was sent, which is the promise the checkbox made', () => {
    // The user cannot verify this any other way, so the app has to say it.
    const message = describeLookupDeclined('Burma');
    expect(message).toContain('nothing left this machine');
    expect(message).toContain('switched off');
    expect(message).toContain('Added Burma');
    expect(message).toContain('Add Burma');
  });
});

describe('describeDenominationsAdded', () => {
  it('says how many and by what route', () => {
    const message = describeDenominationsAdded('Burma', 4, 'Wikidata');
    expect(message).toContain('4 denominations');
    expect(message).toContain('Burma');
    expect(message).toContain('from Wikidata');
  });

  it('gets the singular right', () => {
    expect(describeDenominationsAdded('Parthia', 1, 'Wikidata')).toContain('1 denomination to Parthia');
  });

  it('STATES ZERO rather than going quiet, which was the original bug', () => {
    const message = describeDenominationsAdded('Athens', 0, 'Wikidata');
    expect(message).toContain('no denominations');
    expect(message).toContain('Add them below');
  });

  it('treats a nonsense count as zero instead of printing it', () => {
    for (const count of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(describeDenominationsAdded('Athens', count, 'Wikidata')).toContain('no denominations');
    }
  });

  it('asks the user to check them, because the source is not authoritative', () => {
    // Wikidata's answer for Japan included 'Coin (reproduction)' and
    // 'leprosy colony money'. Ticking a box is a lower bar than a
    // numismatist's judgement and the wording should not pretend otherwise.
    expect(describeDenominationsAdded('Japan', 9, 'Wikidata')).toContain('Check them');
  });
});
