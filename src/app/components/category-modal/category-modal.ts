import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { NotificationService } from '../../services/notification.service';
import { confirmAction } from '../../features/confirm-action';
import { describeHttpError } from '../../services/http-utils';
import {
  UnlinkedGroup,
  censusUnlinkedDenominations,
  describeUnlinkedCensus,
  describeUnlinkedFixOutcome,
  describeUnlinkedFixPlan,
  describeUnlinkedReason,
  planUnlinkedFix,
  runUnlinkedFix,
} from '../../services/denominations/unlinked-denominations';
import {
  denominationPickerBase,
  denominationPickerView,
} from '../coin-editor-form/denomination-picker';
import { IssuerRecord, ReferenceUsageCounts } from '../../types/reference-data.model';

import {
  DEFAULT_REFERENCE_SECTION,
  REFERENCE_SECTIONS,
  ReferenceSectionId,
  resolveReferenceSection,
} from './reference-sections';
import { MaintenanceDenomination, groupDenominations } from './denomination-grouping';
import {
  EMPTY_REFERENCE_USAGE,
  describeUsage,
  planDenominationRemoval,
  planReferenceRemoval,
  usageCount,
} from './reference-usage';
import {
  ISSUER_KINDS,
  ISSUER_NAME_MAX_LENGTH,
  IssuerDraft,
  blankIssuerDraft,
  describeIssuerRemoval,
  validateIssuerDraft,
} from './issuer-draft';

/**
 * CategoryModal — the reference-data maintenance screen.
 *
 * THE SHAPE: A SIDEBAR OF TYPES, ONE PANE EACH
 * The sections are DATA (reference-sections.ts). Adding a seventh reference
 * type is one entry there and one `@case` in the template; the navigation,
 * the highlighting and the ARIA wiring come for free and cannot drift from
 * each other.
 *
 * WHERE THE LOGIC IS, AND WHY IT IS NOT HERE
 * This project's frontend tests run under Node with NO JSDOM, so a component
 * cannot be rendered in a test at all. Everything that could be wrong in an
 * interesting way therefore lives in a pure module beside this file:
 *
 *     reference-sections.ts     which panes exist, and the fallback
 *     denomination-grouping.ts  grouping by issuer, and the search rules
 *     reference-usage.ts        the in-use counts and the removal prompts
 *     issuer-draft.ts           what a new issuer is allowed to be
 *
 * What is left here is wiring: signals, service calls, and the order things
 * happen in. category-modal.spec.ts tests that wiring without rendering.
 *
 * EVERY REMOVE ASKS FIRST, AND EVERY QUESTION CARRIES A NUMBER
 * Each entry carries a usage badge, and the confirmation repeats the figure.
 *
 * `confirmAction` from features/confirm-action.ts is the right helper here
 * and its FAIL-OPEN default is the right default: it was written for buttons
 * the user pressed on purpose, and these are. In an environment with no
 * `window.confirm` — the unit tests, a future embedded shell — refusing to
 * remove anything would leave a screen of dead buttons and no way forward.
 * The sibling `confirmOverwrite` fails CLOSED and is correct for its caller,
 * which is a question the APP raises about data the user typed; that is the
 * opposite situation in both respects, so it is the wrong helper here.
 *
 * The one exception is `removeIssuer`, which refuses rather than asks. See
 * `describeIssuerRemoval` in issuer-draft.ts for the argument.
 *
 * WHY THE ISSUER LIST IS LOCAL STATE AND NOT AN InventoryService SIGNAL
 * Every other reference list is a signal on InventoryService because the rest
 * of the app reads it — the editor's dropdowns, the grid, the reports. Nothing
 * outside this dialog reads issuers, so fetching them plus their GROUP BY
 * counts during startup would be a cost with no reader. They are loaded when
 * this component is constructed, which IS when the dialog is opened, and
 * dropped when it closes.
 *
 * Writes to the OTHER five lists still go through InventoryService, because
 * those signals are shared and a local copy would leave the editor's
 * dropdowns stale until a reload.
 */
@Component({
  selector: 'app-category-modal',
  imports: [FormsModule],
  templateUrl: './category-modal.html',
  styleUrl: './category-modal.scss'
})
export class CategoryModal {
  private readonly inventoryService = inject(InventoryService);
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  protected get inv() { return this.inventoryService; }

  readonly closed = output<void>();

  // ===================== The panes =====================

  protected readonly sections = REFERENCE_SECTIONS;

  /**
   * Which pane to open on.
   *
   * A plain string rather than the union type, resolved on read: a caller
   * passing an id that has drifted must get a working dialog, not a
   * highlighted sidebar above an empty body.
   */
  readonly initialSection = input<string>(DEFAULT_REFERENCE_SECTION);

  /** Null until the user clicks the sidebar; then it overrides the input. */
  private readonly chosenSection = signal<ReferenceSectionId | null>(null);

  protected readonly activeSection = computed<ReferenceSectionId>(
    () => this.chosenSection() ?? resolveReferenceSection(this.initialSection())
  );

  protected readonly activeSectionTitle = computed(
    () => this.sections.find((section) => section.id === this.activeSection())?.title ?? ''
  );
  protected readonly activeSectionHint = computed(
    () => this.sections.find((section) => section.id === this.activeSection())?.hint ?? ''
  );

  /** Show a pane. Takes a plain string because the caller is a template loop. */
  selectSection(id: string): void {
    this.chosenSection.set(resolveReferenceSection(id));
  }

  // ===================== Loaded on open =====================

  protected readonly issuers = signal<IssuerRecord[]>([]);
  protected readonly usage = signal<ReferenceUsageCounts>(EMPTY_REFERENCE_USAGE);

  constructor() {
    void this.loadIssuers();
    void this.refreshUsage();
  }

  private async loadIssuers(): Promise<void> {
    try {
      this.issuers.set(await firstValueFrom(this.api.getIssuers()));
    } catch (error) {
      // An empty issuer list is a usable screen: every other pane works, and
      // the denominations pane shows its rows under "No issuer yet" rather
      // than nothing at all. Refusing to open would turn a failed fetch into
      // a locked door.
      this.notifications.showError(`Could not load issuers: ${describeHttpError(error)}`);
      this.issuers.set([]);
    }
  }

  /**
   * Re-read the in-use counts.
   *
   * Called on open and after anything that changes them. A stale count here
   * is not cosmetic: it is the number the next confirmation will quote.
   */
  private async refreshUsage(): Promise<void> {
    try {
      this.usage.set(await firstValueFrom(this.api.getReferenceUsage()));
    } catch {
      // Deliberately silent and deliberately non-fatal. A missing badge is a
      // missing badge; the screen's other job — editing the lists — is
      // unaffected, and a toast for it on every open of an offline app would
      // be noise.
      this.usage.set(EMPTY_REFERENCE_USAGE);
    }
  }

  usageLabel(count: number): string {
    return describeUsage(count);
  }

  categoryUsage(name: string): number {
    return usageCount(this.usage().categories, name);
  }

  coinSetUsage(name: string): number {
    return usageCount(this.usage().coinSets, name);
  }

  denominationUsage(id: number): number {
    return usageCount(this.usage().denominations, id);
  }

  mintMarkUsage(label: string): number {
    return usageCount(this.usage().mintMarks, label);
  }

  catalogUsage(id: number): number {
    return usageCount(this.usage().catalogs, id);
  }

  // ===================== Categories =====================

  protected readonly newCategoryOption = signal<string>('');

  addCategoryOptionFromDraft(): void {
    const draft = this.newCategoryOption().trim();
    if (!draft) return;
    this.inv.mergeCategoryOptions([draft]);
    this.newCategoryOption.set('');
  }

  removeCategoryOption(category: string): void {
    const plan = planReferenceRemoval('category', category, this.categoryUsage(category));
    if (!confirmAction(plan.prompt)) return;
    this.inv.removeCategoryOption(category);
  }

  // ===================== Collection sets =====================

  protected readonly newCoinSet = signal<string>('');

  addCoinSetFromDraft(): void {
    const draft = this.newCoinSet().trim();
    if (!draft) return;
    this.inv.addCoinSet(draft);
    this.newCoinSet.set('');
  }

  removeCoinSet(name: string): void {
    const plan = planReferenceRemoval('set', name, this.coinSetUsage(name));
    if (!confirmAction(plan.prompt)) return;
    this.inv.removeCoinSet(name);
  }

  // ===================== Issuers =====================

  protected readonly issuerKinds = ISSUER_KINDS;
  protected readonly issuerNameMaxLength = ISSUER_NAME_MAX_LENGTH;
  protected readonly issuerDraft = signal<IssuerDraft>(blankIssuerDraft());
  protected readonly issuerError = signal<string>('');

  /** Patch one field of the draft without the template rebuilding the object. */
  protected setIssuerField(field: keyof IssuerDraft, value: string): void {
    this.issuerDraft.set({ ...this.issuerDraft(), [field]: value });
    this.issuerError.set('');
  }

  /**
   * Create an issuer the seed missed.
   *
   * This is the manual path and the whole of it. An optional online lookup to
   * seed the issuer's denominations is deliberately NOT built — see the note
   * at the bottom of this file.
   */
  async addIssuerFromDraft(): Promise<void> {
    const existingNames = this.issuers().map((issuer) => issuer.name);
    const validated = validateIssuerDraft(this.issuerDraft(), existingNames);

    if (!validated.ok) {
      this.issuerError.set(validated.error);
      return;
    }

    try {
      const created = await firstValueFrom(this.api.createIssuer(validated.issuer));
      this.issuers.set([...this.issuers(), created]);
      this.issuerDraft.set(blankIssuerDraft());
      this.issuerError.set('');
      this.notifications.showInfo(`Added issuer: ${created.name}`);
    } catch (error) {
      // THE FORM IS NOT CLEARED. What the user typed is the only copy of it,
      // and throwing it away in the one situation where they need it again
      // is the worst possible moment to be tidy.
      this.issuerError.set(describeHttpError(error) || 'Could not add that issuer.');
    }
  }

  /**
   * Remove an issuer — refused outright while denominations point at it.
   *
   * The only refusal on this screen. `describeIssuerRemoval` carries the
   * argument: the delete is SOFT, so FK_Denominations_Issuer never fires,
   * and the denominations would silently reappear under "No issuer yet".
   */
  async removeIssuer(issuer: IssuerRecord): Promise<void> {
    const outcome = describeIssuerRemoval(issuer.name, issuer.denominationCount);
    if (!outcome.allowed) {
      this.issuerError.set(outcome.message);
      return;
    }
    if (!confirmAction(outcome.message)) return;

    try {
      await firstValueFrom(this.api.deleteIssuer(issuer.issuerId));
      this.issuers.set(this.issuers().filter((row) => row.issuerId !== issuer.issuerId));
      this.issuerError.set('');
    } catch (error) {
      this.issuerError.set(describeHttpError(error) || 'Could not remove that issuer.');
    }
  }

  // ===================== Denominations =====================

  protected readonly denominationSearch = signal<string>('');
  protected readonly newDenominationLabel = signal<string>('');
  protected readonly newDenominationIssuerId = signal<number | null>(null);
  protected readonly denominationError = signal<string>('');

  /** Issuer headings the user has folded away. Keyed by heading text. */
  protected readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  /**
   * The denominations, grouped under their issuers and filtered by the
   * search box.
   *
   * The in-use count is folded in HERE rather than in the template, so the
   * group totals that `groupDenominations` computes are the same numbers the
   * rows show. A template that looked each one up separately would let the
   * heading and its rows disagree the first time either changed.
   */
  protected readonly denominationGroups = computed(() => {
    const counts = this.usage().denominations;
    const rows: MaintenanceDenomination[] = this.inv.denominations().map((denomination) => ({
      denominationId: denomination.denominationId,
      issuerId: denomination.issuerId ?? null,
      label: denomination.label,
      sortOrder: denomination.sortOrder,
      inUseCount: usageCount(counts, denomination.denominationId),
    }));

    return groupDenominations(rows, this.issuers(), this.denominationSearch());
  });

  /** How many rows are on screen, for the "showing N of M" line. */
  protected readonly visibleDenominationCount = computed(() =>
    this.denominationGroups().reduce((sum, group) => sum + group.denominations.length, 0)
  );

  protected isCollapsed(heading: string): boolean {
    // While a search is running nothing is collapsed, whatever the user
    // folded away earlier. Hiding a result because its group happened to be
    // closed would make the search silently incomplete, which is worse than
    // ignoring a preference.
    if (this.denominationSearch().trim().length > 0) return false;
    return this.collapsedGroups().has(heading);
  }

  protected toggleGroup(heading: string): void {
    const next = new Set(this.collapsedGroups());
    if (!next.delete(heading)) next.add(heading);
    this.collapsedGroups.set(next);
  }

  /**
   * Add a denomination under a chosen issuer.
   *
   * THE ISSUER IS REQUIRED here. The server accepts a null one, because the
   * editor path sends none and the column is nullable, but this screen does
   * not offer that: a row added with no issuer lands in "No issuer yet" at
   * the bottom of a list of over a thousand, effectively lost.
   */
  async addDenominationFromDraft(): Promise<void> {
    const label = this.newDenominationLabel().trim();
    const issuerId = this.newDenominationIssuerId();

    if (!label) {
      this.denominationError.set('Type the denomination first, for example "8 Reales".');
      return;
    }
    if (issuerId === null) {
      this.denominationError.set('Choose an issuer. Every denomination belongs to one.');
      return;
    }

    // At the end of the list, with a gap of 10 so a later entry can be
    // slotted between two without renumbering the thousand rows after it.
    const maxSortOrder = Math.max(0, ...this.inv.denominations().map((d) => d.sortOrder));
    const issuerName = this.issuers().find((issuer) => issuer.issuerId === issuerId);

    await this.inv.addDenomination({
      label,
      // Country is kept in step with the issuer because the coin editor's
      // dropdown still groups by country. Leaving it blank would make the new
      // row invisible there.
      country: issuerName?.isoCode ?? issuerName?.name ?? '',
      issuerId,
      sortOrder: maxSortOrder + 10,
      isActive: true
    });

    // The LABEL clears and the ISSUER does not. Filling in a new issuer is a
    // batch job — six denominations in a row — and re-picking the issuer
    // each time is both tedious and a chance to pick the wrong one silently.
    this.newDenominationLabel.set('');
    this.denominationError.set('');
  }

  /**
   * Remove a denomination.
   *
   * The count comes from the same query set that the server's DELETE then
   * acts on, so the number in the dialog is the number of coins that get
   * unlinked. Their `denomination` TEXT is untouched — only the
   * `denominationId` link is cleared, which is an ordinary state for a coin
   * to be in. `planDenominationRemoval` spells out in the prompt what those
   * coins will read afterwards, using `denominationDisplay()`, which is the
   * only place that string may be built.
   */
  async removeDenomination(denomination: { denominationId: number; label: string }): Promise<void> {
    const plan = planDenominationRemoval(denomination, this.denominationUsage(denomination.denominationId));
    if (!confirmAction(plan.prompt)) return;

    await this.inv.removeDenomination(plan.denominationId);

    // The counts just changed by exactly `plan.coinCount`. Leaving the old
    // numbers on screen would make the NEXT decision on this dialog a wrong
    // one.
    await this.refreshUsage();
  }

  /*
   * UNLINKED COINS
   *
   * A coin whose `denomination` text never resolved to a row — or whose
   * `denominationId` was cleared when that row was deleted — reads as
   * `Other (8 Reales)` with no route to a fix. This pane is that route. It is
   * not a one-off migration aid: removing a denomination puts coins back into
   * this state, so it stays useful indefinitely.
   *
   * ALL OF THE THINKING IS IN THE PURE MODULE.
   * services/denominations/unlinked-denominations.ts classifies, groups and
   * plans; this is signals and the order things happen in. In particular
   * NOTHING here decides what to write: the payloads come out of
   * `planUnlinkedFix`, which goes through the editor's own
   * `denominationChoiceUpdates`, so a coin fixed here and the same coin fixed
   * in the editor come out byte-identical.
   */

  /**
   * Who needs attention, recomputed from the live inventory.
   *
   * A computed rather than a snapshot, deliberately: the moment a bulk fix
   * lands, `inv.inventory()` changes and the group disappears from the
   * screen on its own. A snapshot would leave the user looking at a group
   * they have just emptied, with an Apply button that would do it again.
   */
  protected readonly unlinkedCensus = computed(() =>
    censusUnlinkedDenominations(
      this.inv.inventory(),
      this.inv.denominations(),
      (coinId) => this.inv.isDraftCoin(coinId)
    )
  );

  /** The headline sentence, including the zero state. */
  protected readonly unlinkedSummary = computed(() => describeUnlinkedCensus(this.unlinkedCensus()));

  /** Which group is open. One at a time, so one set of controls serves all. */
  protected readonly selectedUnlinkedKey = signal<string | null>(null);
  protected readonly unlinkedChoiceId = signal<number | null>(null);
  protected readonly unlinkedSetCountry = signal(false);
  protected readonly unlinkedSearch = signal<string>('');
  protected readonly unlinkedBusy = signal(false);
  protected readonly unlinkedError = signal<string>('');

  protected readonly selectedUnlinkedGroup = computed<UnlinkedGroup | null>(
    () =>
      this.unlinkedCensus().groups.find((group) => group.key === this.selectedUnlinkedKey()) ?? null
  );

  /**
   * Open a group, or close it again.
   *
   * *** EVERY SELECTION RESETS THE CHOICE. *** A sticky denomination id is a
   * bulk write to the wrong group: pick Mexico's 8 Reales, click the next
   * group, press Apply, and a pile of unrelated coins are silently linked to
   * an 8 Reales. The same goes for the country tick-box, which is the more
   * destructive of the two.
   */
  selectUnlinkedGroup(key: string): void {
    this.selectedUnlinkedKey.set(this.selectedUnlinkedKey() === key ? null : key);
    this.unlinkedChoiceId.set(null);
    this.unlinkedSetCountry.set(false);
    this.unlinkedSearch.set('');
    this.unlinkedError.set('');

    /* ONE ANSWER MEANS IT IS PRE-SELECTED. That is the 'resolvable' group,
     * where the app already knows the answer and making the user find it
     * again in a thousand-odd rows is busywork.
     *
     * AN AMBIGUOUS GROUP IS NEVER PRE-SELECTED, however tempting the first
     * candidate looks. The entire reason it is in that group is that the app
     * must not choose, and a pre-filled select is a choice the user can press
     * straight past without noticing they made it.
     *
     * Either way nothing is written until they press Link AND confirm a
     * dialog naming the label, so a coin only ever gets a denomination the
     * user explicitly chose.
     */
    const group = this.selectedUnlinkedGroup();
    if (group?.reason === 'resolvable' && group.choices.length === 1) {
      this.unlinkedChoiceId.set(group.choices[0].denominationId);
    }
  }

  /**
   * The full denomination list, type-ahead and all, for groups where the app
   * has nothing to suggest ('unknown' and 'nothing-recorded') or where the
   * user wants something other than the shortlist.
   *
   * It is the EDITOR'S picker, reused rather than rebuilt: the country bias,
   * the two rules from country-denomination-link.ts and the 200-row cap all
   * come with it. The bias country is the group's own, so the list opens on
   * the issuer the coins are filed under and the user can still search past
   * it.
   */
  protected readonly unlinkedPickerView = computed(() => {
    const group = this.selectedUnlinkedGroup();
    const base = denominationPickerBase(
      this.inv.denominations(),
      group?.countries[0] ?? '',
      null
    );
    return denominationPickerView(base, this.unlinkedSearch());
  });

  /**
   * Exactly what Apply would write — the same objects, not an estimate.
   *
   * Null only when no group is open. A plan with a `refusal` is a normal
   * state (nothing picked yet), which is why the button reads its message
   * from here rather than guessing.
   */
  protected readonly unlinkedPlan = computed(() => {
    const group = this.selectedUnlinkedGroup();
    if (!group) return null;
    return planUnlinkedFix(group, this.unlinkedChoiceId(), this.inv.denominations(), {
      setCountry: this.unlinkedSetCountry(),
    });
  });

  /** What the confirmation will ask, shown on the button's own line too. */
  protected readonly unlinkedPlanSummary = computed(() => {
    const plan = this.unlinkedPlan();
    return plan ? describeUnlinkedFixPlan(plan) : '';
  });

  protected unlinkedReasonText(reason: UnlinkedGroup['reason']): string {
    return describeUnlinkedReason(reason);
  }

  /**
   * The chosen id as the <select> carries it — a STRING, and '' for nothing.
   *
   * The same reason the editor's picker does it: `<option value>` is always
   * a string, and binding a number to it makes the control silently show
   * "(choose one)" while an id is in fact selected.
   */
  protected readonly unlinkedChoiceValue = computed(() => {
    const id = this.unlinkedChoiceId();
    return id === null ? '' : String(id);
  });

  protected setUnlinkedChoice(value: string): void {
    const id = Number(value);
    this.unlinkedChoiceId.set(Number.isFinite(id) && value !== '' ? id : null);
    this.unlinkedError.set('');
  }

  /**
   * Link every coin in the open group to the chosen denomination.
   *
   * SEQUENTIAL, through `updateCoinNow`. The debounced `updateCoin` keeps its
   * timer per coin, so a loop over a group would set every timer in the same
   * tick and fire every PUT in the same millisecond — see `runUnlinkedFix`
   * and `runPmBackfill`, which make the same argument at length.
   *
   * A failure does not stop the run and does not hide: the toast names the
   * coins that did not make it, because "linked 4 coins" after asking about
   * five leaves one silently broken.
   */
  async applyUnlinkedFix(): Promise<void> {
    const plan = this.unlinkedPlan();
    if (!plan) return;

    if (plan.refusal) {
      this.unlinkedError.set(plan.refusal);
      return;
    }

    if (!confirmAction(describeUnlinkedFixPlan(plan))) return;

    this.unlinkedBusy.set(true);
    this.unlinkedError.set('');
    try {
      const outcome = await runUnlinkedFix(plan, (coinId, updates) =>
        this.inv.updateCoinNow(coinId, updates).then(() => undefined)
      );

      const message = describeUnlinkedFixOutcome(outcome, plan.denominationLabel);
      if (outcome.failed > 0) {
        this.notifications.showError(message);
      } else {
        this.notifications.showInfo(message);
      }

      // The group has emptied (or shrunk). Close it rather than leave an
      // Apply button pointed at coins that are no longer in it.
      this.selectedUnlinkedKey.set(null);
      this.unlinkedChoiceId.set(null);
      this.unlinkedSetCountry.set(false);
      this.unlinkedSearch.set('');

      // Those coins now count against a denomination they did not before, and
      // the in-use badges are what the next Remove dialog will quote.
      await this.refreshUsage();
    } finally {
      this.unlinkedBusy.set(false);
    }
  }

  /**
   * The 'unknown' fix: go and add the denomination that is missing.
   *
   * The label is carried across pre-filled. Dumping the user on an empty add
   * form and making them retype a spelling that was on the previous screen is
   * how `Trade Dollarr` ends up in the reference list permanently.
   *
   * The issuer is deliberately NOT guessed. Nothing here knows which issuer
   * struck it — that is the entire reason the text did not resolve — and
   * `addDenominationFromDraft` already refuses to save without one.
   */
  addMissingDenomination(group: UnlinkedGroup): void {
    this.newDenominationLabel.set(group.recordedTexts[0] ?? '');
    this.denominationError.set('');
    this.selectSection('denominations');
  }

  // ===================== Mint marks =====================

  protected readonly newMintMarkLabel = signal<string>('');
  protected readonly newMintMarkDescription = signal<string>('');

  async addMintMarkFromDraft(): Promise<void> {
    const label = this.newMintMarkLabel().trim();
    const description = this.newMintMarkDescription().trim();
    if (!label) return;

    await this.inv.addMintMark({
      label,
      // The label is a reasonable description of itself. Requiring both made
      // the form refuse silently when only the mark was typed, which is the
      // common case for a one-letter mint.
      description: description || label,
      isActive: true
    });

    this.newMintMarkLabel.set('');
    this.newMintMarkDescription.set('');
  }

  async removeMintMark(mintMark: { mintMarkId: number; label: string }): Promise<void> {
    const plan = planReferenceRemoval('mint mark', mintMark.label, this.mintMarkUsage(mintMark.label));
    if (!confirmAction(plan.prompt)) return;
    await this.inv.removeMintMark(mintMark.mintMarkId);
  }

  // ===================== Catalogues =====================

  protected readonly newCatalogName = signal<string>('');

  async addCatalogFromDraft(): Promise<void> {
    const name = this.newCatalogName().trim();
    if (!name) return;

    // No sortOrder is sent: the server puts a new catalogue at the END of
    // the picker (MAX(SortOrder) + 1), computed in SQL so two tabs cannot
    // both claim the same slot.
    await this.inv.addCatalog({ name, isActive: true });
    this.newCatalogName.set('');
  }

  /**
   * Rename a catalogue IN PLACE, keeping its id.
   *
   * RENAME EXISTS HERE AND NOT FOR CATEGORIES, SETS OR MINT MARKS, because
   * those are referenced by their TEXT — remove-and-re-add IS a rename for
   * them. A catalogue is referenced BY ID, so remove-and-re-add would
   * silently orphan every coin attributed to it.
   *
   * A blank or unchanged name is ignored rather than saved: `prompt` returns
   * null on cancel, and writing that would blank the name on every coin
   * pointing at the row.
   */
  async renameCatalog(catalogId: number, currentName: string): Promise<void> {
    const next = typeof window !== 'undefined' && window.prompt
      ? window.prompt('Rename catalogue', currentName)
      : null;
    if (next === null) return;

    const trimmed = next.trim();
    if (!trimmed || trimmed === currentName) return;

    await this.inv.renameCatalog(catalogId, trimmed);
  }

  /**
   * Remove a catalogue.
   *
   * SOFT on the server (IsActive = 0): coins attributed to it keep their
   * attribution and keep reading "Sear 6819" in the grid; the catalogue
   * simply stops being offered in the editor's picker.
   */
  async removeCatalog(catalog: { catalogId: number; name: string }): Promise<void> {
    const plan = planReferenceRemoval('catalogue', catalog.name, this.catalogUsage(catalog.catalogId));
    if (!confirmAction(plan.prompt)) return;
    await this.inv.removeCatalog(catalog.catalogId);
  }
}

/*
 * THE ONLINE ISSUER LOOKUP IS DELIBERATELY NOT BUILT.
 *
 * The idea is to seed a newly added issuer's denominations from an open
 * numismatic dataset instead of handing the user an empty list. It stops at
 * the manual path above for three reasons, in increasing order of weight:
 *
 * 1. IT IS EXPECTED TO FAIL FOR THE COMMON CASE. Nomisma's open datasets
 *    cover ancient and Hellenistic issuers well and modern world coinage
 *    essentially not at all — it would succeed for Parthia and fail for
 *    Burma. A collector adding a modern country the seed missed is the
 *    failing case.
 *
 * 2. THE ENDPOINT IS UNPROVEN. numismatics.org answers HTTP 403 to automated
 *    requests; Nomisma's SPARQL endpoint is the only realistic route and has
 *    never been exercised with a real query.
 *
 * 3. IT COULD NOT BE VERIFIED, AND THAT IS DECISIVE. A lookup whose correct
 *    behaviour is "returns nothing, and that is not an error" is
 *    indistinguishable from one that is broken, or one that was never wired
 *    up. A visible blank beats a silently wrong value; an untested silent
 *    failure path is the worst of both.
 *
 * IF IT IS BUILT, nothing above needs rewriting: `addIssuerFromDraft` creates
 * the issuer and returns, so a lookup hangs off the end of the `try` block as
 * a second, independent step that cannot block or fail the creation. It must
 * also record PROVENANCE, so the user can tell which denominations they
 * vouched for themselves — that means a column and therefore a migration, so
 * it is a separate change rather than an addition to this file.
 */
