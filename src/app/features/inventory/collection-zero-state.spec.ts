/*
 * THE RULE THESE TESTS ENFORCE
 *
 *   "No coins yet. Add one manually or import from a QIF/CSV file." may be
 *   said in EXACTLY ONE situation: the coin list has arrived AND it was
 *   empty. In every other situation the app does not know the collection is
 *   empty, so it does not get to say so — telling a user with a full
 *   collection they have none, and inviting them to import, duplicates
 *   everything they own.
 *
 * Same rule as `computeMeltValue` returning null rather than $0.00 — a
 * visible blank beats a silently wrong answer — extended from numbers to
 * status.
 */

import { describe, expect, it } from 'vitest';
import { collectionNotReadyNotice, collectionZeroState } from './collection-zero-state';

/** The grid before hydration has finished: nothing has arrived yet. */
const LOADING = { loaded: false, failed: false };
/** Hydration finished and the coins are in hand. */
const LOADED = { loaded: true, failed: false };
/** Phase 1 of hydration threw: we have no list and we know why. */
const FAILED = { loaded: false, failed: true };

describe('collectionZeroState — while the collection is still loading', () => {
  it('says it is loading, not that the collection is empty', () => {
    const state = collectionZeroState(LOADING, 0, 0);

    expect(state.kind).toBe('loading');
    expect(state.message).toBe('Loading your collection…');
  });

  it('DOES NOT invite an import — the harmful half of the original bug', () => {
    // A user who acts on that invitation while the coins are in flight ends
    // up importing them a second time.
    const state = collectionZeroState(LOADING, 0, 0);
    const spoken = `${state.message} ${state.hint ?? ''}`;

    expect(spoken).not.toMatch(/import/i);
    expect(spoken).not.toMatch(/no coins yet/i);
    expect(spoken).not.toMatch(/add one manually/i);
  });

  it('is still loading even when the app has not started connecting yet', () => {
    // There is a moment between the App being constructed and hydrate()
    // setting `connecting`. "We have not got your coins" is true throughout
    // it; "you have no coins" is not.
    expect(collectionZeroState({ loaded: false, failed: false }, 0, 0).kind).toBe('loading');
  });
});

describe('collectionZeroState — when loading failed', () => {
  it('says the collection could not be loaded, not that it is empty', () => {
    const state = collectionZeroState(FAILED, 0, 0);

    expect(state.kind).toBe('failed');
    expect(state.message).not.toMatch(/no coins yet/i);
    expect(`${state.message} ${state.hint ?? ''}`).not.toMatch(/import/i);
  });

  it('points at the banner rather than repeating the error', () => {
    // The banner at the top of the window carries the real message and the
    // Retry button; two different wordings of the same failure on one screen
    // is how a user ends up unsure whether it is one problem or two.
    expect(collectionZeroState(FAILED, 0, 0).hint).toMatch(/top of the window/i);
  });
});

describe('collectionZeroState — when the collection really is empty', () => {
  it('gives the original invitation, which is correct here and only here', () => {
    const state = collectionZeroState(LOADED, 0, 0);

    expect(state.kind).toBe('empty');
    expect(state.message).toBe('No coins yet. Add one manually or import from a QIF/CSV file.');
  });
});

describe('collectionZeroState — when filters hid everything', () => {
  it('says so, and does not suggest the collection is empty', () => {
    const state = collectionZeroState(LOADED, 105, 0);

    expect(state.kind).toBe('filtered');
    expect(state.message).toBe('No coins match the current search and filters.');
    expect(state.message).not.toMatch(/no coins yet/i);
  });

  it('is chosen on the coin COUNT, not on the filter settings', () => {
    // The grid does not have to tell this module anything about filters:
    // "there are coins, none of them are showing" is the whole definition.
    expect(collectionZeroState(LOADED, 1, 0).kind).toBe('filtered');
  });
});

describe('collectionZeroState — when there is nothing to say', () => {
  it('reports no zero state at all while rows are on screen', () => {
    const state = collectionZeroState(LOADED, 105, 105);

    expect(state.kind).toBe('none');
    expect(state.message).toBe('');
  });

  it('says nothing even mid-load, if rows from a previous load are showing', () => {
    // A retry after a successful load: the old rows stay on screen and the
    // grid must not grow a "Loading…" row underneath them.
    expect(collectionZeroState(LOADING, 105, 105).kind).toBe('none');
  });
});

/*
 * The aggregate screens — Statistics and the Reports summary — have no
 * "filtered to nothing" case; they have a worse one. Computed over an empty
 * array, their hero figure reads "$0.00" and the Reports summary says the
 * collection holds 0 coins. That is the same lie as "No coins yet", told in
 * numbers — and on the Reports screen it sits one button from a document
 * that could go to an insurer.
 */
describe('collectionNotReadyNotice', () => {
  it('suppresses the figures while the collection is still loading', () => {
    expect(collectionNotReadyNotice(LOADING)).toBe('Loading your collection…');
  });

  it('suppresses them after a failed load, and says why', () => {
    const notice = collectionNotReadyNotice(FAILED);

    expect(notice).toBeTruthy();
    expect(notice).toMatch(/could not be loaded/i);
    expect(notice).toMatch(/top of the window/i);
  });

  it('gets out of the way once the coins are in hand', () => {
    // Including a genuinely empty collection: $0.00 across an empty
    // collection is a true statement, and the screens may make it.
    expect(collectionNotReadyNotice(LOADED)).toBeNull();
  });
});
