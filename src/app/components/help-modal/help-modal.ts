import { Component, output } from '@angular/core';

/**
 * HelpModal — what the toolbar's help icon opens.
 *
 * WHY THIS EXISTS AT ALL, GIVEN THE HELP BUTTON ALREADY WENT SOMEWHERE
 *
 * The toolbar's "? Help" used to open the problem reporter directly. That was
 * a reasonable shortcut while "report a problem" was the only thing help
 * meant, but it made the label a small lie: a control called Help that can
 * only do one thing is mislabelled, and the one thing it did was a form.
 *
 * It also left nowhere to put anything else. Two things now have to live at
 * the foot of a help screen — who wrote this, and the fact that it is free —
 * and NEITHER OF THEM BELONGS IN THE PROBLEM REPORTER:
 *
 *   1. The reporter is a two-step task flow (describe -> done). "At the foot
 *      of the screen" is not a place there: it is either under the Save
 *      button on step one or on the receipt on step two, and it would move
 *      under the user mid-task.
 *
 *   2. The reporter is reached at the one moment when something has just gone
 *      wrong. A note about sending the author a few dollars, shown to
 *      somebody whose import just failed, reads as a solicitation however
 *      gently it is worded. The requirement is that the note is never a
 *      prompt — that it is only ever found by someone who went looking — and
 *      the bug form is the one screen in the app where the user did not
 *      choose the moment.
 *
 *   3. Not touching support-modal is itself worth something. Its redaction,
 *      the canaries that guard it, the "Include recent log" checkbox and the
 *      placeholder-repo behaviour were reworked twice this week. A change
 *      that cannot reach them cannot break them.
 *
 * So: a separate screen. REPORT A PROBLEM WAS THE FIRST THING ON IT and is
 * now the second, which is a reversal and not a drift. The first version put
 * the reporter at the top on the argument that it is the most useful control
 * here and that it is what the old button did. The owner looked at it and
 * decided the screen should read as help first and a bug form second: guide
 * information, a rule, then the report section with space above it. That
 * argument is settled — do not re-promote the reporter on the old reasoning.
 *
 * The old route survives the change. This screen is short and nobody arrives
 * at it by accident; someone who learned to press the help icon for the bug
 * form still presses the same icon and finds the button one rule further
 * down, with no tab, no scroll on any reasonable window and no second click.
 *
 * The author block and the support note sit at the bottom, below everything
 * functional, which is the ordering the owner asked for and also the only
 * honest one.
 *
 * THE SUPPORT NOTE IS A FOOTNOTE AND MUST STAY ONE.
 * Free comes first and without conditions, because nobody should close this
 * screen wondering whether some feature is behind a payment. The note is set
 * in small, muted type, it is not a button, it is not coloured to compete
 * with the app's own controls, and the handle is plain selectable text rather
 * than a link — there is no URL here that could go stale or send somebody
 * somewhere they did not expect. It appears on this screen and on no other,
 * on no timer, and never as a prompt.
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
   * "Report a problem" — the shell closes this screen and opens the problem
   * reporter. Two dialogs stacked on top of each other would leave the user
   * with two backdrops and two × buttons, so help gets out of the way.
   */
  readonly reportProblemRequested = output<void>();

  protected close(): void {
    this.closed.emit();
  }

  protected reportProblem(): void {
    this.reportProblemRequested.emit();
  }
}
