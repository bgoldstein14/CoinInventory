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
import {
  MaintenanceDenomination,
  compareIssuersByName,
  groupDenominations,
} from './denomination-grouping';
import {
  EMPTY_REFERENCE_USAGE,
  describeUsage,
  planDenominationRemoval,
  planReferenceRemoval,
  usageCount,
} from './reference-usage';
import {
  ISSUER_NAME_MAX_LENGTH,
  IssuerDraft,
  blankIssuerDraft,
  describeIssuerRemoval,
  previewIssuerKind,
  validateIssuerDraft,
} from './issuer-draft';
import {
  DenominationLookupResult,
  DenominationProposal,
  LOOKUP_SOURCE,
  LookupPhase,
  chosenLabels,
  describeDenominationsAdded,
  describeLookupConsent,
  describeLookupDeclined,
  describeLookupInProgress,
  describeLookupOutcome,
  setAllProposals,
  toProposals,
  toggleProposal,
} from './issuer-lookup';
import { StorageKeys, StorageService } from '../../services/storage.service';

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
 *     issuer-kind.ts            the kind the year span implies
 *     issuer-lookup.ts          what the online lookup proposes, and what
 *                               the user is told about every outcome
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
  private readonly storage = inject(StorageService);
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

  /**
   * The issuers A-Z — what BOTH issuer-shaped controls on this screen
   * render: the Issuers pane's list, and the Denominations pane's "which
   * issuer" <select>.
   *
   * Sorted here and not only on the server. `GET /api/issuers` does order
   * by name now, but that is the wire, and this list is also written to
   * locally: `addIssuerFromDraft` appends the row the server just created
   * rather than re-fetching, so a new 'Burma' would otherwise sit at the
   * bottom under Württemberg — in the one list the user is looking at to
   * check their addition worked.
   *
   * A copy, because `.sort()` mutates and the array is signal state that
   * `denominationGroups` also reads.
   */
  protected readonly sortedIssuers = computed(() => [...this.issuers()].sort(compareIssuersByName));

  constructor() {
    void this.loadIssuers();
    void this.refreshUsage();
    void this.loadLookUpOnlinePreference();
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

  metalContentUsage(name: string): number {
    return usageCount(this.usage().metalContents, name);
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

  protected readonly issuerNameMaxLength = ISSUER_NAME_MAX_LENGTH;
  protected readonly issuerDraft = signal<IssuerDraft>(blankIssuerDraft());
  protected readonly issuerError = signal<string>('');

  /**
   * The kind the year boxes imply, shown live beside them.
   *
   * THIS IS WHY DROPPING THE PICKER IS NOT THE SAME AS HIDING A FIELD. The
   * user can still see the classification; they just do not have to state
   * it. Typing 1918 into "To" turns the tag from modern to historical in
   * front of them, which teaches the rule better than a select ever did.
   */
  protected readonly derivedIssuerKind = computed(() => previewIssuerKind(this.issuerDraft()));

  /** Patch one text field of the draft without the template rebuilding it. */
  protected setIssuerField(field: 'name' | 'isoCode' | 'validFrom' | 'validTo', value: string): void {
    this.issuerDraft.set({ ...this.issuerDraft(), [field]: value });
    this.issuerError.set('');
  }

  // ----- The online denomination lookup -----

  protected readonly lookupConsentLabel = describeLookupConsent(LOOKUP_SOURCE);
  protected readonly lookupPhase = signal<LookupPhase>('idle');
  protected readonly lookupMessage = signal<string>('');
  protected readonly lookupProposals = signal<DenominationProposal[]>([]);
  protected readonly lookupIssuer = signal<IssuerRecord | null>(null);
  protected readonly lookupSource = signal<string>(LOOKUP_SOURCE);
  protected readonly lookupBusy = signal<boolean>(false);

  protected readonly chosenProposalCount = computed(() => chosenLabels(this.lookupProposals()).length);

  /**
   * Turn the lookup on or off, and REMEMBER IT.
   *
   * A user who turns this off once means it. Written straight through
   * rather than on save, because the next thing they do after unticking it
   * might be to close the dialog.
   */
  protected setLookUpOnline(value: boolean): void {
    this.issuerDraft.set({ ...this.issuerDraft(), lookUpOnline: value });
    void this.storage.set(StorageKeys.IssuerLookupOnline, value);
  }

  /** Restore the remembered answer. Absent or unreadable means the default. */
  private async loadLookUpOnlinePreference(): Promise<void> {
    const stored = await this.storage.get<boolean>(StorageKeys.IssuerLookupOnline);
    if (typeof stored !== 'boolean') return;
    this.issuerDraft.set({ ...this.issuerDraft(), lookUpOnline: stored });
  }

  /**
   * Create an issuer the seed missed, then offer to fill it.
   *
   * THE TWO STEPS ARE SEPARATE AND THE SECOND CANNOT BREAK THE FIRST. The
   * issuer is created, pushed into the list and announced before anything
   * is asked of the network; the lookup then runs against a row that
   * already exists. A lookup that hangs, fails or returns nonsense cannot
   * cost the user the issuer they just typed.
   */
  async addIssuerFromDraft(): Promise<void> {
    const draft = this.issuerDraft();
    const existingNames = this.issuers().map((issuer) => issuer.name);
    const validated = validateIssuerDraft(draft, existingNames);

    if (!validated.ok) {
      this.issuerError.set(validated.error);
      return;
    }

    let created: IssuerRecord;
    try {
      created = await firstValueFrom(this.api.createIssuer(validated.issuer));
    } catch (error) {
      // THE FORM IS NOT CLEARED. What the user typed is the only copy of it,
      // and throwing it away in the one situation where they need it again
      // is the worst possible moment to be tidy.
      this.issuerError.set(describeHttpError(error) || 'Could not add that issuer.');
      return;
    }

    this.issuers.set([...this.issuers(), created]);
    // The checkbox survives the clear. It is a standing preference, not a
    // field of this particular issuer.
    this.issuerDraft.set(blankIssuerDraft(draft.lookUpOnline));
    this.issuerError.set('');

    await this.offerDenominations(created, draft.lookUpOnline);
  }

  /**
   * Ask about the new issuer's denominations — or, if refused, do not ask.
   *
   * *** UNTICKED MEANS NO REQUEST IS MADE. *** Not made-and-ignored. The
   * `return` below is the entire guarantee: there is nothing a route or a
   * response handler could do about a packet that has already left, so the
   * decision has to live at the call site and it has to be this early.
   */
  private async offerDenominations(issuer: IssuerRecord, lookUpOnline: boolean): Promise<void> {
    this.lookupIssuer.set(issuer);
    this.lookupProposals.set([]);

    if (!lookUpOnline) {
      this.settleOffline(issuer, describeLookupDeclined(issuer.name));
      return;
    }

    this.lookupPhase.set('asking');
    this.lookupBusy.set(true);
    this.lookupMessage.set(describeLookupInProgress(issuer.name, this.lookupSource()));

    let result: DenominationLookupResult;
    try {
      result = await firstValueFrom(this.api.lookUpDenominations(issuer.name));
    } catch {
      // Our OWN server being unreachable, which is a different failure from
      // the one the route reports, and reads the same to the user.
      result = { outcome: 'unavailable', source: this.lookupSource(), proposals: [], reason: 'no connection' };
    } finally {
      this.lookupBusy.set(false);
    }

    if (result.source) this.lookupSource.set(result.source);

    const proposals = toProposals(result.proposals ?? []);
    const message = describeLookupOutcome(issuer.name, result);

    if (proposals.length === 0) {
      this.settleOffline(issuer, message);
      return;
    }

    this.lookupProposals.set(proposals);
    this.lookupMessage.set(message);
    this.lookupPhase.set('proposing');
  }

  /**
   * Nothing to offer: say so, and put the user where they can type.
   *
   * The issuer is PRESELECTED in the denominations pane and the pane is
   * opened. "An issuer that silently has none is the current bug", and an
   * issuer that noisily has none but leaves the user to find the right
   * dropdown is most of the same bug.
   */
  private settleOffline(issuer: IssuerRecord, message: string): void {
    this.lookupPhase.set('settled');
    this.lookupMessage.set(message);
    this.newDenominationIssuerId.set(issuer.issuerId);
    this.denominationError.set('');
    this.selectSection('denominations');
    this.notifications.showInfo(message);
  }

  protected toggleProposal(label: string): void {
    this.lookupProposals.set(toggleProposal(this.lookupProposals(), label));
  }

  protected setAllProposals(chosen: boolean): void {
    this.lookupProposals.set(setAllProposals(this.lookupProposals(), chosen));
  }

  /**
   * Write the ticked proposals, and only those.
   *
   * `chosenLabels` is the ONLY route from a proposal to a row. Nothing
   * above this line writes, which is the "propose, never auto-insert" rule
   * expressed as code rather than as a comment.
   */
  async acceptProposals(): Promise<void> {
    const issuer = this.lookupIssuer();
    if (!issuer || this.lookupBusy()) return;

    const labels = chosenLabels(this.lookupProposals());
    this.lookupBusy.set(true);

    try {
      let sortOrder = Math.max(0, ...this.inv.denominations().map((row) => row.sortOrder));

      for (const label of labels) {
        sortOrder += 10;
        await this.inv.addDenomination({
          label,
          // Kept in step with the issuer, like the manual add path: the
          // editor's dropdown still groups by country, and a blank one
          // would make these rows invisible there.
          country: issuer.isoCode ?? issuer.name,
          issuerId: issuer.issuerId,
          sortOrder,
          isActive: true,
        });
      }

      this.issuers.set(
        this.issuers().map((row) =>
          row.issuerId === issuer.issuerId
            ? { ...row, denominationCount: row.denominationCount + labels.length }
            : row
        )
      );
    } finally {
      this.lookupBusy.set(false);
    }

    // ALWAYS STATED, INCLUDING ZERO: how many, and by what route.
    const outcome = describeDenominationsAdded(issuer.name, labels.length, this.lookupSource());
    this.notifications.showInfo(outcome);
    this.lookupMessage.set(outcome);
    this.lookupProposals.set([]);
    this.lookupPhase.set('settled');

    // Straight to the list the user now wants to check.
    this.newDenominationIssuerId.set(issuer.issuerId);
    this.selectSection('denominations');
    await this.refreshUsage();
  }

  /** Take none of them, and fall through to the manual route. */
  dismissProposals(): void {
    const issuer = this.lookupIssuer();
    if (!issuer) return;
    this.lookupProposals.set([]);
    this.settleOffline(issuer, describeDenominationsAdded(issuer.name, 0, this.lookupSource()));
  }

  /** Put the banner away. */
  protected clearLookup(): void {
    this.lookupPhase.set('idle');
    this.lookupMessage.set('');
    this.lookupProposals.set([]);
    this.lookupIssuer.set(null);
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

  /*
   * ===================== Metal content =====================
   *
   * MOVED HERE FROM THE SETTINGS DIALOG, WHICH NO LONGER EDITS ANY LIST.
   * Settings carried chip editors for categories, mint marks and sets as
   * well — second editors for lists this screen already owned, which is how
   * the two drifted. Metal content was the only one with no pane here, so
   * it was moved rather than deleted, and it gained what the Settings
   * version never had: the in-use count beside each entry and a
   * confirmation that quotes it.
   *
   * *** THE COIN KEEPS ITS METAL. *** `Coins.MetalContent` is an NVARCHAR
   * column, not a foreign key — removing an entry takes it out of the
   * editor's dropdown and changes no coin, which is exactly what
   * `planReferenceRemoval` promises. That is why this uses the general
   * wording and not `planDenominationRemoval`'s: there is no id to null and
   * nothing to re-link, so the denomination sentence would offer a recovery
   * step that does not exist here.
   *
   * *** THE ONE HONEST LIMITATION, CARRIED OVER UNCHANGED. ***
   * `/api/metalcontents` is READ-ONLY (the list is seeded by
   * setup-database.sql), so both methods below write the signal and nothing
   * else — an edit lasts until the next reload. That is precisely what the
   * Settings version did, so nothing has got worse by moving; it is noted
   * here, rather than left to be discovered, because every OTHER list on
   * this screen persists and the difference is invisible from the UI.
   * Giving MetalContents the POST/DELETE the other lookups have is the fix,
   * and it is a server change, not a change to this file.
   */

  protected readonly newMetalContent = signal<string>('');

  addMetalContentFromDraft(): void {
    const value = this.newMetalContent().trim();
    if (!value) return;

    // De-duplicated and sorted, as the Settings version did: the editor's
    // dropdown renders this list in order and a second 'Gold' in it is a
    // choice the user cannot tell apart from the first.
    const next = [...new Set([...this.inv.metalContents(), value])].sort((left, right) =>
      left.localeCompare(right)
    );
    this.inv.metalContents.set(next);
    this.newMetalContent.set('');
  }

  removeMetalContent(value: string): void {
    const plan = planReferenceRemoval('metal content', value, this.metalContentUsage(value));
    if (!confirmAction(plan.prompt)) return;
    this.inv.metalContents.set(this.inv.metalContents().filter((item) => item !== value));
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
 * THE ONLINE ISSUER LOOKUP, AND THE THREE OBJECTIONS IT HAD TO ANSWER
 *
 * This note used to say the lookup was deliberately NOT built. It is built
 * now, on the owner's decision, and the three reasons it was refused are
 * worth keeping because each one shaped what got built:
 *
 * 1. "IT IS EXPECTED TO FAIL FOR THE COMMON CASE." Still true, and now
 *    measured rather than predicted: Wikidata answered with nothing for
 *    Athens, one candidate for Parthia, four for Burma and nine for Japan.
 *    What changed is that a miss is no longer a dead end. The answer to a
 *    miss was the OTHER half of this piece of work -- eight researched
 *    ancient issuers added to the bundled seed -- plus the offline path
 *    below, which names the outcome and drops the user into the
 *    denominations pane with the issuer already chosen.
 *
 * 2. "THE ENDPOINT IS UNPROVEN." It is proven now. numismatics.org still
 *    answers 403 to automated requests; Wikidata's SPARQL endpoint was
 *    exercised with real queries, and the first query written for it timed
 *    out (HTTP 504 after 65 seconds) on 'Burma'. That failure is why the
 *    query in server/routes/lookups/wikidata-denominations.ts is shaped
 *    the way it is, and why there is a hard 8-second timeout behind it.
 *
 * 3. "IT COULD NOT BE VERIFIED, AND THAT IS DECISIVE." This was the real
 *    objection and it is the one that is actually answered:
 *    server/routes/lookups/denomination-lookup.spec.ts exercises a dead
 *    network, a timeout, a 504, a body that is not JSON and a body of the
 *    wrong shape, with the fetch swapped out, so the suite does not depend
 *    on a third party being up. A path whose correct behaviour is "returns
 *    nothing, and that is not an error" is no longer indistinguishable
 *    from a broken one.
 *
 * WHAT IS STILL NOT BUILT, AND WHY THAT IS NOW FINE
 *
 * PROVENANCE. The old note required a column recording which denominations
 * came from a lookup, so the user could tell which ones they had vouched
 * for themselves. There is no such column and none is needed, because
 * NOTHING IS WRITTEN WITHOUT THE USER TICKING IT. Every row that reaches
 * the database went through `chosenLabels`, so the answer to "which of
 * these did I vouch for" is "all of them" by construction. Had the lookup
 * auto-inserted, the column would have been mandatory.
 */
