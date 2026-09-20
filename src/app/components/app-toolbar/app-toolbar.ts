import { Component, input, output, signal } from '@angular/core';

/** The three file formats the inventory can be imported from. */
export type ImportKind = 'qif' | 'csv' | 'json';

/** The three shapes the inventory can be exported to. */
export type ExportKind = 'csv' | 'json' | 'insurance';

/**
 * AppToolbar — the action buttons in the top-right of the page header:
 * "Add Coin", the Import split-button, the Export split-button and "Settings".
 *
 * WHY THIS FILE EXISTS
 * The only real state here is "is one of the dropdown menus open", which is
 * pure presentation and of no interest to anybody else. Everything the buttons
 * actually *do* (open a modal, write a file) belongs to the App shell, so this
 * component simply reports what the user picked and lets App decide.
 *
 * A "split button" is the main button plus a little ▾ that opens a menu of
 * alternatives; clicking the main button performs the default action.
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
}
