import { Component, input, output, signal } from '@angular/core';

/**
 * What the Import menu can bring in, in menu order. 'excel' and 'csv' open the
 * same import dialog in different formats; 'images' imports a folder of photos
 * and matches them to existing coins. There is deliberately no JSON import
 * (JSON export remains).
 */
export type ImportKind = 'excel' | 'csv' | 'qif' | 'images';

/** The three shapes the inventory can be exported to. */
export type ExportKind = 'csv' | 'json' | 'insurance';

/**
 * Header action buttons: Add Coin, the Import and Export split buttons,
 * Settings and Help. Only tracks which dropdown is open; the App shell acts on
 * the emitted choices. Each split button's main face runs its first menu entry.
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

  /** Opens the Help screen (components/help-modal). */
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
