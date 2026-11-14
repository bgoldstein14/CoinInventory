/*
 * "A coin you are still typing is not an error."
 *
 * The owner added a coin, typed a Year, and got a red toast telling him it
 * could not be saved. `canCreateCoin` has since stopped the doomed POST, so
 * the toast no longer fires; what these tests pin down is the PRESENTATION
 * that was wrong anyway — the row and the panel now say what to type next,
 * quietly, instead of leaving the whole message in a tooltip.
 *
 * The phrasing rule being tested throughout: SAY WHAT TO DO, NOT WHAT IS
 * MISSING.
 */
import { describe, expect, it } from 'vitest';
import { canCreateCoin } from './coin-create-requirements';
import { describeDraftRow } from './draft-row-status';

describe('the state the owner was actually in', () => {
  const yearOnly = { year: '1921' };

  it('is not an error — nothing here reads as a failure', () => {
    const status = describeDraftRow(yearOnly);
    expect(status.failed).toBe(false);
    expect(status.summary.toLowerCase()).not.toContain('error');
    expect(status.summary.toLowerCase()).not.toContain('could not');
    expect(status.summary.toLowerCase()).not.toContain('failed');
  });

  it('says what to type next rather than that there is not enough data', () => {
    const status = describeDraftRow(yearOnly);
    expect(status.summary).toContain('Denomination');
    expect(status.summary.toLowerCase()).not.toContain('not enough data');
  });

  it('carries a visible phrase, not only a sentence for a tooltip', () => {
    // The chip's whole message used to live in a `title`. A tooltip needs a
    // mouse, a pause and the guess that hovering would say anything, so it
    // cannot be the primary signal.
    expect(describeDraftRow(yearOnly).chip).toBe('Needs Denomination');
  });
});

describe('a year and a coin type but no denomination', () => {
  // Passes the shared 2-of-3 rule and is still refused by POST /api/coins,
  // which requires a denomination outright. The row looked identical to a
  // saved one before any of this existed.
  const coin = { year: '1921', coinType: 'Morgan' };

  it('is genuinely unsaveable', () => {
    expect(canCreateCoin(coin)).toBe(false);
  });

  it('asks for the denomination, and nothing else', () => {
    const status = describeDraftRow(coin);
    expect(status.chip).toBe('Needs Denomination');
    expect(status.summary).toBe('Needs a Denomination before it can be saved.');
    expect(status.needsInput).toBe(true);
    expect(status.failed).toBe(false);
  });
});

describe('a completely empty new row', () => {
  const coin = {};

  it('names the denomination first, because the server refuses without one', () => {
    expect(describeDraftRow(coin).chip).toBe('Needs Denomination');
  });

  it('still mentions that one more detail is wanted after it', () => {
    const summary = describeDraftRow(coin).summary;
    expect(summary).toContain('Denomination');
    expect(summary).toContain('Year');
    expect(summary).toContain('Coin Type');
    expect(summary.endsWith('before it can be saved.')).toBe(true);
  });
});

describe('a denomination on its own', () => {
  const coin = { denomination: 'Dollar' };

  it('is short of the 2-of-3 rule, and says which field would settle it', () => {
    expect(canCreateCoin(coin)).toBe(false);
    const status = describeDraftRow(coin);
    expect(status.chip).toBe('Needs Year or Coin Type');
    expect(status.summary).toBe('Needs a Year or a Coin Type before it can be saved.');
  });
});

describe('a denomination the server accepts but the completeness rule does not', () => {
  // "Other" and "Unknown" are placeholders to `isCoinDetailPresent` and
  // perfectly acceptable to the server's `if (!body.denomination)`. The gate
  // is both rules, so the row is still a draft and must still say something
  // useful.
  it('asks for the two details the 2-of-3 rule is short of', () => {
    const status = describeDraftRow({ denomination: 'Unknown' });
    expect(canCreateCoin({ denomination: 'Unknown' })).toBe(false);
    expect(status.chip).toBe('Needs 2 details');
    expect(status.summary).toContain('two of');
    expect(status.needsInput).toBe(true);
  });

  it('asks for the one remaining detail once a year is typed', () => {
    const status = describeDraftRow({ denomination: 'Other', year: '1921' });
    expect(status.chip).toBe('Needs Coin Type or Denomination');
    expect(status.failed).toBe(false);
  });
});

describe('a row that has everything it needs', () => {
  const coin = { year: '1921', coinType: 'Morgan', denomination: 'Dollar' };

  it('is on its way, and asks the user for nothing', () => {
    expect(canCreateCoin(coin)).toBe(true);
    const status = describeDraftRow(coin);
    expect(status.chip).toBe('');
    expect(status.needsInput).toBe(false);
    expect(status.failed).toBe(false);
  });
});

describe('a save that was attempted and REFUSED', () => {
  // The one case that is a genuine error. The red toast stays (see
  // CoinEditor.onDraftCreateFailed); this is how the row keeps saying so
  // after the toast has gone.
  const coin = { year: '1921', coinType: 'Morgan', denomination: 'Dollar' };
  const refusal = 'Not saved yet — the last attempt failed: 500 Server Error. Edit this row to retry.';

  it('is marked as a failure, unlike every state above', () => {
    const status = describeDraftRow(coin, { lastAttempt: refusal });
    expect(status.failed).toBe(true);
    expect(status.chip).toBe('Save failed');
    expect(status.summary).toBe(refusal);
  });

  it('is NOT reported while the user still has something to type', () => {
    // A half-typed row must never be dressed up as a failed save, however
    // recently one failed.
    const status = describeDraftRow({ year: '1921' }, { lastAttempt: refusal });
    expect(status.failed).toBe(false);
    expect(status.chip).toBe('Needs Denomination');
  });

  it('ignores an empty or whitespace-only hint', () => {
    expect(describeDraftRow(coin, { lastAttempt: '' }).failed).toBe(false);
    expect(describeDraftRow(coin, { lastAttempt: '   ' }).failed).toBe(false);
  });
});

describe('every state is phrased as an instruction, never as a complaint', () => {
  const states = [
    {},
    { year: '1921' },
    { coinType: 'Morgan' },
    { denomination: 'Dollar' },
    { year: '1921', coinType: 'Morgan' },
    { denomination: 'Other' },
    { denomination: 'Other', year: '1921' }
  ];

  it('always ends by saying what it unlocks', () => {
    for (const coin of states) {
      const status = describeDraftRow(coin);
      expect(status.summary, JSON.stringify(coin)).toContain('before it can be saved');
    }
  });

  it('never uses the language of failure for a row still being typed', () => {
    for (const coin of states) {
      const text = `${describeDraftRow(coin).chip} ${describeDraftRow(coin).summary}`.toLowerCase();
      expect(text, JSON.stringify(coin)).not.toContain('error');
      expect(text, JSON.stringify(coin)).not.toContain('invalid');
      expect(text, JSON.stringify(coin)).not.toContain('failed');
    }
  });

  it('always leaves something visible on the row', () => {
    for (const coin of states) {
      expect(describeDraftRow(coin).chip.length, JSON.stringify(coin)).toBeGreaterThan(0);
    }
  });
});
