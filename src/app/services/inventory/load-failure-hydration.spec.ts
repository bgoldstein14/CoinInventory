 /*
  * The start-up path end to end: ConnectionManager.hydrate() routes its failure
  * through describeLoadFailure, sets both signals, and tells the user the right
  * thing. Scenario: the backend returns 500 because the coin list couldn't be
  * serialised, though the database was fine; the app must not report a
  * database connection failure.
  */

import { describe, expect, it } from 'vitest';
import { throwError } from 'rxjs';
import { createTestInventoryService } from '../../testing/test-helpers';

/** The 500 the backend sends when the coin list can't be serialised. */
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

/** No backend at all. */
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

    // One failure, one wording: the older signal must match the new one.
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

    // Both are cleared, or the banner outlives the problem.
    expect(inv.loadFailure()).toBeNull();
    expect(inv.connectionError()).toBeNull();
  });
});
