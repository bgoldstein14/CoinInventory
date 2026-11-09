 /*
 * load-failure-hydration.spec.ts — the start-up path, end to end.
 *
 * load-failure.spec.ts pins the DECISION. This file pins the PATH: that
 * ConnectionManager.hydrate() actually routes its one failure branch through
 * it, writes both signals, and tells the user the right thing.
 *
 * The exact scenario is the owner's, 2026-11-08: the backend returns 500
 * because `res.json()` could not build the response for 105 coins. The
 * database was never in any trouble. What the app said was:
 *
 *     [ERROR] [frontend] Failed to connect to database | 500 Internal Server Error
 *
 * and that line is what this file exists to make impossible.
  */

import { describe, expect, it } from 'vitest';
import { throwError } from 'rxjs';
import { createTestInventoryService } from '../../testing/test-helpers';

/** The 500 the backend now sends when the coin list cannot be serialised. */
const DELIVERY_FAILURE = {
  status: 500,
  statusText: 'Internal Server Error',
  error: {
    error:
      'The coin list could not be sent to the screen. Your data is safe and the database is working — the problem is in sending it, not reading it.',
    stage: 'delivery',
    detail: 'RangeError: Invalid string length in GET /api/coins',
  },
};

/** A backend that is not there at all. */
const NO_SERVER = { status: 0, statusText: 'Unknown Error', error: null };

async function hydrateWith(failure: unknown) {
  const { inv, mockApiService, mockNotification } = createTestInventoryService();
  (mockApiService.getCoins as any).mockReturnValue(throwError(() => failure));

  await expect(inv.hydrate()).rejects.toThrow();

  return { inv, mockNotification };
}

describe('hydration failing after the data was read', () => {
  it('does not announce a database connection failure', async () => {
    const { inv } = await hydrateWith(DELIVERY_FAILURE);

    expect(inv.connectionError()).not.toMatch(/cannot connect/i);
    expect(inv.loadFailure()?.title).not.toMatch(/database unavailable/i);
  });

  it('records the delivery stage and the reassurance on the signal', async () => {
    const { inv } = await hydrateWith(DELIVERY_FAILURE);

    expect(inv.loadFailure()?.stage).toBe('delivery');
    expect(inv.loadFailure()?.dataSafe).toBe(true);
    expect(inv.loadFailure()?.message).toMatch(/your data is safe/i);
    expect(inv.loadFailure()?.detail).toContain('RangeError');
  });

  it('keeps connectionError in step, so nothing that reads it sees a stale lie', async () => {
    const { inv } = await hydrateWith(DELIVERY_FAILURE);

    // One failure, one wording. The old signal is kept only for the readers
    // that already existed; it must never disagree with the new one.
    expect(inv.connectionError()).toBe(inv.loadFailure()?.message);
  });

  it('shows the user the honest sentence rather than the old blanket toast', async () => {
    const { mockNotification } = await hydrateWith(DELIVERY_FAILURE);

    const shown = (mockNotification.showError as any).mock.calls.map((c: unknown[]) => c[0]).join(' ');
    expect(shown).toMatch(/could not be sent to the screen/i);
    expect(shown).not.toMatch(/cannot connect to database/i);
  });
});

describe('hydration failing because nothing answered', () => {
  it('still says the database is unavailable, and promises nothing', async () => {
    const { inv } = await hydrateWith(NO_SERVER);

    expect(inv.loadFailure()?.stage).toBe('connection');
    expect(inv.loadFailure()?.title).toMatch(/database unavailable/i);
    expect(inv.loadFailure()?.dataSafe).toBe(false);
    expect(inv.connectionError()).not.toMatch(/your data is safe/i);
  });
});

describe('a successful hydration leaves no trace of a failure', () => {
  it('clears both signals together', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    (mockApiService.getCoins as any).mockReturnValue(throwError(() => DELIVERY_FAILURE));
    await expect(inv.hydrate()).rejects.toThrow();
    expect(inv.loadFailure()).not.toBeNull();

    const { of } = await import('rxjs');
    (mockApiService.getCoins as any).mockReturnValue(of([]));
    await inv.hydrate();

    // Both, or the banner outlives the problem it describes.
    expect(inv.loadFailure()).toBeNull();
    expect(inv.connectionError()).toBeNull();
  });
});
