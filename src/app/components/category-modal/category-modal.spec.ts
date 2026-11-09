/*
 * category-modal.spec.ts — the reference-data maintenance screen.
 *
 * There is no jsdom in this project's frontend suite, so nothing here can
 * assert on rendering. That is the reason the screen's real decisions —
 * grouping, filtering, counting, and what Remove does — live in the pure
 * modules beside this file and are tested there, hard.
 *
 * What is left for the component, and what is tested below, is the WIRING:
 * which pane is showing, what the draft inputs are allowed to produce, which
 * service call a button makes, and whether a cancelled confirmation really
 * stops the write.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { NotificationService } from '../../services/notification.service';
import { CoinRecord, Denomination } from '../../types/coin.model';
import { IssuerRecord } from '../../types/reference-data.model';
import { CategoryModal } from './category-modal';
import { createTestInventoryService } from '../../testing/test-helpers';

const MEXICO: IssuerRecord = {
  issuerId: 1,
  name: 'Mexico',
  isoCode: 'MX',
  kind: 'modern',
  validFrom: 1821,
  validTo: null,
  sortOrder: 10,
  denominationCount: 2,
  coinCount: 3,
  isActive: true,
};

const BURMA: IssuerRecord = {
  issuerId: 2,
  name: 'Burma',
  isoCode: 'MM',
  kind: 'modern',
  validFrom: null,
  validTo: null,
  sortOrder: 20,
  denominationCount: 0,
  coinCount: 0,
  isActive: true,
};

const DENOMINATIONS: Denomination[] = [
  { denominationId: 103, label: '8 Reales', country: 'MX', issuerId: 1, sortOrder: 1, isActive: true },
  { denominationId: 104, label: '1 Peso', country: 'MX', issuerId: 1, sortOrder: 2, isActive: true },
];

/**
 * Let the constructor's two fetches settle.
 *
 * The dialog loads its issuers and its counts in the constructor, which
 * cannot be awaited. Without this every assertion about loaded data would
 * run against the empty initial state and pass for the wrong reason — the
 * classic vacuous async test.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function createModal(options: { issuers?: IssuerRecord[] } = {}) {
  const { inv, mockApiService, mockNotification, injector: invInjector } = createTestInventoryService();
  void invInjector;

  const api = mockApiService as unknown as Record<string, ReturnType<typeof vi.fn>>;
  api['getIssuers'] = vi.fn(() => of(options.issuers ?? [MEXICO, BURMA]));
  api['getReferenceUsage'] = vi.fn(() =>
    of({
      categories: { Gold: 5 },
      coinSets: { 'Morgan Set': 2 },
      denominations: { '103': 3 },
      mintMarks: { D: 11 },
      catalogs: { '4': 6 },
    })
  );
  api['createIssuer'] = vi.fn((issuer: Record<string, unknown>) =>
    of({ ...BURMA, ...issuer, issuerId: 99, denominationCount: 0, coinCount: 0 })
  );
  api['updateIssuer'] = vi.fn(() => of(MEXICO));
  api['deleteIssuer'] = vi.fn(() => of(undefined));

  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ApiService, useValue: mockApiService },
      { provide: NotificationService, useValue: mockNotification },
    ],
  });

  const modal = runInInjectionContext(injector, () => new CategoryModal());
  await flush();
  return { modal, inv, api, notification: mockNotification as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

/** Force confirm() to a known answer. Node has no window.confirm at all. */
function answerConfirm(answer: boolean): void {
  (globalThis as unknown as { confirm: (message: string) => boolean }).confirm = () => answer;
}

/** What the last confirm() was asked. */
function captureConfirm(answer: boolean): { prompts: string[] } {
  const prompts: string[] = [];
  (globalThis as unknown as { confirm: (message: string) => boolean }).confirm = (message: string) => {
    prompts.push(message);
    return answer;
  };
  return { prompts };
}

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

afterEach(() => {
  delete (globalThis as unknown as { confirm?: unknown }).confirm;
});

/* ----- The pane structure ----- */

describe('CategoryModal — panes', () => {
  it('opens on the default section', async () => {
    const { modal } = await createModal();
    expect(modal['activeSection']()).toBe('categories');
  });

  it('switches panes', async () => {
    const { modal } = await createModal();
    modal.selectSection('denominations');
    expect(modal['activeSection']()).toBe('denominations');
  });

  it('ignores a section that does not exist instead of blanking the body', async () => {
    const { modal } = await createModal();
    modal.selectSection('denominations');
    modal.selectSection('nonsense');
    expect(modal['activeSection']()).toBe('categories');
  });

  it('loads the issuers and the in-use counts when it is created', async () => {
    // The dialog is created when it is opened, so construction IS opening.
    // Loading at startup instead would make every session pay for issuers
    // and five GROUP BYs that most of them never look at.
    const { modal, api } = await createModal();
    expect(api['getIssuers']).toHaveBeenCalledTimes(1);
    expect(api['getReferenceUsage']).toHaveBeenCalledTimes(1);
    expect(modal['issuers']()).toHaveLength(2);
  });

  it('still opens when the counts cannot be fetched', async () => {
    // A failed count is a missing badge, not a broken dialog. Everything
    // else on this screen works without it, and refusing to open would make
    // a cosmetic failure block the only way to fix the data.
    const { inv, mockApiService, mockNotification } = createTestInventoryService();
    const api = mockApiService as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api['getIssuers'] = vi.fn(() => of([MEXICO]));
    api['getReferenceUsage'] = vi.fn(() => throwError(() => new Error('offline')));

    const injector = Injector.create({
      providers: [
        { provide: InventoryService, useValue: inv },
        { provide: ApiService, useValue: mockApiService },
        { provide: NotificationService, useValue: mockNotification },
      ],
    });

    const modal = runInInjectionContext(injector, () => new CategoryModal());
    await flush();

    // The issuer load is what proves the constructor got past the failure
    // rather than this assertion passing on the untouched initial value.
    expect(modal['issuers']()).toHaveLength(1);
    expect(modal.categoryUsage('Gold')).toBe(0);
    expect(modal.denominationUsage(103)).toBe(0);
  });

  it('reports a failed issuer load without refusing to open', async () => {
    const { inv, mockApiService, mockNotification } = createTestInventoryService();
    const api = mockApiService as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api['getIssuers'] = vi.fn(() => throwError(() => new Error('offline')));
    api['getReferenceUsage'] = vi.fn(() =>
      of({ categories: { Gold: 5 }, coinSets: {}, denominations: {}, mintMarks: {}, catalogs: {} })
    );

    const injector = Injector.create({
      providers: [
        { provide: InventoryService, useValue: inv },
        { provide: ApiService, useValue: mockApiService },
        { provide: NotificationService, useValue: mockNotification },
      ],
    });

    const modal = runInInjectionContext(injector, () => new CategoryModal());
    await flush();

    expect(modal['issuers']()).toEqual([]);
    expect(modal.categoryUsage('Gold')).toBe(5);
    expect(mockNotification.showError).toHaveBeenCalled();
  });
});

/* ----- In-use counts ----- */

describe('CategoryModal — in-use counts', () => {
  it('reads the count for each kind of entry', async () => {
    const { modal } = await createModal();
    expect(modal.categoryUsage('Gold')).toBe(5);
    expect(modal.coinSetUsage('Morgan Set')).toBe(2);
    expect(modal.denominationUsage(103)).toBe(3);
    expect(modal.mintMarkUsage('D')).toBe(11);
    expect(modal.catalogUsage(4)).toBe(6);
  });

  it('answers zero for anything nobody is using', async () => {
    const { modal } = await createModal();
    expect(modal.categoryUsage('Platinum')).toBe(0);
    expect(modal.denominationUsage(999)).toBe(0);
  });
});

/* ----- Denominations: grouping, search and adding ----- */

describe('CategoryModal — denominations', () => {
  it('groups what the inventory holds under the issuers it loaded', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    const groups = modal['denominationGroups']();
    expect(groups.map((group) => group.heading)).toEqual(['Mexico', 'Burma']);
    expect(groups[0].denominations.map((d) => d.label)).toEqual(['8 Reales', '1 Peso']);
  });

  it('feeds the in-use counts into the grouping, so the heading total is real', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    expect(modal['denominationGroups']()[0].inUseTotal).toBe(3);
  });

  it('filters as the search box changes', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    modal['denominationSearch'].set('reales');
    const groups = modal['denominationGroups']();
    expect(groups).toHaveLength(1);
    expect(groups[0].denominations.map((d) => d.label)).toEqual(['8 Reales']);
  });

  it('refuses to add a denomination with no issuer chosen', async () => {
    // Adding a denomination requires choosing an issuer. Letting it through
    // would file the row under "No issuer yet", effectively losing it.
    const { modal, inv } = await createModal();
    const addDenomination = vi.spyOn(inv, 'addDenomination');

    modal['newDenominationLabel'].set('Kyat');
    modal['newDenominationIssuerId'].set(null);
    await modal.addDenominationFromDraft();

    expect(addDenomination).not.toHaveBeenCalled();
    expect(modal['denominationError']()).toContain('issuer');
  });

  it('refuses a blank label', async () => {
    const { modal, inv } = await createModal();
    const addDenomination = vi.spyOn(inv, 'addDenomination');

    modal['newDenominationLabel'].set('   ');
    modal['newDenominationIssuerId'].set(2);
    await modal.addDenominationFromDraft();

    expect(addDenomination).not.toHaveBeenCalled();
  });

  it('sends the issuer and a sort order past the end of the list', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    const addDenomination = vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);

    modal['newDenominationLabel'].set('  Kyat  ');
    modal['newDenominationIssuerId'].set(2);
    await modal.addDenominationFromDraft();

    expect(addDenomination).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Kyat', issuerId: 2, isActive: true })
    );
    expect(addDenomination.mock.calls[0][0].sortOrder).toBeGreaterThan(2);
  });

  it('clears the label but KEEPS the issuer after a successful add', async () => {
    // Adding denominations is a batch job — six in a row under one issuer.
    // Resetting the issuer each time would make them re-pick it every time,
    // and picking the wrong one is silent.
    const { modal, inv } = await createModal();
    vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);

    modal['newDenominationIssuerId'].set(2);
    modal['newDenominationLabel'].set('Kyat');
    await modal.addDenominationFromDraft();

    expect(modal['newDenominationLabel']()).toBe('');
    expect(modal['newDenominationIssuerId']()).toBe(2);
  });
});

/* ----- Removal ----- */

describe('CategoryModal — removing a denomination', () => {
  it('states the coin count in the confirmation', async () => {
    const { modal } = await createModal();
    const { prompts } = captureConfirm(false);

    void modal.removeDenomination({ denominationId: 103, label: '8 Reales' });
    expect(prompts[0]).toContain('3 coins');
    expect(prompts[0]).toContain('8 Reales');
  });

  it('does NOT delete when the confirmation is declined', async () => {
    const { modal, inv } = await createModal();
    const remove = vi.spyOn(inv, 'removeDenomination').mockResolvedValue(undefined);
    answerConfirm(false);

    await modal.removeDenomination({ denominationId: 103, label: '8 Reales' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes when it is accepted', async () => {
    const { modal, inv } = await createModal();
    const remove = vi.spyOn(inv, 'removeDenomination').mockResolvedValue(undefined);
    answerConfirm(true);

    await modal.removeDenomination({ denominationId: 103, label: '8 Reales' });
    expect(remove).toHaveBeenCalledWith(103);
  });

  it('re-reads the counts afterwards, because they have just changed', async () => {
    // Three coins stopped using it one line ago. Leaving the old number on
    // screen would make the next decision on this dialog a wrong one.
    const { modal, inv, api } = await createModal();
    vi.spyOn(inv, 'removeDenomination').mockResolvedValue(undefined);
    answerConfirm(true);

    await modal.removeDenomination({ denominationId: 103, label: '8 Reales' });
    expect(api['getReferenceUsage']).toHaveBeenCalledTimes(2);
  });

  it('asks before removing a category, naming it and its count', async () => {
    const { modal } = await createModal();
    const { prompts } = captureConfirm(false);

    modal.removeCategoryOption('Gold');
    expect(prompts[0]).toContain('Gold');
    expect(prompts[0]).toContain('5 coins');
  });

  it('leaves a declined category alone', async () => {
    const { modal, inv } = await createModal();
    inv.categoryOptions.set(['Gold']);
    answerConfirm(false);

    modal.removeCategoryOption('Gold');
    expect(inv.categoryOptions()).toEqual(['Gold']);
  });
});

/* ----- The text lists ----- */

describe('CategoryModal — categories and sets', () => {
  it('adds and removes a category option', async () => {
    const { modal, inv } = await createModal();
    answerConfirm(true);

    modal['newCategoryOption'].set('Ancient Coins');
    modal.addCategoryOptionFromDraft();
    expect(inv.categoryOptions()).toContain('Ancient Coins');

    modal.removeCategoryOption('Ancient Coins');
    expect(inv.categoryOptions()).not.toContain('Ancient Coins');
  });

  it('adds and removes coin sets', async () => {
    const { modal, inv } = await createModal();
    answerConfirm(true);

    modal['newCoinSet'].set('Mercury Dime Collection');
    modal.addCoinSetFromDraft();
    expect(inv.coinSets()).toContain('Mercury Dime Collection');

    modal.removeCoinSet('Mercury Dime Collection');
    expect(inv.coinSets()).not.toContain('Mercury Dime Collection');
  });

  it('does not add an empty category or coin set', async () => {
    const { modal, inv } = await createModal();

    modal['newCategoryOption'].set('   ');
    modal.addCategoryOptionFromDraft();
    expect(inv.categoryOptions()).toHaveLength(0);

    modal['newCoinSet'].set('   ');
    modal.addCoinSetFromDraft();
    expect(inv.coinSets()).toHaveLength(0);
  });
});

/* ----- Issuers: the manual add path ----- */

describe('CategoryModal — issuers', () => {
  it('reports what is wrong with a draft instead of posting it', async () => {
    const { modal, api } = await createModal();

    modal['issuerDraft'].set({ name: '', isoCode: '', kind: 'modern', validFrom: '', validTo: '' });
    await modal.addIssuerFromDraft();

    expect(api['createIssuer']).not.toHaveBeenCalled();
    expect(modal['issuerError']()).toContain('name');
  });

  it('catches a duplicate name before the unique constraint does', async () => {
    const { modal, api } = await createModal();

    modal['issuerDraft'].set({ name: ' mexico ', isoCode: '', kind: 'modern', validFrom: '', validTo: '' });
    await modal.addIssuerFromDraft();

    expect(api['createIssuer']).not.toHaveBeenCalled();
    expect(modal['issuerError']()).toContain('Mexico');
  });

  it('creates a valid issuer and adds it to the list', async () => {
    const { modal, api } = await createModal();

    modal['issuerDraft'].set({
      name: 'Parthia',
      isoCode: '',
      kind: 'ancient',
      validFrom: '-247',
      validTo: '224',
    });
    await modal.addIssuerFromDraft();

    expect(api['createIssuer']).toHaveBeenCalledWith({
      name: 'Parthia',
      isoCode: null,
      kind: 'ancient',
      validFrom: -247,
      validTo: 224,
    });
    expect(modal['issuers']().some((issuer) => issuer.issuerId === 99)).toBe(true);
    expect(modal['issuerError']()).toBe('');
  });

  it('empties the form after a successful add', async () => {
    const { modal } = await createModal();
    modal['issuerDraft'].set({ name: 'Parthia', isoCode: '', kind: 'ancient', validFrom: '', validTo: '' });
    await modal.addIssuerFromDraft();
    expect(modal['issuerDraft']().name).toBe('');
  });

  it('says so, and keeps the form, when the server refuses', async () => {
    // The user's typing is the only copy of it. Clearing the form on a
    // failure throws away work in the one situation where they need it.
    const { modal, api } = await createModal();
    api['createIssuer'] = vi.fn(() => throwError(() => new Error('409')));

    modal['issuerDraft'].set({ name: 'Parthia', isoCode: '', kind: 'ancient', validFrom: '', validTo: '' });
    await modal.addIssuerFromDraft();

    expect(modal['issuerError']().length).toBeGreaterThan(0);
    expect(modal['issuerDraft']().name).toBe('Parthia');
  });

  it('refuses to remove an issuer that still has denominations, without asking', async () => {
    // A refusal, not a warning — see describeIssuerRemoval for why this one
    // case differs from every other Remove on this screen.
    const { modal, api } = await createModal();
    const { prompts } = captureConfirm(true);

    await modal.removeIssuer(MEXICO);

    expect(api['deleteIssuer']).not.toHaveBeenCalled();
    expect(prompts).toEqual([]);
    expect(modal['issuerError']()).toContain('2 denominations');
  });

  it('removes an empty issuer once confirmed', async () => {
    const { modal, api } = await createModal();
    answerConfirm(true);

    await modal.removeIssuer(BURMA);

    expect(api['deleteIssuer']).toHaveBeenCalledWith(2);
    expect(modal['issuers']().some((issuer) => issuer.issuerId === 2)).toBe(false);
  });

  it('keeps an empty issuer when the confirmation is declined', async () => {
    const { modal, api } = await createModal();
    answerConfirm(false);

    await modal.removeIssuer(BURMA);
    expect(api['deleteIssuer']).not.toHaveBeenCalled();
  });
});

/* ----- The unlinked-coins pane -----
 * Classification and payloads are tested in
 * services/denominations/unlinked-denominations.spec.ts. What is tested here
 * is the WIRING: that the bulk button issues one PUT per coin in the group,
 * and that declining the confirmation issues none. */

/** A coin with everything blank except the overrides. */
function unlinkedCoin(overrides: Partial<CoinRecord>): CoinRecord {
  return {
    id: 'c1',
    denomination: '',
    denominationId: null,
    year: '',
    coinType: '',
    category: '',
    country: '',
    grade: '',
    certCompany: '',
    certNumber: '',
    variety: '',
    mintMark: '',
    composition: '',
    purchaseDate: '',
    purchasePrice: 0,
    currentValue: 0,
    notes: '',
    imagePaths: [],
    source: 'manual',
    ...overrides,
  };
}

/** Mexico's and Spain's 8 Reales, so the text is genuinely ambiguous. */
const REALES: Denomination[] = [
  { denominationId: 103, label: '8 Reales', country: 'MX', issuerId: 1, sortOrder: 1, isActive: true },
  { denominationId: 203, label: '8 Reales', country: 'ES', issuerId: 2, sortOrder: 2, isActive: true },
  { denominationId: 303, label: 'Quarter', country: 'US', issuerId: 3, sortOrder: 3, isActive: true },
];

describe('CategoryModal — unlinked coins', () => {
  async function withUnlinked() {
    const created = await createModal();
    created.inv.denominations.set(REALES);
    created.inv.inventory.set([
      unlinkedCoin({ id: 'u1', denomination: '8 Reales', country: 'United States' }),
      unlinkedCoin({ id: 'u2', denomination: '8 Reales', country: 'United States' }),
      unlinkedCoin({ id: 'ok', denomination: 'Quarter', denominationId: 303, country: 'United States' }),
    ]);
    return created;
  }

  it('groups the coins that need attention and counts them', async () => {
    const { modal } = await withUnlinked();

    expect(modal['unlinkedCensus']().unlinkedCount).toBe(2);
    expect(modal['unlinkedCensus']().groups).toHaveLength(1);
    expect(modal['unlinkedSummary']()).toBe('2 coins have no denomination linked, in 1 group.');
  });

  it('says so when there is nothing to fix', async () => {
    /* The zero state is a feature. A pane that renders nothing is
     * indistinguishable from a pane that is broken. */
    const { modal, inv } = await withUnlinked();
    inv.inventory.set([unlinkedCoin({ id: 'ok', denomination: 'Quarter', denominationId: 303 })]);

    expect(modal['unlinkedCensus']().unlinkedCount).toBe(0);
    expect(modal['unlinkedSummary']()).toBe('Every coin has a denomination. 1 coin checked.');
  });

  it('links every coin in the group with one press, after asking', async () => {
    const { modal, inv, api } = await withUnlinked();
    const { prompts } = captureConfirm(true);

    modal.selectUnlinkedGroup(modal['unlinkedCensus']().groups[0].key);
    modal['unlinkedChoiceId'].set(103);

    // What the plan INTENDS to write, before the editor's minimal diff gets
    // at it: the link and the text, and nothing else.
    expect(modal['unlinkedPlan']()!.candidates.map((candidate) => candidate.updates)).toEqual([
      { denominationId: 103, denomination: '8 Reales' },
      { denominationId: 103, denomination: '8 Reales' },
    ]);

    await modal.applyUnlinkedFix();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Link 2 coins to "8 Reales" (Mexico)?');

    const calls = (api['updateCoin'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((call) => call[0])).toEqual(['u1', 'u2']);
    for (const call of calls) {
      /* ONE PUT PER COIN, AND ONLY THE FIELDS THAT ACTUALLY CHANGED. The
       * text is absent from the body because these coins already SAY
       * '8 Reales' — `updateCoinNow` drops a field the server already
       * holds. That is the editor's minimal-diff rule doing its job, not
       * the text write going missing: the plan above carries it, and a
       * coin whose text differs from the label would send both. */
      expect(call[1]).toMatchObject({ denominationId: 103 });
      // The country is NOT in the payload: the opt-in box was not ticked.
      expect(call[1].country).toBeUndefined();
    }

    // And the screen agrees with the database afterwards.
    expect(inv.inventory().every((coin) => coin.denominationId === 103 || coin.id === 'ok')).toBe(true);
    expect(modal['unlinkedCensus']().unlinkedCount).toBe(0);
  });

  it('sends the chosen LABEL as the text when the coin says something else', async () => {
    /* The write rule, end to end and visible in the HTTP body. The coin says
     * '3CS'; the reference row is '3¢ Silver'; after a DELIBERATE action the
     * two fields must agree, so the label goes out as the text too. */
    const { modal, inv, api } = await withUnlinked();
    answerConfirm(true);
    inv.denominations.set([
      { denominationId: 777, label: '3¢ Silver', country: 'US', issuerId: 3, sortOrder: 1, isActive: true },
    ]);
    inv.inventory.set([unlinkedCoin({ id: 'tcs', denomination: '3CS', country: 'Mexico' })]);

    modal.selectUnlinkedGroup(modal['unlinkedCensus']().groups[0].key);
    modal['unlinkedChoiceId'].set(777);
    await modal.applyUnlinkedFix();

    const calls = (api['updateCoin'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ denominationId: 777, denomination: '3¢ Silver' });
  });

  it('writes nothing at all when the confirmation is declined', async () => {
    const { modal, api } = await withUnlinked();
    answerConfirm(false);

    modal.selectUnlinkedGroup(modal['unlinkedCensus']().groups[0].key);
    modal['unlinkedChoiceId'].set(103);
    await modal.applyUnlinkedFix();

    expect(api['updateCoin']).not.toHaveBeenCalled();
  });

  it('pre-selects the answer when there is only one, and only then', async () => {
    /* In a 'resolvable' group the app already knows the answer, so making
     * the user find it again in a thousand-odd rows is busywork. They still
     * press Link and still confirm a dialog naming the label, so nothing is
     * written that they did not choose.
     *
     * An AMBIGUOUS group is pre-selected with nothing, deliberately: the
     * whole reason it is in that group is that the app must not choose. */
    const { modal, inv } = await withUnlinked();
    inv.inventory.set([
      unlinkedCoin({ id: 'r', denomination: 'Quarter', country: 'United States' }),
      unlinkedCoin({ id: 'a', denomination: '8 Reales', country: 'United States' }),
    ]);

    const groups = modal['unlinkedCensus']().groups;
    expect(groups.map((group) => group.reason)).toEqual(['resolvable', 'ambiguous']);

    modal.selectUnlinkedGroup(groups[0].key);
    expect(modal['unlinkedChoiceId']()).toBe(303);

    modal.selectUnlinkedGroup(groups[1].key);
    expect(modal['unlinkedChoiceId']()).toBeNull();
  });

  it('refuses, visibly, when nothing has been picked', async () => {
    const { modal, api } = await withUnlinked();
    const { prompts } = captureConfirm(true);

    modal.selectUnlinkedGroup(modal['unlinkedCensus']().groups[0].key);
    await modal.applyUnlinkedFix();

    expect(prompts).toEqual([]);
    expect(api['updateCoin']).not.toHaveBeenCalled();
    expect(modal['unlinkedError']()).toBe('Choose a denomination first.');
  });

  it('also rewrites the country when the box is ticked', async () => {
    const { modal, api } = await withUnlinked();
    answerConfirm(true);

    modal.selectUnlinkedGroup(modal['unlinkedCensus']().groups[0].key);
    modal['unlinkedChoiceId'].set(103);
    modal['unlinkedSetCountry'].set(true);
    await modal.applyUnlinkedFix();

    const calls = (api['updateCoin'] as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call[1].country).toBe('Mexico');
  });

  it('sends the user to the Denominations pane with the missing label typed in', async () => {
    /* The 'unknown' fix: nothing in the list names this text, so the answer
     * may well be to add it. Dumping the user on an empty add form and
     * making them retype a spelling that is on the previous screen is how
     * `Trade Dollarr` gets into the reference list. */
    const { modal, inv } = await withUnlinked();
    inv.inventory.set([unlinkedCoin({ id: 'x', denomination: 'Trade Dollar', country: 'United States' })]);

    const group = modal['unlinkedCensus']().groups[0];
    expect(group.reason).toBe('unknown');

    modal.addMissingDenomination(group);

    expect(modal['activeSection']()).toBe('denominations');
    expect(modal['newDenominationLabel']()).toBe('Trade Dollar');
  });

  it('forgets the previous choice when a different group is selected', async () => {
    /* A sticky id is a bulk write to the wrong group: pick Mexico for the
     * 8 Reales, click the next group, press Apply, and forty coins are
     * silently linked to an 8 Reales they have nothing to do with. */
    const { modal, inv } = await withUnlinked();
    inv.inventory.set([
      unlinkedCoin({ id: 'u1', denomination: '8 Reales', country: 'United States' }),
      unlinkedCoin({ id: 'x', denomination: 'Trade Dollar', country: 'United States' }),
    ]);

    const groups = modal['unlinkedCensus']().groups;
    modal.selectUnlinkedGroup(groups[0].key);
    modal['unlinkedChoiceId'].set(103);
    modal['unlinkedSetCountry'].set(true);

    modal.selectUnlinkedGroup(groups[1].key);

    expect(modal['unlinkedChoiceId']()).toBeNull();
    expect(modal['unlinkedSetCountry']()).toBe(false);
  });
});
