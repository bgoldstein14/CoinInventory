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
  api['deleteIssuer'] = vi.fn(() => of(undefined));

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
