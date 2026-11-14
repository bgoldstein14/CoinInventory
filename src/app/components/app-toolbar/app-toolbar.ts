import { Component, input, output, signal } from '@angular/core';

/**
 * What the Import menu can bring in.
 *
 * DECLARED IN MENU ORDER, commonest first, and `csv` is first because it is
 * also the split button's default action. Nothing reads this order — the
 * menu is written out longhand in the template — so it is kept in step
 * purely so that the two cannot tell different stories to the next reader.
 *
 * 'images' is the odd one out and deliberately so: the other three read a FILE
 * of coin records, while this one reads a FOLDER of photographs and matches
 * them to coins that already exist. It belongs on the same menu anyway,
 * because from the user's point of view "bring my photos in" is an import like
 * any other.
 */
export type ImportKind = 'csv' | 'json' | 'qif' | 'images';

/** The three shapes the inventory can be exported to. */
export type ExportKind = 'csv' | 'json' | 'insurance';

/**
 * AppToolbar — the action buttons in the top-right of the page header:
 * "Add Coin", the Import split-button, the Export split-button and "Settings".
 *
 * The only state here is "is one of the dropdown menus open". Everything the
 * buttons actually *do* (open a modal, write a file) belongs to the App
 * shell, so this component just reports what the user picked.
 *
 * A "split button" is the main button plus a little ▾ that opens a menu of
 * alternatives; clicking the main button performs the default action.
 *
 * EACH SPLIT BUTTON'S DEFAULT IS ITS FIRST MENU ENTRY. Import defaults to
 * 'csv' and Export to 'csv', both matching the top of their own menus. The
 * Import default used to be 'qif', which meant the plain Import button ran
 * the least-wanted importer — the one case where pressing the obvious
 * button was the wrong answer.
 */
@Component({
  selector: 'app-toolbar',
  imports: [],
  templateUrl: './app-toolbar.html',
  styleUrl: './app-toolbar.scss'
})
export class AppToolbar {
  /** Highlights the Settings button while the settings modal is open. */
  readonly settingsOpen = input.required<boolean>();

  readonly addCoinRequested = output<void>();
  readonly importSelected = output<ImportKind>();
  readonly exportSelected = output<ExportKind>();
  readonly settingsRequested = output<void>();

  /**
   * "Help > Report a problem".
   *
   * On the toolbar rather than buried in Settings because the moment it is
   * needed is the moment something has just gone wrong, and a user who
   * cannot find it will close the app instead — at which point the recent
   * errors it would have carried are gone.
   */
  readonly helpRequested = output<void>();

  protected readonly importMenuOpen = signal(false);
  protected readonly exportMenuOpen = signal(false);

  /** Opening one dropdown always closes the other, so they can never overlap. */
  protected toggleImportMenu(): void {
    this.importMenuOpen.set(!this.importMenuOpen());
    this.exportMenuOpen.set(false);
  }

  protected toggleExportMenu(): void {
    this.exportMenuOpen.set(!this.exportMenuOpen());
    this.importMenuOpen.set(false);
  }

  protected handleImportSelection(kind: ImportKind): void {
    this.importMenuOpen.set(false);
    this.importSelected.emit(kind);
  }

  protected handleExportSelection(kind: ExportKind): void {
    this.exportMenuOpen.set(false);
    this.exportSelected.emit(kind);
  }

  /** Closes any open dropdown first, so the dialog never opens behind one. */
  protected requestHelp(): void {
    this.importMenuOpen.set(false);
    this.exportMenuOpen.set(false);
    this.helpRequested.emit();
  }
}
