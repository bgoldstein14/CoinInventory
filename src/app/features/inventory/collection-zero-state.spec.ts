/*
 * "No coins yet" may only be shown once the coin list has arrived and is empty.
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
    // Importing while coins are in flight would duplicate them.
    const state = collectionZeroState(LOADING, 0, 0);
    const spoken = `${state.message} ${state.hint ?? ''}`;

    expect(spoken).not.toMatch(/import/i);
    expect(spoken).not.toMatch(/no coins yet/i);
    expect(spoken).not.toMatch(/add one manually/i);
  });

  it('is still loading even when the app has not started connecting yet', () => {
    // The moment between App construction and hydrate() starting.
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
    // The banner carries the real message and the Retry button.
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
    // A retry after a successful load keeps the old rows on screen.
    expect(collectionZeroState(LOADING, 105, 105).kind).toBe('none');
  });
});

/* Statistics and Reports would show $0.00 totals before the coins arrive. */
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
    // Including a genuinely empty collection, where $0.00 is true.
    expect(collectionNotReadyNotice(LOADED)).toBeNull();
  });
});
