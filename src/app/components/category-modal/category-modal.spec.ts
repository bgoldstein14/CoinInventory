/*
 * Component wiring tests for the reference-data screen (no jsdom, so no
 * rendering). Grouping, counting and removal rules are tested in the pure
 * modules beside this file.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { NotificationService } from '../../services/notification.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { CoinRecord, Denomination } from '../../types/coin.model';
import { DenominationLookupResult, IssuerRecord } from '../../types/reference-data.model';
import { CategoryModal } from './category-modal';
import { blankIssuerDraft } from './issuer-draft';
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

/** Let the constructor's async fetches settle before asserting on loaded data. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function createModal(
  options: { issuers?: IssuerRecord[]; lookup?: DenominationLookupResult } = {}
) {
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
      metalContents: { '90% Silver': 7 },
    })
  );
  api['createIssuer'] = vi.fn((issuer: Record<string, unknown>) =>
    of({ ...BURMA, ...issuer, issuerId: 99, denominationCount: 0, coinCount: 0 })
  );
  api['updateIssuer'] = vi.fn(() => of(MEXICO));
  // Stubbed so the suite never depends on Wikidata being reachable.
  api['lookUpDenominations'] = vi.fn(() =>
    of(options.lookup ?? { outcome: 'none', source: 'Wikidata', proposals: [], reason: null })
  );
  // The real cascade response shape; the screen reports these numbers.
  api['deleteIssuer'] = vi.fn((id: number) =>
    of({ issuerId: id, denominationsRemoved: 0, coinsUnlinked: 0 })
  );

  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ApiService, useValue: mockApiService },
      { provide: NotificationService, useValue: mockNotification },
      // Real StorageService over fake-indexeddb, so the remembered checkbox is really persisted.
      { provide: StorageService, useValue: new StorageService() },
    ],
  });

  const modal = runInInjectionContext(injector, () => new CategoryModal());
  await flush();
  return { modal, inv, api, notification: mockNotification as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

/**
 * The template with its comments removed, so assertions can't match prose.
 * The class must be [\s\S]; see the guard test below.
 */
function stripTemplateComments(template: string): string {
  return template.replace(/<!--[\s\S]*?-->/g, '');
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

/* ----- Template comment-stripping helper ----- */

describe('stripTemplateComments', () => {
  it('strips every comment, not just the ones made of s', () => {
    // Guards against the regex degrading to `[sS]`, which would strip almost nothing.
    const stripped = stripTemplateComments(
      '<p>keep</p><!-- NO KIND PICKER: issuerKinds, reference-input--kind -->\n' +
        '<!-- a\nmulti-line\ncomment -->after'
    );

    expect(stripped).toBe('<p>keep</p>\nafter');
    expect(stripped).not.toContain('issuerKinds');
  });

  it('leaves everything that is not a comment exactly as it was', () => {
    const markup = '<button (click)="removeMetalContent(metal)">Remove</button>';
    expect(stripTemplateComments(markup)).toBe(markup);
  });
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
    const { modal, api } = await createModal();
    expect(api['getIssuers']).toHaveBeenCalledTimes(1);
    expect(api['getReferenceUsage']).toHaveBeenCalledTimes(1);
    expect(modal['issuers']()).toHaveLength(2);
  });

  it('still opens when the counts cannot be fetched', async () => {
    // A failed count only loses the badges; the dialog still opens.
    const { inv, mockApiService, mockNotification } = createTestInventoryService();
    const api = mockApiService as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api['getIssuers'] = vi.fn(() => of([MEXICO]));
    api['getReferenceUsage'] = vi.fn(() => throwError(() => new Error('offline')));

    const injector = Injector.create({
      providers: [
        { provide: InventoryService, useValue: inv },
        { provide: ApiService, useValue: mockApiService },
        { provide: NotificationService, useValue: mockNotification },
        { provide: StorageService, useValue: new StorageService() },
      ],
    });

    const modal = runInInjectionContext(injector, () => new CategoryModal());
    await flush();

    // The issuer load proves the constructor got past the failure.
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
        { provide: StorageService, useValue: new StorageService() },
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
    expect(modal.metalContentUsage('90% Silver')).toBe(7);
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

    // Headings are A-Z, regardless of arrival or SortOrder.
    const groups = modal['denominationGroups']();
    expect(groups.map((group) => group.heading)).toEqual(['Burma', 'Mexico']);
    expect(groups[1].denominations.map((d) => d.label)).toEqual(['8 Reales', '1 Peso']);
  });

  it('feeds the in-use counts into the grouping, so the heading total is real', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    const mexico = modal['denominationGroups']().find((group) => group.heading === 'Mexico');
    expect(mexico?.inUseTotal).toBe(3);
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

/* ----- Metal content ----- */

describe('CategoryModal — metal content', () => {
  it('adds and removes a metal, once confirmed', async () => {
    const { modal, inv } = await createModal();
    answerConfirm(true);

    modal['newMetalContent'].set('Electrum');
    modal.addMetalContentFromDraft();
    expect(inv.metalContents()).toContain('Electrum');

    modal.removeMetalContent('Electrum');
    expect(inv.metalContents()).not.toContain('Electrum');
  });

  it('clears the box after adding, so the next metal starts empty', async () => {
    const { modal } = await createModal();

    modal['newMetalContent'].set('Electrum');
    modal.addMetalContentFromDraft();
    expect(modal['newMetalContent']()).toBe('');
  });

  it('ignores a blank draft', async () => {
    const { modal, inv } = await createModal();
    const before = inv.metalContents().length;

    modal['newMetalContent'].set('   ');
    modal.addMetalContentFromDraft();
    expect(inv.metalContents()).toHaveLength(before);
  });

  it('keeps the list sorted and free of duplicates', async () => {
    const { modal, inv } = await createModal();
    inv.metalContents.set(['Gold', 'Silver']);

    modal['newMetalContent'].set('Bronze');
    modal.addMetalContentFromDraft();
    modal['newMetalContent'].set('Gold');
    modal.addMetalContentFromDraft();

    expect(inv.metalContents()).toEqual(['Bronze', 'Gold', 'Silver']);
  });

  it('names the metal and the coin count before removing it', async () => {
    const { modal, inv } = await createModal();
    inv.metalContents.set(['90% Silver']);
    const { prompts } = captureConfirm(false);

    modal.removeMetalContent('90% Silver');

    expect(prompts[0]).toContain('90% Silver');
    expect(prompts[0]).toContain('7 coins');
    expect(inv.metalContents()).toEqual(['90% Silver']);
  });

  it('promises the coins keep the metal already recorded on them', async () => {
    // Metal content is text on the coin, so the prompt offers no re-link step.
    const { modal, inv } = await createModal();
    inv.metalContents.set(['90% Silver']);
    const { prompts } = captureConfirm(false);

    modal.removeMetalContent('90% Silver');

    expect(prompts[0]).toContain('They keep the text already recorded');
    expect(prompts[0]).not.toContain('re-select');
  });

  it('has a pane for metal content in the template', async () => {
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain("@case ('metal-content')");
    expect(template).toContain('addMetalContentFromDraft()');
    expect(template).toContain('removeMetalContent(metal)');
    expect(template).toContain('metalContentUsage(metal)');
  });
});

/* ----- Issuers: the manual add path ----- */

describe('CategoryModal — issuers', () => {
  it('reports what is wrong with a draft instead of posting it', async () => {
    const { modal, api } = await createModal();

    modal['issuerDraft'].set({ name: '', isoCode: '', validFrom: '', validTo: '', lookUpOnline: false });
    await modal.addIssuerFromDraft();

    expect(api['createIssuer']).not.toHaveBeenCalled();
    expect(modal['issuerError']()).toContain('name');
  });

  it('catches a duplicate name before the unique constraint does', async () => {
    const { modal, api } = await createModal();

    modal['issuerDraft'].set({ name: ' mexico ', isoCode: '', validFrom: '', validTo: '', lookUpOnline: false });
    await modal.addIssuerFromDraft();

    expect(api['createIssuer']).not.toHaveBeenCalled();
    expect(modal['issuerError']()).toContain('Mexico');
  });

  it('creates a valid issuer and adds it to the list', async () => {
    const { modal, api } = await createModal();

    modal['issuerDraft'].set({
      name: 'Parthia',
      isoCode: '',
      validFrom: '-247',
      validTo: '224',
      lookUpOnline: false,
    });
    await modal.addIssuerFromDraft();

    // No `kind` in the payload; the server derives it.
    expect(api['createIssuer']).toHaveBeenCalledWith({
      name: 'Parthia',
      isoCode: null,
      validFrom: -247,
      validTo: 224,
    });
    expect(modal['issuers']().some((issuer) => issuer.issuerId === 99)).toBe(true);
    expect(modal['issuerError']()).toBe('');
  });

  it('empties the form after a successful add', async () => {
    const { modal } = await createModal();
    modal['issuerDraft'].set({ name: 'Parthia', isoCode: '', validFrom: '', validTo: '', lookUpOnline: false });
    await modal.addIssuerFromDraft();
    expect(modal['issuerDraft']().name).toBe('');
  });

  it('says so, and keeps the form, when the server refuses', async () => {
    const { modal, api } = await createModal();
    api['createIssuer'] = vi.fn(() => throwError(() => new Error('409')));

    modal['issuerDraft'].set({ name: 'Parthia', isoCode: '', validFrom: '', validTo: '', lookUpOnline: false });
    await modal.addIssuerFromDraft();

    expect(modal['issuerError']().length).toBeGreaterThan(0);
    expect(modal['issuerDraft']().name).toBe('Parthia');
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

/* ----- Issuers: live denomination counts -----
 * Counts are derived from `inv.denominations()`, not the cached
 * `IssuerRecord.denominationCount`. */

describe('CategoryModal — the issuer denomination count is derived, not cached', () => {
  it('counts the live denominations and ignores the number the record carried', async () => {
    // The record says denominationCount: 2; the live list has three.
    const { modal, inv } = await createModal();
    inv.denominations.set([
      ...DENOMINATIONS,
      { denominationId: 105, label: '2 Reales', country: 'MX', issuerId: 1, sortOrder: 3, isActive: true },
    ]);

    expect(MEXICO.denominationCount).toBe(2);
    expect(modal['issuerDenominationCount'](1)).toBe(3);
  });

  it('comes DOWN the moment a denomination is removed — the bug itself', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    expect(modal['issuerDenominationCount'](1)).toBe(2);

    // Same as removeDenomination: the list is replaced without the row.
    inv.denominations.set(DENOMINATIONS.filter((d) => d.denominationId !== 103));
    expect(modal['issuerDenominationCount'](1)).toBe(1);

    inv.denominations.set([]);
    expect(modal['issuerDenominationCount'](1)).toBe(0);
  });

  it('lets Remove through once the denominations are gone, with no reload in between', async () => {
    // Remove the denominations, then the issuer.
    const { modal, inv, api } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    const { prompts } = captureConfirm(true);

    inv.denominations.set([]);
    await modal.removeIssuer(MEXICO);

    expect(api['deleteIssuer']).toHaveBeenCalledWith(1);
    expect(prompts[0]).toContain('no denominations');
    expect(modal['issuerError']()).toBe('');
  });

  it('does not double-count the rows the online lookup just wrote', async () => {
    // Rows were already appended; an extra increment would double-count.
    const { modal, inv } = await createModal({
      lookup: {
        outcome: 'results',
        source: 'Wikidata',
        proposals: [{ label: '8 Reales' }, { label: '1 Peso' }],
        reason: null,
      } as DenominationLookupResult,
    });
    vi.spyOn(inv, 'addDenomination').mockImplementation(async (d) => {
      inv.denominations.set([
        ...inv.denominations(),
        { denominationId: 900 + inv.denominations().length, issuerId: 1, sortOrder: 0, isActive: true, country: 'MX', label: '', ...d } as Denomination,
      ]);
    });

    modal['lookupIssuer'].set(MEXICO);
    modal['lookupProposals'].set([
      { label: '8 Reales', chosen: true },
      { label: '1 Peso', chosen: true },
    ]);
    await modal.acceptProposals();

    expect(modal['issuerDenominationCount'](1)).toBe(2);
  });

  it('sums the coin usage of an issuer’s denominations, and no one else’s', async () => {
    // Usage fixture: denomination 103 is used by 3 coins; 104 and Burma's 201 by none.
    const { modal, inv } = await createModal();
    inv.denominations.set([
      ...DENOMINATIONS,
      { denominationId: 201, label: '1 Kyat', country: 'MM', issuerId: 2, sortOrder: 1, isActive: true },
    ]);

    expect(modal['issuerCoinCount'](1)).toBe(3);
    expect(modal['issuerCoinCount'](2)).toBe(0);
  });
});

/* ----- Issuers: the cascade, and the warning in front of it ----- */

describe('CategoryModal — removing an issuer cascades, after a warning', () => {
  it('warns with BOTH numbers and names the issuer', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    const { prompts } = captureConfirm(false);

    await modal.removeIssuer(MEXICO);

    expect(prompts[0]).toContain('Mexico');
    expect(prompts[0]).toContain('all 2 of its denominations');
    expect(prompts[0]).toContain('3 coins');
  });

  it('promises that no coin is deleted and each keeps its text', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    const { prompts } = captureConfirm(false);

    await modal.removeIssuer(MEXICO);

    expect(prompts[0]).toContain('No coin is deleted');
    expect(prompts[0]).toContain('read as Other');
    expect(prompts[0]).not.toContain('__OTHER__');
  });

  it('escalates: an issuer no coin depends on gets the quieter sentence', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set([
      { denominationId: 301, label: '4 Reales', country: 'MX', issuerId: 1, sortOrder: 1, isActive: true },
      { denominationId: 302, label: '2 Reales', country: 'MX', issuerId: 1, sortOrder: 2, isActive: true },
    ]);
    const { prompts } = captureConfirm(false);

    await modal.removeIssuer(MEXICO);

    expect(prompts[0]).toContain('2 denominations');
    expect(prompts[0]).toContain('nothing else changes');
    expect(prompts[0]).not.toContain('cannot be undone');
  });

  it('does NOT call the server when the confirmation is declined', async () => {
    const { modal, inv, api } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    answerConfirm(false);

    await modal.removeIssuer(MEXICO);

    expect(api['deleteIssuer']).not.toHaveBeenCalled();
    expect(modal['issuers']().some((issuer) => issuer.issuerId === 1)).toBe(true);
  });

  it('re-reads the denominations and the counts, because the cascade changed rows it did not name', async () => {
    // The server deactivated these denominations, so the client must reload them.
    const { modal, inv, api } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    const load = vi.spyOn(inv, 'loadDenominations').mockResolvedValue(undefined);
    answerConfirm(true);

    await modal.removeIssuer(MEXICO);

    expect(api['deleteIssuer']).toHaveBeenCalledWith(1);
    expect(load).toHaveBeenCalled();
    expect(api['getReferenceUsage'].mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports what the SERVER says it did, not what the dialog predicted', async () => {
    const { modal, inv, api, notification } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    vi.spyOn(inv, 'loadDenominations').mockResolvedValue(undefined);
    api['deleteIssuer'] = vi.fn(() => of({ issuerId: 1, denominationsRemoved: 31, coinsUnlinked: 43 }));
    answerConfirm(true);

    await modal.removeIssuer(MEXICO);

    const said = notification['showInfo'].mock.calls.map((call) => String(call[0]));
    expect(said.some((message) => message.includes('31 denominations') && message.includes('43 coins'))).toBe(
      true
    );
  });

  it('keeps the issuer and says why when the server refuses', async () => {
    const { modal, inv, api } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    api['deleteIssuer'] = vi.fn(() => throwError(() => new Error('boom')));
    answerConfirm(true);

    await modal.removeIssuer(MEXICO);

    expect(modal['issuers']().some((issuer) => issuer.issuerId === 1)).toBe(true);
    expect(modal['issuerError']().length).toBeGreaterThan(0);
  });
});

/* ----- Issuers: editing in place ----- */

describe('CategoryModal — editing an issuer', () => {
  it('fills the edit form from the row, years as strings', async () => {
    const { modal } = await createModal();

    modal['beginIssuerEdit'](MEXICO);

    expect(modal['editingIssuerId']()).toBe(1);
    expect(modal['issuerEditDraft']()).toEqual({
      name: 'Mexico',
      isoCode: 'MX',
      validFrom: '1821',
      validTo: '',
      lookUpOnline: false,
    });
  });

  it('PUTs the edit and keeps the id, sending no kind', async () => {
    // No `kind` in the payload; the server derives it.
    const { modal, api } = await createModal();
    api['updateIssuer'] = vi.fn((id: number, issuer: Record<string, unknown>) =>
      of({ ...MEXICO, ...issuer, issuerId: id })
    );

    modal['beginIssuerEdit'](MEXICO);
    modal['setIssuerEditField']('name', 'México');
    await modal.saveIssuerEdit();

    expect(api['updateIssuer']).toHaveBeenCalledWith(1, {
      name: 'México',
      isoCode: 'MX',
      validFrom: 1821,
      validTo: null,
    });
    const row = modal['issuers']().find((issuer) => issuer.issuerId === 1);
    expect(row?.name).toBe('México');
    expect(modal['editingIssuerId']()).toBeNull();
  });

  it('lets an issuer keep its own name — the lower-case fix, which is the point', async () => {
    // The row's own name is excluded, so a capitalisation fix doesn't clash with itself.
    const { modal, api } = await createModal({
      issuers: [{ ...MEXICO, name: 'mexico' }, BURMA],
    });
    api['updateIssuer'] = vi.fn((id: number, issuer: Record<string, unknown>) =>
      of({ ...MEXICO, ...issuer, issuerId: id })
    );

    modal['beginIssuerEdit']({ ...MEXICO, name: 'mexico' });
    modal['setIssuerEditField']('name', 'Mexico');
    await modal.saveIssuerEdit();

    expect(api['updateIssuer']).toHaveBeenCalled();
    expect(modal['issuerEditError']()).toBe('');
  });

  it('still catches a clash with a DIFFERENT issuer', async () => {
    const { modal, api } = await createModal();

    modal['beginIssuerEdit'](MEXICO);
    modal['setIssuerEditField']('name', 'burma');
    await modal.saveIssuerEdit();

    expect(api['updateIssuer']).not.toHaveBeenCalled();
    expect(modal['issuerEditError']()).toContain('Burma');
  });

  it('keeps the row open, with the typing in it, when the server refuses', async () => {
    const { modal, api } = await createModal();
    api['updateIssuer'] = vi.fn(() => throwError(() => new Error('409')));

    modal['beginIssuerEdit'](MEXICO);
    modal['setIssuerEditField']('name', 'Mexico City');
    await modal.saveIssuerEdit();

    expect(modal['editingIssuerId']()).toBe(1);
    expect(modal['issuerEditDraft']().name).toBe('Mexico City');
    expect(modal['issuerEditError']().length).toBeGreaterThan(0);
  });

  it('reports what is wrong with the draft instead of PUTting it', async () => {
    const { modal, api } = await createModal();

    modal['beginIssuerEdit'](MEXICO);
    modal['setIssuerEditField']('isoCode', 'MMM');
    await modal.saveIssuerEdit();

    expect(api['updateIssuer']).not.toHaveBeenCalled();
    expect(modal['issuerEditError']()).toContain('two letters');
  });

  it('cancels without writing anything', async () => {
    const { modal, api } = await createModal();

    modal['beginIssuerEdit'](MEXICO);
    modal['setIssuerEditField']('name', 'Nowhere');
    modal['cancelIssuerEdit']();
    await modal.saveIssuerEdit();

    expect(api['updateIssuer']).not.toHaveBeenCalled();
    expect(modal['editingIssuerId']()).toBeNull();
  });

  /** Edit path: a blank year span keeps the stored kind (e.g. British Colonial). */
  it('previews the STORED kind for an undated issuer, not the undated default', async () => {
    const colonial = {
      ...BURMA,
      issuerId: 7,
      name: 'British Colonial',
      isoCode: null,
      kind: 'historical' as const,
      validFrom: null,
      validTo: null,
    };
    const { modal } = await createModal({ issuers: [colonial] });

    modal['beginIssuerEdit'](colonial);
    modal['setIssuerEditField']('name', 'British Colonial ');

    expect(modal['derivedIssuerEditKind']()).toBe('historical');
  });

  it('DOES reclassify once the user gives that issuer years', async () => {
    const colonial = {
      ...BURMA,
      issuerId: 7,
      name: 'British Colonial',
      isoCode: null,
      kind: 'historical' as const,
      validFrom: null,
      validTo: null,
    };
    const { modal } = await createModal({ issuers: [colonial] });

    modal['beginIssuerEdit'](colonial);
    modal['setIssuerEditField']('validFrom', '-27');

    expect(modal['derivedIssuerEditKind']()).toBe('ancient');
  });

  it('offers Edit on the row and wires the form, in the template', async () => {
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain('beginIssuerEdit(issuer)');
    expect(template).toContain('saveIssuerEdit()');
    expect(template).toContain('cancelIssuerEdit()');
    expect(template).toContain('isEditingIssuer(issuer.issuerId)');
    expect(template).toContain('derivedIssuerEditKind()');
  });

  it('reads the row badge off the derived counts, never off the record', async () => {
    // Asserted on the template text: the badge must use the live count.
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain('issuerDenominationLabel(issuer.issuerId)');
    expect(template).toContain('issuerCoinCount(issuer.issuerId)');
    expect(template).not.toContain('issuer.denominationCount');
    expect(template).not.toContain('issuer.coinCount');
  });
});

/* ----- The unlinked-coins pane -----
 * Classification is tested in unlinked-denominations.spec.ts; this covers
 * the bulk write and the confirmation. */

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

/* ----- Issuers sorted A-Z ----- */

describe('CategoryModal — the issuer lists are alphabetical', () => {
  /**
   * `sortedIssuers` feeds both issuer controls; `issuers()` stays the raw
   * server list that write paths edit.
   */
  it('sorts the server list A-Z rather than showing it as it arrived', async () => {
    // Arrives in SortOrder order (Mexico before Burma).
    const { modal } = await createModal({ issuers: [MEXICO, BURMA] });

    expect(modal['issuers']().map((issuer) => issuer.name)).toEqual(['Mexico', 'Burma']);
    expect(modal['sortedIssuers']().map((issuer) => issuer.name)).toEqual(['Burma', 'Mexico']);
  });

  it('slots an issuer added during this session into place, not onto the end', async () => {
    // A newly added issuer is appended locally, so sorting must happen on read.
    const { modal } = await createModal({ issuers: [MEXICO, BURMA] });

    modal['issuerDraft'].set({ name: 'Austria', isoCode: '', validFrom: '', validTo: '', lookUpOnline: false });
    await modal.addIssuerFromDraft();

    expect(modal['issuers']().map((issuer) => issuer.name).at(-1)).toBe('Austria');
    expect(modal['sortedIssuers']().map((issuer) => issuer.name)).toEqual(['Austria', 'Burma', 'Mexico']);
  });

  it('does not reorder the signal the write paths read', async () => {
    // `.sort()` mutates; the source signal must keep its order.
    const { modal } = await createModal({ issuers: [MEXICO, BURMA] });

    modal['sortedIssuers']();

    expect(modal['issuers']().map((issuer) => issuer.issuerId)).toEqual([1, 2]);
  });

  it('renders the sorted list, and never the raw one, in the template', async () => {
    // Asserted on the raw template (no jsdom), since a template using issuers() would pass other tests.
    const template = readFileSync(join(__dirname, 'category-modal.html'), 'utf8');

    expect(template).toContain('@for (issuer of sortedIssuers(); track issuer.issuerId)');
    // The Issuers list and the Denominations issuer <select>.
    expect(template.split('sortedIssuers()').length - 1).toBeGreaterThanOrEqual(3);
    expect(template).not.toMatch(/[^d]issuers\(\)/);
  });

  it('orders the denomination pane headings A-Z too', async () => {
    const { modal, inv } = await createModal({ issuers: [MEXICO, BURMA] });
    inv.denominations.set([
      ...DENOMINATIONS,
      { denominationId: 201, label: '1 Kyat', country: 'MM', issuerId: 2, sortOrder: 1, isActive: true },
    ]);

    expect(modal['denominationGroups']().map((group) => group.heading)).toEqual(['Burma', 'Mexico']);
  });
});

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

    // What the plan intends to write: the link and the text.
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
      // One PUT per coin with only changed fields; the text is omitted because
      // these coins already say '8 Reales'.
      expect(call[1]).toMatchObject({ denominationId: 103 });
      // No country: the opt-in box was not ticked.
      expect(call[1].country).toBeUndefined();
    }

    expect(inv.inventory().every((coin) => coin.denominationId === 103 || coin.id === 'ok')).toBe(true);
    expect(modal['unlinkedCensus']().unlinkedCount).toBe(0);
  });

  it('sends the chosen LABEL as the text when the coin says something else', async () => {
    // The coin says '3CS' and the row is '3¢ Silver', so the label is also written as the text.
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
    // A 'resolvable' group pre-selects its single answer; an ambiguous group never does.
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
    // The 'unknown' fix carries the label across to the add form.
    const { modal, inv } = await withUnlinked();
    inv.inventory.set([unlinkedCoin({ id: 'x', denomination: 'Trade Dollar', country: 'United States' })]);

    const group = modal['unlinkedCensus']().groups[0];
    expect(group.reason).toBe('unknown');

    modal.addMissingDenomination(group);

    expect(modal['activeSection']()).toBe('denominations');
    expect(modal['newDenominationLabel']()).toBe('Trade Dollar');
  });

  it('forgets the previous choice when a different group is selected', async () => {
    // Selecting another group clears the previous choice.
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

/* ----- Issuers: deriving the kind, and the online denomination lookup ----- */

describe('CategoryModal — the derived issuer kind', () => {
  it('shows the kind the typed years imply, live', async () => {
    const { modal } = await createModal();

    modal['issuerDraft'].set({ ...blankIssuerDraft(false), name: 'Miletos', validFrom: '-600' });
    expect(modal['derivedIssuerKind']()).toBe('ancient');

    modal['issuerDraft'].set({ ...blankIssuerDraft(false), name: 'Siam', validFrom: '1948', validTo: '1989' });
    expect(modal['derivedIssuerKind']()).toBe('historical');

    modal['issuerDraft'].set({ ...blankIssuerDraft(false), name: 'Namibia', validFrom: '1990' });
    expect(modal['derivedIssuerKind']()).toBe('modern');
  });

  it('has no kind control left in the template', async () => {
    // Comments are stripped first; the template's comments mention the picker.
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).not.toContain('issuerKinds');
    expect(template).not.toContain('reference-input--kind');
    expect(template).not.toContain("setIssuerField('kind'");
    // The derived tag is present, so the block wasn't simply deleted.
    expect(template).toContain('derivedIssuerKind()');
  });
});

describe('CategoryModal — the online denomination lookup', () => {
  const PROPOSED = {
    outcome: 'results' as const,
    source: 'Wikidata',
    proposals: ['kyat', 'pya', 'Burmese rupee'],
    reason: null,
  };

  async function addSiam(modal: CategoryModal, lookUpOnline: boolean): Promise<void> {
    modal['issuerDraft'].set({
      name: 'Siam',
      isoCode: 'MM',
      validFrom: '1948',
      validTo: '1989',
      lookUpOnline,
    });
    await modal.addIssuerFromDraft();
  }

  it('does not make the request at all when the box is unticked', async () => {
    // Unticked means the request is never made, not made and ignored.
    const { modal, api } = await createModal({ lookup: PROPOSED });

    await addSiam(modal, false);

    expect(api['lookUpDenominations']).not.toHaveBeenCalled();
    expect(modal['lookupProposals']()).toEqual([]);
  });

  it('says that nothing was sent, and drops the user into adding them by hand', async () => {
    const { modal, api } = await createModal({ lookup: PROPOSED });

    await addSiam(modal, false);

    expect(modal['lookupMessage']()).toContain('nothing left this machine');
    expect(modal['newDenominationIssuerId']()).toBe(99);
    expect(modal['activeSection']()).toBe('denominations');
    expect(api['createIssuer']).toHaveBeenCalledTimes(1);
  });

  it('asks when the box is ticked, sending only the name', async () => {
    const { modal, api } = await createModal({ lookup: PROPOSED });

    await addSiam(modal, true);

    expect(api['lookUpDenominations']).toHaveBeenCalledWith('Siam');
  });

  it('PROPOSES the results and writes none of them', async () => {
    // Proposals only; nothing is inserted until the user accepts.
    const { modal, inv } = await createModal({ lookup: PROPOSED });
    const write = vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);

    await addSiam(modal, true);

    expect(modal['lookupPhase']()).toBe('proposing');
    expect(modal['lookupProposals']().map((proposal) => proposal.label)).toEqual([
      'kyat',
      'pya',
      'Burmese rupee',
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes exactly the ticked ones when the user confirms', async () => {
    const { modal, inv } = await createModal({ lookup: PROPOSED });
    const write = vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);
    await addSiam(modal, true);

    modal['toggleProposal']('pya');
    expect(modal['chosenProposalCount']()).toBe(2);

    await modal.acceptProposals();

    const added = write.mock.calls.map((call) => call[0]);
    expect(added.map((row) => row.label)).toEqual(['kyat', 'Burmese rupee']);
    expect(added.every((row) => row.issuerId === 99)).toBe(true);
    // Country kept in step with the issuer, like the manual add path.
    expect(added.every((row) => row.country === 'MM')).toBe(true);
  });

  it('states how many were added and by what route', async () => {
    const { modal, notification } = await createModal({ lookup: PROPOSED });
    await addSiam(modal, true);
    await modal.acceptProposals();

    const said = (notification['showInfo'] as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[0])
    );
    expect(said.some((message) => message.includes('3 denominations') && message.includes('Wikidata'))).toBe(
      true
    );
  });

  it('writes nothing, and still says so, when the user unticks everything', async () => {
    const { modal, inv } = await createModal({ lookup: PROPOSED });
    const write = vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);
    await addSiam(modal, true);

    modal['setAllProposals'](false);
    await modal.acceptProposals();

    expect(write).not.toHaveBeenCalled();
    expect(modal['lookupMessage']()).toContain('no denominations');
  });

  it('writes nothing when the user takes none of them', async () => {
    const { modal, inv } = await createModal({ lookup: PROPOSED });
    const write = vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);
    await addSiam(modal, true);

    modal.dismissProposals();

    expect(write).not.toHaveBeenCalled();
    expect(modal['lookupProposals']()).toEqual([]);
    expect(modal['activeSection']()).toBe('denominations');
    expect(modal['newDenominationIssuerId']()).toBe(99);
  });

  it('treats an empty answer as a normal outcome, not an error', async () => {
    // Athens returns nothing from the live endpoint.
    const { modal, notification } = await createModal({
      lookup: { outcome: 'none', source: 'Wikidata', proposals: [], reason: null },
    });

    await addSiam(modal, true);

    expect(modal['lookupPhase']()).toBe('settled');
    expect(modal['lookupMessage']()).toContain('had nothing for Siam');
    expect(modal['activeSection']()).toBe('denominations');
    expect(notification['showError']).not.toHaveBeenCalled();
  });

  it('survives the lookup failing outright, and keeps the issuer', async () => {
    // Our own server unreachable; the already-created issuer is kept.
    const { modal, api, notification } = await createModal();
    api['lookUpDenominations'] = vi.fn(() => throwError(() => new Error('offline')));

    await addSiam(modal, true);

    expect(modal['issuers']().some((issuer) => issuer.issuerId === 99)).toBe(true);
    expect(modal['lookupMessage']()).toContain('Could not reach');
    expect(modal['activeSection']()).toBe('denominations');
    expect(notification['showError']).not.toHaveBeenCalled();
  });

  it('remembers a refusal, so the next issuer does not re-tick the box', async () => {
    const { modal } = await createModal();
    expect(modal['issuerDraft']().lookUpOnline).toBe(true);

    modal['setLookUpOnline'](false);
    await addSiam(modal, false);

    // The lookup preference survives the form reset.
    expect(modal['issuerDraft']().lookUpOnline).toBe(false);
  });

  it('reads the remembered refusal back on the next open', async () => {
    // Real StorageService over fake-indexeddb, so the value survives the dialog.
    const first = await createModal();
    first.modal['setLookUpOnline'](false);
    await flush();

    const second = await createModal();
    await flush();
    expect(second.modal['issuerDraft']().lookUpOnline).toBe(false);
  });

  it('keeps the explanation on screen after it moves the user to another pane', async () => {
    // The banner sits outside the @switch so it survives the pane change.
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    const bannerAt = template.indexOf("lookupPhase() !== 'idle'");
    const switchAt = template.indexOf('@switch (activeSection())');
    expect(bannerAt).toBeGreaterThan(-1);
    expect(switchAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(switchAt);
  });

  it('puts the count of what will be written on the button that writes it', async () => {
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain('chosenProposalCount()');
    expect(template).toContain('acceptProposals()');
    expect(template).toContain('setLookUpOnline(');
    expect(template).toContain('lookupConsentLabel');
  });
});

/* ----- Collapsing issuer groups ----- */

describe('CategoryModal — collapse and expand all', () => {
  it('opens with every group expanded, as the pane always has', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    expect(modal['isCollapsed']('Mexico')).toBe(false);
    expect(modal['isCollapsed']('Burma')).toBe(false);
  });

  it('offers Collapse first, and folds every group with one press', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    expect(modal['expandAllControl']().action).toBe('collapse');
    modal['pressExpandAll']();

    expect(modal['isCollapsed']('Mexico')).toBe(true);
    expect(modal['isCollapsed']('Burma')).toBe(true);
  });

  it('then offers Expand, and the next press opens them again', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    modal['pressExpandAll']();
    expect(modal['expandAllControl']().action).toBe('expand');

    modal['pressExpandAll']();
    expect(modal['isCollapsed']('Mexico')).toBe(false);
    expect(modal['isCollapsed']('Burma')).toBe(false);
  });

  it('still offers Collapse while a single group is left open', async () => {
    // Any open group means the control offers collapse.
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    modal['pressExpandAll']();
    modal['toggleGroup']('Mexico');

    expect(modal['expandAllControl']().action).toBe('collapse');
  });

  it('keeps every group OPEN while a search is running, however it was folded', async () => {
    // Nothing is collapsed during a search, so results are never hidden.
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    modal['pressExpandAll']();
    expect(modal['isCollapsed']('Mexico')).toBe(true);

    modal['denominationSearch'].set('reales');
    expect(modal['isCollapsed']('Mexico')).toBe(false);

    // The fold is remembered after the search clears.
    modal['denominationSearch'].set('');
    expect(modal['isCollapsed']('Mexico')).toBe(true);
  });

  it('folds a group that was filtered out while the button was pressed', async () => {
    // Groups filtered out by a search must also be collapsed by "collapse all".
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    modal['denominationSearch'].set('reales');
    expect(modal['denominationGroups']().map((group) => group.heading)).toEqual(['Mexico']);
    modal['pressExpandAll']();

    modal['denominationSearch'].set('');
    expect(modal['isCollapsed']('Burma')).toBe(true);
  });

  it('puts the control on the denominations pane, and marks a shut group compact', async () => {
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain('pressExpandAll()');
    expect(template).toContain('expandAllControl().label');
    expect(template).toContain('expandAllControl().ariaLabel');
    expect(template).toContain('issuer-group--collapsed');
  });

  it('has a rule for the compact state, not just a class name', async () => {
    const styles = readFileSync(join(__dirname, 'category-modal.scss'), 'utf8');
    expect(styles).toContain('.issuer-group--collapsed');
  });
});

/* ----- Landing on a newly added issuer ----- */

describe('CategoryModal — the issuer just added is focused, never isolated', () => {
  async function addSiam(modal: CategoryModal): Promise<void> {
    modal['issuerDraft'].set({
      name: 'Siam',
      isoCode: 'MM',
      validFrom: '1948',
      validTo: '1989',
      lookUpOnline: false,
    });
    await modal.addIssuerFromDraft();
  }

  it('opens the new issuer and folds every other one', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    await addSiam(modal);

    expect(modal['activeSection']()).toBe('denominations');
    expect(modal['isCollapsed']('Siam')).toBe(false);
    expect(modal['isCollapsed']('Mexico')).toBe(true);
    expect(modal['isCollapsed']('Burma')).toBe(true);
  });

  it('LEAVES EVERY OTHER ISSUER IN THE LIST', async () => {
    // Focus collapses the others rather than filtering them out.
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    await addSiam(modal);

    const headings = modal['denominationGroups']().map((group) => group.heading);
    expect(headings).toEqual(['Burma', 'Mexico', 'Siam']);
  });

  it('leaves them one click from opening, with their rows intact', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    await addSiam(modal);
    modal['toggleGroup']('Mexico');

    expect(modal['isCollapsed']('Mexico')).toBe(false);
    const mexico = modal['denominationGroups']().find((group) => group.heading === 'Mexico');
    expect(mexico?.denominations.map((d) => d.label)).toEqual(['8 Reales', '1 Peso']);
  });

  it('focuses the same way after the lookup proposals are accepted', async () => {
    const { modal, inv } = await createModal({
      lookup: { outcome: 'results', source: 'Wikidata', proposals: ['kyat'], reason: null },
    });
    inv.denominations.set(DENOMINATIONS);
    vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);

    modal['issuerDraft'].set({
      name: 'Siam',
      isoCode: 'MM',
      validFrom: '1948',
      validTo: '1989',
      lookUpOnline: true,
    });
    await modal.addIssuerFromDraft();
    await modal.acceptProposals();

    expect(modal['isCollapsed']('Siam')).toBe(false);
    expect(modal['isCollapsed']('Mexico')).toBe(true);
    expect(modal['denominationGroups']().map((group) => group.heading)).toContain('Mexico');
  });

  it('opens the group a denomination was just added to, and only that one', async () => {
    // Adding into a folded group opens it.
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);

    modal['pressExpandAll']();
    modal['newDenominationIssuerId'].set(1);
    modal['newDenominationLabel'].set('2 Pesos');
    await modal.addDenominationFromDraft();

    expect(modal['isCollapsed']('Mexico')).toBe(false);
    expect(modal['isCollapsed']('Burma')).toBe(true);
  });
});

/* ----- Issuer list failed to load ----- */

describe('CategoryModal — a failed issuer load says so and stays said', () => {
  async function createWithFailedIssuers() {
    const created = await createModal();
    created.api['getIssuers'] = vi.fn(() => throwError(() => new Error('offline')));
    await created.modal['retryLoadIssuers']();
    return created;
  }

  it('records the failure instead of only firing a toast', async () => {
    // With no issuers, every denomination falls under "No issuer yet".
    const { modal } = await createWithFailedIssuers();

    expect(modal['issuers']()).toEqual([]);
    expect(modal['issuerLoadFailed']()).toBe(true);
  });

  it('raises the banner on the two panes built out of the issuer list', async () => {
    const { modal } = await createWithFailedIssuers();

    modal.selectSection('denominations');
    expect(modal['issuerListUnavailable']()).toBe(true);

    modal.selectSection('issuers');
    expect(modal['issuerListUnavailable']()).toBe(true);
  });

  it('does not raise it on a pane the failure cannot affect', async () => {
    const { modal } = await createWithFailedIssuers();

    modal.selectSection('categories');
    expect(modal['issuerListUnavailable']()).toBe(false);
  });

  it('clears once a retry succeeds', async () => {
    const { modal, api } = await createWithFailedIssuers();

    api['getIssuers'] = vi.fn(() => of([MEXICO, BURMA]));
    await modal['retryLoadIssuers']();

    expect(modal['issuerLoadFailed']()).toBe(false);
    expect(modal['issuers']().map((issuer) => issuer.name)).toEqual(['Mexico', 'Burma']);
  });

  it('renders the banner and its retry, comments stripped first', async () => {
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain('issuerListUnavailable()');
    expect(template).toContain('retryLoadIssuers()');
  });
});

/* ----- Issuers: re-adding one that was removed -----
 * Removal is a soft delete; the server revives the row. The form must not
 * treat it as a duplicate, and the user must be told it was restored. */
describe('CategoryModal — re-adding a removed issuer', () => {
  /** The answer the server gives when a soft-deleted row came back. */
  function revivalOf(overrides: Record<string, unknown> = {}) {
    return {
      ...BURMA,
      issuerId: 42,
      name: 'Burma',
      denominationCount: 3,
      coinCount: 0,
      revived: true,
      denominationsRestored: 3,
      ...overrides,
    };
  }

  function burmaDraft(lookUpOnline: boolean) {
    return { name: 'Burma', isoCode: '', validFrom: '', validTo: '', lookUpOnline };
  }

  it('POSTS a removed name instead of catching it as a duplicate', async () => {
    // The form only sees active issuers, so a removed name is sent to the server.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(false));
    await modal.addIssuerFromDraft();

    expect(api['createIssuer']).toHaveBeenCalledTimes(1);
    expect(modal['issuerError']()).toBe('');
  });

  it('SAYS it was restored, with the number of denominations that came back', async () => {
    const { modal, api, notification } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(false));
    await modal.addIssuerFromDraft();

    const said = (notification['showInfo'] as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[0])
    );
    expect(said.some((line) => line.includes('Restored') && line.includes('3'))).toBe(true);
  });

  it('keeps the id the server reused rather than inventing a row', async () => {
    // The list must hold the revived row's own id.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(false));
    await modal.addIssuerFromDraft();

    const added = modal['issuers']().filter((issuer) => issuer.name === 'Burma');
    expect(added).toHaveLength(1);
    expect(added[0].issuerId).toBe(42);
  });

  it('does NOT run the online lookup when the denominations came back with it', async () => {
    // No lookup: the revived issuer already holds these labels. The checkbox
    // is left on to show this holds even when the user wanted the lookup.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(true));
    await modal.addIssuerFromDraft();

    expect(api['lookUpDenominations']).not.toHaveBeenCalled();
    expect(modal['lookupMessage']()).toContain('nothing left this machine');
    expect(modal['lookupPhase']()).toBe('settled');
  });

  it('DOES run the lookup when the revived issuer came back empty', async () => {
    // Nothing came back, so the lookup is offered as for a new issuer.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() =>
      of(revivalOf({ denominationCount: 0, denominationsRestored: 0 }))
    );

    modal['issuerDraft'].set(burmaDraft(true));
    await modal.addIssuerFromDraft();

    expect(api['lookUpDenominations']).toHaveBeenCalledWith('Burma');
  });

  it('still says it was restored when nothing came back with it', async () => {
    const { modal, api, notification } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() =>
      of(revivalOf({ denominationCount: 0, denominationsRestored: 0 }))
    );

    modal['issuerDraft'].set(burmaDraft(false));
    await modal.addIssuerFromDraft();

    const said = (notification['showInfo'] as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[0])
    );
    expect(said.some((line) => line.includes('Restored') && line.includes('no denominations'))).toBe(true);
  });

  it('says nothing about restoring when the issuer was genuinely created', async () => {
    // The default stub answers without `revived` (a plain creation).
    const { modal, notification } = await createModal({ issuers: [MEXICO] });

    modal['issuerDraft'].set(burmaDraft(false));
    await modal.addIssuerFromDraft();

    const said = (notification['showInfo'] as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[0])
    );
    expect(said.some((line) => line.includes('Restored'))).toBe(false);
  });

  it('lands the user on the revived issuer so they can see what came back', async () => {
    // Land on the Denominations pane so the user can check the restored rows.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(true));
    await modal.addIssuerFromDraft();

    expect(modal['activeSection']()).toBe('denominations');
    expect(modal['newDenominationIssuerId']()).toBe(42);
  });
});
