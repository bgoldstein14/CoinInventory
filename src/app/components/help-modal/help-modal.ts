import { Component, output } from '@angular/core';

/**
 * The Help screen opened by the toolbar's help icon: a short guide to the
 * toolbar, then "Report a problem", then the author and a small support note.
 * The support note appears only here and is never shown as a prompt.
 */
@Component({
  selector: 'app-help-modal',
  standalone: true,
  imports: [],
  templateUrl: './help-modal.html',
  styleUrl: './help-modal.scss',
})
export class HelpModal {
  readonly closed = output<void>();

  /**
   * "Report a problem": the shell closes this screen and opens the problem
   * reporter, so two dialogs are never stacked.
   */
  readonly reportProblemRequested = output<void>();

  protected close(): void {
    this.closed.emit();
  }

  protected reportProblem(): void {
    this.reportProblemRequested.emit();
  }
}
