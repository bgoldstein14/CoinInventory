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
  // Stubbed by default, and stubbed to the COMMONEST REAL OUTCOME. Leaving
  // it unstubbed would make the suite depend on Wikidata being reachable
  // while it runs, which is the thing this feature is not allowed to do.
  api['lookUpDenominations'] = vi.fn(() =>
    of(options.lookup ?? { outcome: 'none', source: 'Wikidata', proposals: [], reason: null })
  );
  // The real shape. DELETE cascades and reports what it removed, and the
  // screen reads those numbers back to the user; a bare `of(undefined)`
  // here would let a component that ignored them pass.
  api['deleteIssuer'] = vi.fn((id: number) =>
    of({ issuerId: id, denominationsRemoved: 0, coinsUnlinked: 0 })
  );

  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ApiService, useValue: mockApiService },
      { provide: NotificationService, useValue: mockNotification },
      // A real one, over fake-indexeddb (installed in beforeEach). The
      // screen remembers the online-lookup checkbox through it, and a
      // stub would make that test prove nothing.
      { provide: StorageService, useValue: new StorageService() },
    ],
  });

  const modal = runInInjectionContext(injector, () => new CategoryModal());
  await flush();
  return { modal, inv, api, notification: mockNotification as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

/**
 * The template with its comments removed.
 *
 * *** REQUIRED, NOT TIDINESS. *** This template explains at length why
 * the kind picker was dropped and why the lookup banner sits where it
 * does, and those explanations NAME the things the assertions look for.
 * Asserting against the raw text would match the prose and pass with the
 * markup gone.
 *
 * *** THE CHARACTER CLASS IS [\s\S] AND IT MATTERS. *** It was once
 * `[sS]` — the backslashes lost in transit — which matches a literal 's'
 * or 'S' and therefore strips only comments made entirely of those
 * letters, i.e. none of them. Every "comments are stripped first" test
 * below was running against the raw template, and the protection they
 * describe was not there. `strips every comment, not just the ones made
 * of s` pins it.
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

/* ----- The helper the template assertions depend on ----- */

describe('stripTemplateComments', () => {
  it('strips every comment, not just the ones made of s', () => {
    /* *** THIS GUARDS THE GUARD. *** The regex was `[sS]` for a while —
     * the backslashes of `[\s\S]` lost somewhere in transit — which
     * matches the LETTERS s and S. `<!-- sss -->` was stripped and every
     * real comment survived, so the four "comments are stripped first"
     * assertions below were quietly running against the raw template and
     * could have been satisfied by the prose they were written to ignore. */
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
        { provide: StorageService, useValue: new StorageService() },
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

    // Headings are A-Z, so Burma leads even though Mexico arrived first
    // and holds the lower SortOrder.
    const groups = modal['denominationGroups']();
    expect(groups.map((group) => group.heading)).toEqual(['Burma', 'Mexico']);
    expect(groups[1].denominations.map((d) => d.label)).toEqual(['8 Reales', '1 Peso']);
  });

  it('feeds the in-use counts into the grouping, so the heading total is real', async () => {
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    // Looked up by heading rather than by index: the count belongs to
    // Mexico, and an index would silently start asserting about whichever
    // issuer happens to sort first.
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

/* ----- Metal content -----
 *
 * MOVED HERE FROM settings-modal.spec.ts, which tested the chip editor the
 * Settings dialog used to carry. Those two tests ("applies a metal content
 * edit straight to the live list" and the blank-draft half of "ignores
 * blank drafts") are deleted there and their coverage is below, plus the
 * two things the Settings version could not do: count the coins using the
 * metal, and ask before removing it. */

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
    // The coin editor renders this list straight into its Metal dropdown,
    // where a second 'Gold' is a choice the user cannot tell apart from the
    // first one.
    const { modal, inv } = await createModal();
    inv.metalContents.set(['Gold', 'Silver']);

    modal['newMetalContent'].set('Bronze');
    modal.addMetalContentFromDraft();
    modal['newMetalContent'].set('Gold');
    modal.addMetalContentFromDraft();

    expect(inv.metalContents()).toEqual(['Bronze', 'Gold', 'Silver']);
  });

  it('names the metal and the coin count before removing it', async () => {
    /* THE CAPABILITY THE SETTINGS CHIPS DID NOT HAVE. A chip removed on
     * one click, with no number and no question, from the list that feeds
     * the melt-value calculation. */
    const { modal, inv } = await createModal();
    inv.metalContents.set(['90% Silver']);
    const { prompts } = captureConfirm(false);

    modal.removeMetalContent('90% Silver');

    expect(prompts[0]).toContain('90% Silver');
    expect(prompts[0]).toContain('7 coins');
    // ...and declining really declines.
    expect(inv.metalContents()).toEqual(['90% Silver']);
  });

  it('promises the coins keep the metal already recorded on them', async () => {
    // Coins.MetalContent is TEXT, not a foreign key, so nothing is unlinked
    // and nothing needs re-linking. Borrowing the denomination wording here
    // would offer a recovery step that does not exist.
    const { modal, inv } = await createModal();
    inv.metalContents.set(['90% Silver']);
    const { prompts } = captureConfirm(false);

    modal.removeMetalContent('90% Silver');

    expect(prompts[0]).toContain('They keep the text already recorded');
    expect(prompts[0]).not.toContain('re-select');
  });

  it('has a pane for metal content in the template', async () => {
    // Comments are stripped first: the @case below is introduced by a
    // comment that names the pane, and the component file explains the move
    // at length. Without the strip this assertion passes on prose.
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain("@case ('metal-content')");
    expect(template).toContain('addMetalContentFromDraft()');
    expect(template).toContain('removeMetalContent(metal)');
    // The badge, which is the half the Settings chips never had.
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

    // NO `kind` IN THE PAYLOAD. The server derives it from these two
    // years and returns the derived value; sending one would be the
    // client asserting a classification the server recomputes anyway.
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
    // The user's typing is the only copy of it. Clearing the form on a
    // failure throws away work in the one situation where they need it.
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

/* ----- Issuers: THE DENOMINATION COUNT, AND WHY IT USED TO GO STALE -----
 *
 * `IssuerRecord.denominationCount` arrives with the issuer list and is a
 * snapshot of a server-side GROUP BY. It was then maintained by hand —
 * incremented when the online lookup wrote rows and decremented by nothing
 * at all — and `removeIssuer` consulted it before deciding whether the
 * issuer could go. So the owner removed the denominations, the number did
 * not move, and Remove refused forever. "I tried removing the denominations
 * first, but that didn't work" is this, exactly.
 *
 * The repair is not a reload after every edit; it is that there is no
 * second copy to go stale. These tests pin that the figure comes from
 * `inv.denominations()`, which is the same array the pane next door
 * renders. */

describe('CategoryModal — the issuer denomination count is derived, not cached', () => {
  it('counts the live denominations and ignores the number the record carried', async () => {
    // MEXICO says denominationCount: 2. The live list says three.
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

    // Exactly what removeDenomination does to the list: replace it without
    // the removed row. Nothing patches a count and nothing reloads.
    inv.denominations.set(DENOMINATIONS.filter((d) => d.denominationId !== 103));
    expect(modal['issuerDenominationCount'](1)).toBe(1);

    inv.denominations.set([]);
    expect(modal['issuerDenominationCount'](1)).toBe(0);
  });

  it('lets Remove through once the denominations are gone, with no reload in between', async () => {
    // THE OWNER'S SEQUENCE, END TO END. Remove the denominations, then the
    // issuer. The old code never reached the server on the second step.
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
    // acceptProposals used to ADD labels.length to the cached count on top
    // of inv.addDenomination having already appended the rows. With the
    // count derived, a second increment would now show four where there
    // are two.
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
    // The usage index in createModal says denomination 103 is used by 3
    // coins. 104 is used by none, and Burma's 201 is somebody else's.
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
    // THE COIN COUNT. A warning that cannot say this is not strong, just
    // alarming — the user's only safe answer would be no.
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
    // Mexico's two denominations, neither of them used by a coin.
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
    // The server has just deactivated denominations this client is still
    // holding. Leaving them in the list would put them back under "No
    // issuer yet" — the exact mess the old refusal was invented to avoid.
    const { modal, inv, api } = await createModal();
    inv.denominations.set(DENOMINATIONS);
    const load = vi.spyOn(inv, 'loadDenominations').mockResolvedValue(undefined);
    answerConfirm(true);

    await modal.removeIssuer(MEXICO);

    expect(api['deleteIssuer']).toHaveBeenCalledWith(1);
    expect(load).toHaveBeenCalled();
    // Once on open, once after the cascade.
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

/* ----- Issuers: RENAMING, which is the fault behind all the others -----
 *
 * The owner typed a name in lower case and the row offered him one button:
 * Remove. PUT /issuers/:id had been on the server the whole time and
 * nothing called it. */

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
      // Editing an issuer must never fire the outbound lookup.
      lookUpOnline: false,
    });
  });

  it('PUTs the edit and keeps the id, sending no kind', async () => {
    // NO `kind` IN THE PAYLOAD, exactly as the add path sends none. The
    // server derives it and falls back to the stored value; asserting one
    // here would be the client overruling that.
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
    // Validating against EVERY name, including this row's own, would make
    // "mexico" -> "Mexico" fail against itself. That is the one edit this
    // whole feature exists for.
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

  /**
   * THE BRITISH COLONIAL GUARANTEE, on the edit path.
   *
   * resolveIssuerKind keeps a STORED kind when the year span is blank, so
   * that the one seeded issuer with no dates and a curated 'historical' is
   * not silently reclassified the first time somebody fixes a typo in it.
   * The edit form has to show the same thing the server will store, or the
   * tag the user reads while saving disagrees with the row they save.
   */
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
    // No jsdom here, so the template text is asserted directly. Comments
    // are stripped first — this block is introduced by one that names
    // every handler below.
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain('beginIssuerEdit(issuer)');
    expect(template).toContain('saveIssuerEdit()');
    expect(template).toContain('cancelIssuerEdit()');
    expect(template).toContain('isEditingIssuer(issuer.issuerId)');
    // The edit preview, not the add form's.
    expect(template).toContain('derivedIssuerEditKind()');
  });

  it('reads the row badge off the derived counts, never off the record', async () => {
    // A template that went back to `issuer.denominationCount` would pass
    // every component test in this file while showing the user the stale
    // number that made Remove refuse forever.
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).toContain('issuerDenominationLabel(issuer.issuerId)');
    expect(template).toContain('issuerCoinCount(issuer.issuerId)');
    expect(template).not.toContain('issuer.denominationCount');
    expect(template).not.toContain('issuer.coinCount');
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

/* ----- The owner's request: issuers A-Z on both screens ----- */

describe('CategoryModal — the issuer lists are alphabetical', () => {
  /**
   * `sortedIssuers` is what BOTH issuer-shaped controls render: the Issuers
   * pane's list, and the Denominations pane's "which issuer" <select>.
   * The template reads it in all three places; `issuers()` stays the raw
   * server list and is what the write paths edit.
   */
  it('sorts the server list A-Z rather than showing it as it arrived', async () => {
    // Arrival order is SortOrder order, which is what the old endpoint
    // sent and what the seed's bands produce: Mexico (10) before Burma
    // (20). An implementation that just passed the array through would
    // give ['Mexico', 'Burma'] here.
    const { modal } = await createModal({ issuers: [MEXICO, BURMA] });

    expect(modal['issuers']().map((issuer) => issuer.name)).toEqual(['Mexico', 'Burma']);
    expect(modal['sortedIssuers']().map((issuer) => issuer.name)).toEqual(['Burma', 'Mexico']);
  });

  it('slots an issuer added during this session into place, not onto the end', async () => {
    // `addIssuerFromDraft` appends the created row rather than re-fetching,
    // so without a sort on read the user's brand-new issuer appears at the
    // bottom of 62 rows — in the exact list they are looking at to check
    // the add worked.
    const { modal } = await createModal({ issuers: [MEXICO, BURMA] });

    modal['issuerDraft'].set({ name: 'Austria', isoCode: '', validFrom: '', validTo: '', lookUpOnline: false });
    await modal.addIssuerFromDraft();

    expect(modal['issuers']().map((issuer) => issuer.name).at(-1)).toBe('Austria');
    expect(modal['sortedIssuers']().map((issuer) => issuer.name)).toEqual(['Austria', 'Burma', 'Mexico']);
  });

  it('does not reorder the signal the write paths read', async () => {
    // `.sort()` mutates. The array here is signal state that `removeIssuer`
    // filters and `denominationGroups` reads, so sorting it in place would
    // reorder what every other reader sees, intermittently.
    const { modal } = await createModal({ issuers: [MEXICO, BURMA] });

    modal['sortedIssuers']();

    expect(modal['issuers']().map((issuer) => issuer.issuerId)).toEqual([1, 2]);
  });

  it('renders the sorted list, and never the raw one, in the template', async () => {
    // There is no jsdom here, so a template that went back to `issuers()`
    // would pass every other test in this file while showing the user the
    // unsorted list. The template text is therefore asserted directly,
    // the way inventory-table-thumbnails.spec.ts asserts loading="lazy":
    // it is load-bearing, not cosmetic.
    const template = readFileSync(join(__dirname, 'category-modal.html'), 'utf8');

    expect(template).toContain('@for (issuer of sortedIssuers(); track issuer.issuerId)');
    // Both of them: the Issuers pane's list and the Denominations pane's
    // "which issuer" <select>.
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

/* ----- Issuers: deriving the kind, and the online denomination lookup ----- */

describe('CategoryModal — the derived issuer kind', () => {
  it('shows the kind the typed years imply, live', async () => {
    // The picker is gone. This is what replaced it, and it is why that is
    // not the same as hiding a field.
    const { modal } = await createModal();

    modal['issuerDraft'].set({ ...blankIssuerDraft(false), name: 'Miletos', validFrom: '-600' });
    expect(modal['derivedIssuerKind']()).toBe('ancient');

    modal['issuerDraft'].set({ ...blankIssuerDraft(false), name: 'Siam', validFrom: '1948', validTo: '1989' });
    expect(modal['derivedIssuerKind']()).toBe('historical');

    modal['issuerDraft'].set({ ...blankIssuerDraft(false), name: 'Namibia', validFrom: '1990' });
    expect(modal['derivedIssuerKind']()).toBe('modern');
  });

  it('has no kind control left in the template', async () => {
    // *** COMMENTS ARE STRIPPED FIRST. *** The template still TALKS about
    // the picker, at length, in the comment explaining why it went. An
    // assertion against the raw text would match that prose and pass
    // while the <select> was still on screen.
    const template = stripTemplateComments(readFileSync(join(__dirname, 'category-modal.html'), 'utf8'));

    expect(template).not.toContain('issuerKinds');
    expect(template).not.toContain('reference-input--kind');
    expect(template).not.toContain("setIssuerField('kind'");
    // And the derived tag IS there, so this is not passing because the
    // whole block was deleted.
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
    // *** THE WHOLE POINT OF THE CHECKBOX. *** "Unchecked must skip the
    // request entirely rather than making it and discarding the answer."
    // Nothing downstream can un-send a packet, so this asserts the call
    // was never made — not that its answer was ignored.
    const { modal, api } = await createModal({ lookup: PROPOSED });

    await addSiam(modal, false);

    expect(api['lookUpDenominations']).not.toHaveBeenCalled();
    expect(modal['lookupProposals']()).toEqual([]);
  });

  it('says that nothing was sent, and drops the user into adding them by hand', async () => {
    const { modal, api } = await createModal({ lookup: PROPOSED });

    await addSiam(modal, false);

    expect(modal['lookupMessage']()).toContain('nothing left this machine');
    // Preselected and on the right pane: an issuer that noisily has no
    // denominations but leaves the user hunting for the dropdown is most
    // of the original bug.
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
    // Denominations are reference data that coins link to BY ID. A wrong
    // row is a wrong foreign key that outlives the mistake, so the answer
    // to a lookup is a tick-list and not an INSERT.
    const { modal, inv } = await createModal({ lookup: PROPOSED });
    const write = vi.spyOn(inv, 'addDenomination').mockResolvedValue(undefined);

    await addSiam(modal, true);

    expect(modal['lookupPhase']()).toBe('proposing');
    expect(modal['lookupProposals']().map((proposal) => proposal.label)).toEqual([
      'kyat',
      'pya',
      'Burmese rupee',
    ]);
    // The assertion that matters: the write path was never entered.
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
    // Country kept in step with the issuer, like the manual add path: the
    // editor's dropdown still groups by it.
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
    // Measured against the live endpoint: Athens returns nothing.
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
    // Our OWN server unreachable — a different failure from the one the
    // route reports, and it must read the same to the user. The issuer is
    // already created by this point and must not be lost.
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

    // The form is blanked after a successful add; the standing preference
    // is not part of what gets blanked.
    expect(modal['issuerDraft']().lookUpOnline).toBe(false);
  });

  it('reads the remembered refusal back on the next open', async () => {
    // Through a real StorageService over fake-indexeddb, so this proves
    // the value survives the dialog rather than a signal being reused.
    const first = await createModal();
    first.modal['setLookUpOnline'](false);
    await flush();

    const second = await createModal();
    await flush();
    expect(second.modal['issuerDraft']().lookUpOnline).toBe(false);
  });

  it('keeps the explanation on screen after it moves the user to another pane', async () => {
    // The banner lives OUTSIDE the @switch for this reason. Comments are
    // stripped first, because the template explains the arrangement in
    // prose that would otherwise match.
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
    // And the consent checkbox is on the form, not hidden in Settings.
    expect(template).toContain('setLookUpOnline(');
    expect(template).toContain('lookupConsentLabel');
  });
});

/* ----- Folding 70 issuer groups ----- */

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
    // One open group is enough to bury the headings under it, which is the
    // only reason the control exists. A majority rule would make the button
    // do the wrong thing at exactly the moment it matters.
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    modal['pressExpandAll']();
    modal['toggleGroup']('Mexico');

    expect(modal['expandAllControl']().action).toBe('collapse');
  });

  it('keeps every group OPEN while a search is running, however it was folded', async () => {
    // The rule that was already here and must survive: hiding a search
    // result because its group happened to be shut makes the search
    // silently incomplete.
    const { modal, inv } = await createModal();
    inv.denominations.set(DENOMINATIONS);

    modal['pressExpandAll']();
    expect(modal['isCollapsed']('Mexico')).toBe(true);

    modal['denominationSearch'].set('reales');
    expect(modal['isCollapsed']('Mexico')).toBe(false);

    // And the fold is remembered rather than thrown away by the search.
    modal['denominationSearch'].set('');
    expect(modal['isCollapsed']('Mexico')).toBe(true);
  });

  it('folds a group that was filtered out while the button was pressed', async () => {
    /* THE HOLE A LIST OF FOLDED HEADINGS WOULD HAVE. Collapse all while a
     * search is narrowing the pane to one issuer, then clear the search:
     * with a denylist the groups that were not on screen were never named
     * and would spring open again. */
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
    // The modifier is what makes the collapsed state SHORTER rather than
    // merely emptier; without it 70 folded cards are their own scroll.
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
    /* *** THE BUG THIS REPLACES. *** The pane used to leave the owner
     * looking at the issuer he had just added with no route to any other.
     * Focus is a collapse, so the other issuers are still grouped, still
     * counted and still on screen. */
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
    // Writing a row into a folded group and leaving it folded reads as the
    // Add button having done nothing — and folded is now a normal state to
    // be adding from.
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

/* ----- The one state in which the pane really does show one issuer ----- */

describe('CategoryModal — a failed issuer load says so and stays said', () => {
  async function createWithFailedIssuers() {
    const created = await createModal();
    created.api['getIssuers'] = vi.fn(() => throwError(() => new Error('offline')));
    await created.modal['retryLoadIssuers']();
    return created;
  }

  it('records the failure instead of only firing a toast', async () => {
    /* *** WHY THIS MATTERS ON THIS SCREEN. *** Nothing filters the
     * denominations pane by issuer: its headings ARE the issuer list. An
     * empty list therefore files all 1,207 rows under "No issuer yet",
     * and one added issuer leaves exactly one heading on screen — which
     * reads as the pane having filtered itself. The toast that announced
     * the failure is gone by the time the user gets there. */
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
    // A standing warning on a pane it does not apply to is a warning users
    // learn to read past.
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

/* ----- Issuers: re-adding one that was removed ----- */

/*
 * *** THE BUG THE OWNER REPORTED. *** "The Edit/Delete of Issuer looks like
 * it worked, except when I tried to add them back in, I got an error saying
 * the Issuer(s) already exist."
 *
 * Removal is a SOFT delete, so the row kept the name. The server now revives
 * that row instead of refusing, and these cover the screen's half: the form
 * must NOT catch it as a duplicate (it cannot see a removed issuer and
 * should not try), and the user must be TOLD that what came back is their
 * old issuer rather than a new one.
 */
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
    // The form compares against `issuers()`, which holds only the ACTIVE
    // ones because that is all GET returns. A removed 'Burma' is therefore
    // not a clash here and the request must go out — the server's answer to
    // it is a revival. Teaching the form about removed issuers would only
    // reinstate the refusal the owner hit.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(false));
    await modal.addIssuerFromDraft();

    expect(api['createIssuer']).toHaveBeenCalledTimes(1);
    expect(modal['issuerError']()).toBe('');
  });

  it('SAYS it was restored, with the number of denominations that came back', async () => {
    // *** THE MOMENT THE USER FINDS OUT WHETHER THEIR DATA RETURNED. ***
    // Doing this silently is the failure mode even though the outcome is
    // the good one: they pressed Add expecting a blank issuer.
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
    // Denominations and coins reach an issuer BY ID. The list the screen
    // holds has to carry the revived row's own id or every later action on
    // it — edit, remove, file a denomination under it — addresses the wrong
    // issuer.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(false));
    await modal.addIssuerFromDraft();

    const added = modal['issuers']().filter((issuer) => issuer.name === 'Burma');
    expect(added).toHaveLength(1);
    expect(added[0].issuerId).toBe(42);
  });

  it('does NOT run the online lookup when the denominations came back with it', async () => {
    // *** NOT A DEGRADATION — THE CORRECT BEHAVIOUR. *** The issuer already
    // holds these labels, so the source would propose what it has;
    // accepting one would put two rows with the same label under one
    // issuer, and a coin carrying that text then resolves as ambiguous,
    // which resolves to NULL. The lookup would cost a denomination.
    //
    // The checkbox is left ON here on purpose: this must hold for the user
    // who WANTED the lookup, not only for the one who turned it off.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(true));
    await modal.addIssuerFromDraft();

    expect(api['lookUpDenominations']).not.toHaveBeenCalled();
    expect(modal['lookupMessage']()).toContain('nothing left this machine');
    expect(modal['lookupPhase']()).toBe('settled');
  });

  it('DOES run the lookup when the revived issuer came back empty', async () => {
    // Nothing came back, so the issuer really is empty and the lookup is
    // exactly as useful as it is for a brand-new one.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() =>
      of(revivalOf({ denominationCount: 0, denominationsRestored: 0 }))
    );

    modal['issuerDraft'].set(burmaDraft(true));
    await modal.addIssuerFromDraft();

    expect(api['lookUpDenominations']).toHaveBeenCalledWith('Burma');
  });

  it('still says it was restored when nothing came back with it', async () => {
    // The row is still their old one, with its id, and that is still not
    // what pressing Add looks like it does.
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
    // The default stub answers without `revived`, which is the creation
    // shape. A screen that announced a restore for every add would be
    // worse than one that never did.
    const { modal, notification } = await createModal({ issuers: [MEXICO] });

    modal['issuerDraft'].set(burmaDraft(false));
    await modal.addIssuerFromDraft();

    const said = (notification['showInfo'] as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[0])
    );
    expect(said.some((line) => line.includes('Restored'))).toBe(false);
  });

  it('lands the user on the revived issuer so they can see what came back', async () => {
    // The whole point of saying "3 denominations came back" is that the
    // user can check it. Leaving them on the Issuers pane to go and find it
    // is most of the same omission.
    const { modal, api } = await createModal({ issuers: [MEXICO] });
    api['createIssuer'] = vi.fn(() => of(revivalOf()));

    modal['issuerDraft'].set(burmaDraft(true));
    await modal.addIssuerFromDraft();

    expect(modal['activeSection']()).toBe('denominations');
    expect(modal['newDenominationIssuerId']()).toBe(42);
  });
});
