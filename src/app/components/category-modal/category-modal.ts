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
import {
  IssuerCreationResult,
  IssuerRecord,
  ReferenceUsageCounts,
} from '../../types/reference-data.model';

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
  ALL_GROUPS_EXPANDED,
  GroupExpansion,
  applyExpandAllControl,
  describeExpandAllControl,
  expandGroup,
  focusGroup,
  isGroupExpanded,
  toggleGroup as toggleGroupExpansion,
} from './denomination-expansion';
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
  describeDenominationCount,
  describeIssuerRemoval,
  describeIssuerRemoved,
  describeIssuerRevived,
  describeLookupSkippedForRevival,
  issuerDraftFrom,
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
 * Reference-data maintenance screen: a sidebar of reference types, one pane each
 * (the panes are defined in reference-sections.ts).
 *
 * Logic lives in the pure modules beside this file so it can be tested without
 * rendering; this class is the wiring (signals, service calls, ordering).
 *
 * Removals use `confirmAction`, which fails open: these are buttons the user
 * pressed on purpose, so an environment without `window.confirm` should not
 * leave them dead.
 *
 * The issuer list is local state rather than an InventoryService signal because
 * nothing outside this dialog reads it.
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
   * Which pane to open on. A plain string resolved on read, so an unknown id
   * still opens a working pane.
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
   * Issuers sorted A-Z, used by the Issuers list and the Denominations issuer
   * select. Sorted client-side because newly added issuers are appended locally.
   */
  protected readonly sortedIssuers = computed(() => [...this.issuers()].sort(compareIssuersByName));

  /**
   * Active denominations per issuer, derived from `inv.denominations()` so the
   * count always matches the rows shown under the issuer's heading. Rows with no
   * issuer are skipped.
   */
  private readonly denominationCountByIssuer = computed(() => {
    const counts = new Map<number, number>();
    for (const denomination of this.inv.denominations()) {
      const issuerId = denomination.issuerId;
      if (issuerId === null || issuerId === undefined) continue;
      counts.set(issuerId, (counts.get(issuerId) ?? 0) + 1);
    }
    return counts;
  });

  /** The live denomination count for one issuer. */
  issuerDenominationCount(issuerId: number): number {
    return this.denominationCountByIssuer().get(issuerId) ?? 0;
  }

  /** The same figure, in words, for the row's badge. */
  issuerDenominationLabel(issuerId: number): string {
    return describeDenominationCount(this.issuerDenominationCount(issuerId));
  }

  /**
   * How many coins the cascade would touch if this issuer were removed: the sum
   * of live usage counts over the issuer's denominations.
   */
  issuerCoinCount(issuerId: number): number {
    let total = 0;
    for (const denomination of this.inv.denominations()) {
      if (denomination.issuerId !== issuerId) continue;
      total += this.denominationUsage(denomination.denominationId);
    }
    return total;
  }

  constructor() {
    void this.loadIssuers();
    void this.refreshUsage();
    void this.loadLookUpOnlinePreference();
  }

  /**
   * Set when the issuer fetch failed. With no issuers, every denomination falls
   * under "No issuer yet", so the panes show a banner rather than relying on a
   * toast that has already faded.
   */
  protected readonly issuerLoadFailed = signal(false);
  protected readonly issuerLoadError = signal<string>('');

  private async loadIssuers(): Promise<void> {
    try {
      this.issuers.set(await firstValueFrom(this.api.getIssuers()));
      this.issuerLoadFailed.set(false);
      this.issuerLoadError.set('');
    } catch (error) {
      // An empty issuer list still leaves the other panes usable, so the dialog
      // opens anyway. The toast reports the failure; the banner keeps showing it.
      this.notifications.showError(`Could not load issuers: ${describeHttpError(error)}`);
      this.issuers.set([]);
      this.issuerLoadFailed.set(true);
      this.issuerLoadError.set(describeHttpError(error));
    }
  }

  /** Retry the fetch from the banner. */
  protected async retryLoadIssuers(): Promise<void> {
    await this.loadIssuers();
  }

  /** Show the banner only on the panes the issuer list feeds. */
  protected readonly issuerListUnavailable = computed(
    () =>
      this.issuerLoadFailed() &&
      (this.activeSection() === 'issuers' || this.activeSection() === 'denominations')
  );

  /** Re-read the in-use counts (shown in badges and quoted by confirmations). */
  private async refreshUsage(): Promise<void> {
    try {
      this.usage.set(await firstValueFrom(this.api.getReferenceUsage()));
    } catch {
      // Non-fatal and silent: a missing badge doesn't stop list editing.
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

  /** The kind the year boxes imply, shown live beside them. */
  protected readonly derivedIssuerKind = computed(() => previewIssuerKind(this.issuerDraft()));

  /** Patch one text field of the draft. */
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
   * Turn the lookup on or off and persist it immediately, since the user may
   * close the dialog right after.
   */
  protected setLookUpOnline(value: boolean): void {
    this.issuerDraft.set({ ...this.issuerDraft(), lookUpOnline: value });
    void this.storage.set(StorageKeys.IssuerLookupOnline, value);
  }

  /** Restore the remembered preference; absent or invalid means the default. */
  private async loadLookUpOnlinePreference(): Promise<void> {
    const stored = await this.storage.get<boolean>(StorageKeys.IssuerLookupOnline);
    if (typeof stored !== 'boolean') return;
    this.issuerDraft.set({ ...this.issuerDraft(), lookUpOnline: stored });
  }

  /**
   * Create an issuer (or revive a removed one), then offer to fill its
   * denominations. The issuer is saved before the lookup runs, so a failed
   * lookup can't lose it.
   *
   * The duplicate check only sees active issuers; a removed name is sent to the
   * server, which revives it.
   */
  async addIssuerFromDraft(): Promise<void> {
    const draft = this.issuerDraft();
    const existingNames = this.issuers().map((issuer) => issuer.name);
    const validated = validateIssuerDraft(draft, existingNames);

    if (!validated.ok) {
      this.issuerError.set(validated.error);
      return;
    }

    let created: IssuerCreationResult;
    try {
      created = await firstValueFrom(this.api.createIssuer(validated.issuer));
    } catch (error) {
      // Keep the form filled so the user can fix and retry.
      this.issuerError.set(describeHttpError(error) || 'Could not add that issuer.');
      return;
    }

    this.issuers.set([...this.issuers(), created]);
    // Keep the lookup preference; it isn't part of this issuer.
    this.issuerDraft.set(blankIssuerDraft(draft.lookUpOnline));
    this.issuerError.set('');

    if (created.revived) {
      // Always tell the user their old issuer came back.
      this.notifications.showInfo(describeIssuerRevived(created.name, created.denominationsRestored ?? 0));
    }

    if (created.revived && (created.denominationsRestored ?? 0) > 0) {
      // Skip the lookup: the revived issuer already has denominations, and
      // duplicate labels under one issuer would make coin matching ambiguous.
      // Not routed through `settleOffline` so the revival toast isn't replaced.
      this.lookupIssuer.set(created);
      this.lookupProposals.set([]);
      this.lookupPhase.set('settled');
      this.lookupMessage.set(
        describeLookupSkippedForRevival(created.name, created.denominationsRestored ?? 0)
      );
      this.landOnIssuer(created);
      return;
    }

    // A revival with nothing restored is effectively a new issuer, so offer the lookup.
    await this.offerDenominations(created, draft.lookUpOnline);
  }

  /**
   * Look up the new issuer's denominations, unless the user opted out, in which
   * case no request is made at all.
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
      // Our own server unreachable; reported the same way as an unavailable source.
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
   * Show the Denominations pane with only this issuer's group expanded (others
   * collapsed, never filtered out) and the issuer preselected in the add form.
   */
  private landOnIssuer(issuer: IssuerRecord): void {
    this.newDenominationIssuerId.set(issuer.issuerId);
    this.denominationError.set('');
    // Group headings are issuer names.
    this.setGroupExpansion(focusGroup(issuer.name));
    this.selectSection('denominations');
  }

  /** Nothing to offer: say so, and put the user where they can type. */
  private settleOffline(issuer: IssuerRecord, message: string): void {
    this.lookupPhase.set('settled');
    this.lookupMessage.set(message);
    this.landOnIssuer(issuer);
    this.notifications.showInfo(message);
  }

  protected toggleProposal(label: string): void {
    this.lookupProposals.set(toggleProposal(this.lookupProposals(), label));
  }

  protected setAllProposals(chosen: boolean): void {
    this.lookupProposals.set(setAllProposals(this.lookupProposals(), chosen));
  }

  /**
   * Write the ticked proposals, and only those. Nothing is inserted without the
   * user choosing it.
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
          // Kept in step with the issuer: the editor's dropdown groups by country.
          country: issuer.isoCode ?? issuer.name,
          issuerId: issuer.issuerId,
          sortOrder,
          isActive: true,
        });
      }

      // No count to patch: `issuerDenominationCount` derives from the
      // denominations array that addDenomination already replaced.
    } finally {
      this.lookupBusy.set(false);
    }

    // Report the outcome, including zero.
    const outcome = describeDenominationsAdded(issuer.name, labels.length, this.lookupSource());
    this.notifications.showInfo(outcome);
    this.lookupMessage.set(outcome);
    this.lookupProposals.set([]);
    this.lookupPhase.set('settled');

    // Show the issuer's group open, others collapsed.
    this.landOnIssuer(issuer);
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

  // ===================== Editing an issuer =====================
  // Edits in place and keeps the id, since denominations reference issuers by id.
  /** Which row is open for editing, or null. One at a time. */
  protected readonly editingIssuerId = signal<number | null>(null);
  protected readonly issuerEditDraft = signal<IssuerDraft>(blankIssuerDraft(false));
  protected readonly issuerEditError = signal<string>('');
  protected readonly issuerEditBusy = signal(false);

  /**
   * The kind the edit form's years imply. The stored kind is the fallback,
   * matching the server's PUT behaviour for issuers with no year span.
   */
  protected readonly derivedIssuerEditKind = computed(() => {
    const id = this.editingIssuerId();
    const stored = this.issuers().find((row) => row.issuerId === id)?.kind ?? null;
    return previewIssuerKind(this.issuerEditDraft(), stored);
  });

  protected isEditingIssuer(issuerId: number): boolean {
    return this.editingIssuerId() === issuerId;
  }

  /** Open one row for editing, filled in with what it already says. */
  protected beginIssuerEdit(issuer: IssuerRecord): void {
    this.editingIssuerId.set(issuer.issuerId);
    this.issuerEditDraft.set(issuerDraftFrom(issuer));
    this.issuerEditError.set('');
  }

  protected setIssuerEditField(field: 'name' | 'isoCode' | 'validFrom' | 'validTo', value: string): void {
    this.issuerEditDraft.set({ ...this.issuerEditDraft(), [field]: value });
    this.issuerEditError.set('');
  }

  protected cancelIssuerEdit(): void {
    this.editingIssuerId.set(null);
    this.issuerEditError.set('');
  }

  /**
   * Save the edit. No `kind` is sent; the server derives it from the years and
   * keeps the stored value when they say nothing.
   */
  async saveIssuerEdit(): Promise<void> {
    const id = this.editingIssuerId();
    if (id === null || this.issuerEditBusy()) return;

    const current = this.issuers().find((row) => row.issuerId === id);
    if (!current) {
      this.cancelIssuerEdit();
      return;
    }

    // Exclude this issuer's own name so changing only its capitalisation is allowed.
    const otherNames = this.issuers()
      .filter((row) => row.issuerId !== id)
      .map((row) => row.name);

    const validated = validateIssuerDraft(this.issuerEditDraft(), otherNames);
    if (!validated.ok) {
      this.issuerEditError.set(validated.error);
      return;
    }

    this.issuerEditBusy.set(true);
    try {
      const updated = await firstValueFrom(this.api.updateIssuer(id, validated.issuer));

      // Merge over the existing row: PUT returns only the columns it wrote
      // (no sortOrder or counts). The id is pinned to the edited row.
      this.issuers.set(
        this.issuers().map((row) => (row.issuerId === id ? { ...row, ...updated, issuerId: id } : row))
      );
      this.editingIssuerId.set(null);
      this.issuerEditError.set('');
      this.notifications.showInfo(
        current.name === validated.issuer.name
          ? `Saved "${validated.issuer.name}".`
          : `Renamed "${current.name}" to "${validated.issuer.name}".`
      );
    } catch (error) {
      // Keep the row open so the user can fix the input (e.g. a 409 duplicate name).
      this.issuerEditError.set(describeHttpError(error) || 'Could not save that issuer.');
    } finally {
      this.issuerEditBusy.set(false);
    }
  }

  /**
   * Remove an issuer and, on the server, its denominations, after a confirmation
   * quoting the live denomination and coin counts.
   */
  async removeIssuer(issuer: IssuerRecord): Promise<void> {
    const plan = describeIssuerRemoval(
      issuer.name,
      this.issuerDenominationCount(issuer.issuerId),
      this.issuerCoinCount(issuer.issuerId)
    );

    if (!confirmAction(plan.message)) return;

    try {
      const outcome = await firstValueFrom(this.api.deleteIssuer(issuer.issuerId));
      this.issuers.set(this.issuers().filter((row) => row.issuerId !== issuer.issuerId));
      if (this.editingIssuerId() === issuer.issuerId) this.cancelIssuerEdit();
      this.issuerError.set('');

      // The cascade changed rows the client didn't name: reload denominations
      // (used app-wide) and the usage counts.
      await this.inv.loadDenominations();
      await this.refreshUsage();

      this.notifications.showInfo(describeIssuerRemoved(issuer.name, outcome));
    } catch (error) {
      this.issuerError.set(describeHttpError(error) || 'Could not remove that issuer.');
    }
  }

  // ===================== Denominations =====================

  protected readonly denominationSearch = signal<string>('');
  protected readonly newDenominationLabel = signal<string>('');
  protected readonly newDenominationIssuerId = signal<number | null>(null);
  protected readonly denominationError = signal<string>('');

  /**
   * Which issuer groups are open, stored as a default plus exceptions so
   * "collapse all" covers groups not currently on screen (see
   * denomination-expansion.ts). Local UI state; all writes go through
   * `setGroupExpansion`, which is the place to add persistence later.
   */
  protected readonly groupExpansion = signal<GroupExpansion>(ALL_GROUPS_EXPANDED);

  /** The single write point for expansion state. */
  private setGroupExpansion(next: GroupExpansion): void {
    this.groupExpansion.set(next);
  }

  /**
   * Denominations grouped under their issuers and filtered by the search box.
   * Usage counts are folded in here so group totals match the row badges.
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

  /** The headings on screen right now — what "all" means to the control. */
  protected readonly denominationHeadings = computed(() =>
    this.denominationGroups().map((group) => group.heading)
  );

  /**
   * The collapse/expand-all control, computed from the groups on screen: it
   * offers collapse while anything is open, expand once everything is shut.
   */
  protected readonly expandAllControl = computed(() =>
    describeExpandAllControl(this.groupExpansion(), this.denominationHeadings())
  );

  /** Collapse or expand every group, whichever the control is offering. */
  protected pressExpandAll(): void {
    this.setGroupExpansion(applyExpandAllControl(this.expandAllControl().action));
  }

  protected isCollapsed(heading: string): boolean {
    // Nothing is collapsed during a search, so results are never hidden.
    if (this.denominationSearch().trim().length > 0) return false;
    return !isGroupExpanded(this.groupExpansion(), heading);
  }

  protected toggleGroup(heading: string): void {
    this.setGroupExpansion(toggleGroupExpansion(this.groupExpansion(), heading));
  }

  /**
   * Add a denomination under a chosen issuer. The issuer is required here
   * (unlike the server) so new rows don't land in "No issuer yet".
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

    // Append with a gap of 10 so later entries can be slotted in without renumbering.
    const maxSortOrder = Math.max(0, ...this.inv.denominations().map((d) => d.sortOrder));
    const issuerName = this.issuers().find((issuer) => issuer.issuerId === issuerId);

    await this.inv.addDenomination({
      label,
      // Kept in step with the issuer: the coin editor's dropdown groups by country.
      country: issuerName?.isoCode ?? issuerName?.name ?? '',
      issuerId,
      sortOrder: maxSortOrder + 10,
      isActive: true
    });

    // Open the group the row landed in so the add is visibly applied.
    if (issuerName) {
      this.setGroupExpansion(expandGroup(this.groupExpansion(), issuerName.name));
    }

    // Clear the label but keep the issuer, for adding several in a row.
    this.newDenominationLabel.set('');
    this.denominationError.set('');
  }

  /**
   * Remove a denomination. Linked coins keep their denomination text; only the
   * `denominationId` link is cleared.
   */
  async removeDenomination(denomination: { denominationId: number; label: string }): Promise<void> {
    const plan = planDenominationRemoval(denomination, this.denominationUsage(denomination.denominationId));
    if (!confirmAction(plan.prompt)) return;

    await this.inv.removeDenomination(plan.denominationId);

    // Refresh counts so the next confirmation quotes the right number.
    await this.refreshUsage();
  }

  // ===================== Unlinked coins =====================
  // Coins whose denomination text never resolved to a row, or whose row was
  // deleted. Classification and payloads come from unlinked-denominations.ts.

  /**
   * Groups of unlinked coins, computed from the live inventory so a group
   * disappears as soon as it is fixed.
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

  /** Which group is open; one at a time. */
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
   * Open or close a group. Every selection resets the choice and the country
   * option so a previous pick can't be applied to the wrong group.
   */
  selectUnlinkedGroup(key: string): void {
    this.selectedUnlinkedKey.set(this.selectedUnlinkedKey() === key ? null : key);
    this.unlinkedChoiceId.set(null);
    this.unlinkedSetCountry.set(false);
    this.unlinkedSearch.set('');
    this.unlinkedError.set('');

    // Pre-select only when the app knows the single answer ('resolvable').
    // Ambiguous groups are never pre-selected; the user must choose.
    const group = this.selectedUnlinkedGroup();
    if (group?.reason === 'resolvable' && group.choices.length === 1) {
      this.unlinkedChoiceId.set(group.choices[0].denominationId);
    }
  }

  /**
   * Full denomination picker (the editor's, reused) for groups with no
   * suggestion, biased to the group's country.
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
   * Exactly what Apply would write. Null only when no group is open; a plan with
   * a `refusal` means nothing is picked yet.
   */
  protected readonly unlinkedPlan = computed(() => {
    const group = this.selectedUnlinkedGroup();
    if (!group) return null;
    return planUnlinkedFix(group, this.unlinkedChoiceId(), this.inv.denominations(), {
      setCountry: this.unlinkedSetCountry(),
    });
  });

  /** What the confirmation will ask, also shown beside the button. */
  protected readonly unlinkedPlanSummary = computed(() => {
    const plan = this.unlinkedPlan();
    return plan ? describeUnlinkedFixPlan(plan) : '';
  });

  protected unlinkedReasonText(reason: UnlinkedGroup['reason']): string {
    return describeUnlinkedReason(reason);
  }

  /**
   * The chosen id as a string ('' for none), because `<option value>` is always
   * a string and a number binding would show "(choose one)".
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
   * Link every coin in the open group to the chosen denomination. Updates run
   * sequentially via `updateCoinNow` (the debounced path would fire them all at
   * once); failures are reported in the toast.
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

      // Close the group; its coins have moved.
      this.selectedUnlinkedKey.set(null);
      this.unlinkedChoiceId.set(null);
      this.unlinkedSetCountry.set(false);
      this.unlinkedSearch.set('');

      // Refresh the in-use badges.
      await this.refreshUsage();
    } finally {
      this.unlinkedBusy.set(false);
    }
  }

  /**
   * The 'unknown' fix: open the Denominations pane with the label pre-filled.
   * The issuer is left for the user to choose.
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
      // Default the description to the label; often only the mark is typed.
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

  // ===================== Metal content =====================
  // Removing an entry only removes it from the dropdown; coins store metal as text.
  // TODO: /api/metalcontents is read-only, so these edits last only until reload.
  // Persisting them needs POST/DELETE on the server.

  protected readonly newMetalContent = signal<string>('');

  addMetalContentFromDraft(): void {
    const value = this.newMetalContent().trim();
    if (!value) return;

    // De-duplicated and sorted for the editor's dropdown.
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

    // The server assigns sortOrder (end of the list).
    await this.inv.addCatalog({ name, isActive: true });
    this.newCatalogName.set('');
  }

  /**
   * Rename a catalogue in place, keeping its id (coins reference catalogues by
   * id, unlike the text-keyed lists). Blank, unchanged or cancelled input is ignored.
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
   * Remove a catalogue. Soft delete on the server: coins keep their attribution;
   * the catalogue is no longer offered in the picker.
   */
  async removeCatalog(catalog: { catalogId: number; name: string }): Promise<void> {
    const plan = planReferenceRemoval('catalogue', catalog.name, this.catalogUsage(catalog.catalogId));
    if (!confirmAction(plan.prompt)) return;
    await this.inv.removeCatalog(catalog.catalogId);
  }
}
