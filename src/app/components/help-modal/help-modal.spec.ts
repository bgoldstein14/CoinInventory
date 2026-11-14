/*
 * help-modal.spec.ts — the Help screen, and the three things about it that
 * are promises rather than preferences.
 *
 * WHY THE TEMPLATE AND THE STYLESHEET ARE READ AS TEXT. There is no jsdom in
 * this project's frontend suite, so nothing here can be rendered. What this
 * screen SAYS and HOW LOUDLY it says it are nonetheless the whole point of
 * the item — the owner asked twice for the support note to be humble — and a
 * decision that lives only in markup and a font-size is a decision nothing is
 * holding. So the files are read and asserted against, the same way
 * app-toolbar.spec.ts holds the Import menu's ordering.
 *
 * *** COMMENTS ARE STRIPPED FIRST. *** Both files explain at length why the
 * note is small, why it is not a button and why the author block sits at the
 * bottom. Every one of those sentences contains the words an assertion would
 * look for. Asserting against the raw text would match the explanation and
 * pass with the markup deleted.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The template with comments removed, and `&#64;` turned back into `@`.
 *
 * The entity is not decoration: a bare `@` in an Angular template starts a
 * control-flow block, so `@bgoldstein14` is a compile error and the handle
 * has to be written escaped. Decoding it here means the assertions below can
 * talk about the handle the user actually sees.
 */
function template(): string {
  return readFileSync(join(__dirname, 'help-modal.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/&#64;/g, '@');
}

/** The stylesheet with both comment styles removed. */
function styles(): string {
  return readFileSync(join(__dirname, 'help-modal.scss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The body of one top-level rule, e.g. ruleBody('.help-support-note'). */
function ruleBody(selector: string): string {
  const pattern = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`);
  const match = styles().match(pattern);
  expect(match, `${selector} is missing from help-modal.scss`).toBeTruthy();
  return match![1];
}

/** A `font-size: 0.72rem` declaration, as a number of rem. */
function fontSizeRem(selector: string): number {
  const match = ruleBody(selector).match(/font-size:\s*([\d.]+)rem/);
  expect(match, `${selector} declares no font-size in rem`).toBeTruthy();
  return Number(match![1]);
}

/** The markup of one element, opening tag through closing tag. */
function element(tag: string, className: string): string {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>[\\s\\S]*?</${tag}>`
  );
  const match = template().match(pattern);
  expect(match, `no <${tag} class="... ${className} ..."> in help-modal.html`).toBeTruthy();
  return match![0];
}

describe('HelpModal — help first, bug form second', () => {
  it('offers "Report a problem", because that is what the help icon used to do', () => {
    /* The icon opened the problem reporter directly before this screen
     * existed. Anyone who learned that route presses the same icon and must
     * find the reporter in what opens — otherwise this change took a
     * working path away and gave back a page of prose. It is no longer the
     * first thing on the screen (see below), but it is still ON it, one
     * rule down, with nothing to expand and nowhere to scroll. */
    expect(template()).toMatch(/\(click\)="reportProblem\(\)"[\s\S]*?>\s*Report a problem\s*</);
  });

  it('puts the guide above the report section, with a rule between them', () => {
    /* THE REVERSAL THIS PINS, AND IT IS A REVERSAL. The report section
     * shipped at the top of this screen on the argument that it is the most
     * useful control here. The owner looked at it and decided otherwise:
     * "Don't put the report issue on the top of the Help box; give some
     * space below the guide information; maybe a line or dashes and then
     * the report issue part."
     *
     * So the direction of this assertion is the whole point. An innocent
     * tidy-up that moves the reporter back to the top — and the old
     * reasoning is still a persuasive comment in the git history — is the
     * failure this catches. */
    const markup = template();
    const guide = markup.indexOf('The buttons along the top');
    const separator = markup.indexOf('help-separator');
    const report = markup.indexOf('Something not working?');
    const action = markup.indexOf('reportProblem()');

    expect(guide, 'the guide section is missing').toBeGreaterThan(-1);
    expect(separator, 'a rule marks the end of the guide').toBeGreaterThan(guide);
    expect(report, 'and the report section comes after the rule').toBeGreaterThan(separator);
    expect(action).toBeGreaterThan(report);
  });

  it('draws that separator as a real rule with real space around it', () => {
    /* "Maybe a line or dashes and then the report issue part", plus "give
     * some space below the guide information" — two requirements, and the
     * second is the one a hairline tucked against the next heading would
     * miss. The rule has to be visible AND to have air on both sides of it,
     * otherwise it reads as a border on the report section rather than as
     * the end of the guide. */
    expect(template(), 'an <hr>, not a styled border on the section below')
      .toMatch(/<hr\b[^>]*class="[^"]*\bhelp-separator\b/);

    const rule = ruleBody('.help-separator');
    expect(rule, 'the line has to be drawn').toMatch(/border-top:\s*1px solid #[0-9a-f]{6}/i);
    expect(rule, 'with space above it, beyond the body gap').toMatch(/margin:\s*[\d]+px/);
    expect(ruleBody('.help-report'), 'and space below it too').toMatch(/padding-top:\s*[\d]+px/);
  });

  it('keeps the author block and the support note below everything functional', () => {
    /* Unchanged by the reorder, and worth re-asserting because of it: who
     * wrote this and the fact that it is free stay at the very bottom, under
     * the report section wherever the report section ends up. */
    const markup = template();
    const report = markup.indexOf('reportProblem()');
    const author = markup.indexOf('Author: Bruce Goldstein');
    const note = markup.indexOf('help-support-note');

    expect(report).toBeGreaterThan(-1);
    expect(author).toBeGreaterThan(report);
    expect(note).toBeGreaterThan(author);
  });
});

describe('HelpModal — the author block', () => {
  it('names the author and the ANA number, both of them', () => {
    /* Two lines, and the second is the one that would quietly go missing in
     * a tidy-up: it looks like a reference number rather than content. It is
     * the credential that means something to the people this app is for. */
    const about = element('section', 'help-about');

    expect(about).toContain('Author: Bruce Goldstein');
    expect(about).toContain('ANA #: 3124621');
  });

  it('states it plainly, with no byline styling', () => {
    // Plain paragraphs. Not a heading, not an accent colour, not a badge.
    const about = element('section', 'help-about');
    expect(about).not.toMatch(/<h[1-6]\b/);
    expect(fontSizeRem('.help-author')).toBeLessThanOrEqual(0.9);
  });
});

describe('HelpModal — the support note is a footnote, not a pitch', () => {
  it('says the app is free first, and says it without a condition', () => {
    /* THE REQUIREMENT THIS PINS. Nobody should close this screen wondering
     * whether some feature is behind a payment, so "free" is not allowed to
     * arrive after the handle, or hedged with a "but". */
    const note = element('p', 'help-support-note');
    const free = note.indexOf('free for everyone');
    const handle = note.indexOf('@bgoldstein14');

    expect(free, 'the note must say the app is free for everyone').toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(-1);
    expect(free, 'free is stated before any mention of money').toBeLessThan(handle);
  });

  it('closes warmly rather than with a shrug', () => {
    /* THE WORDING THIS PINS. The sentence used to end "...if not, enjoy it
     * anyway". The owner: "sounds a bit snide. Maybe something like
     * 'regardless...enjoy!' or something to that effect."
     *
     * He is right, and the word doing the damage is "anyway" — it concedes
     * something rather than offering it. The replacement has to let the
     * reader off the hook (that part was always correct) without sounding
     * resigned about it, and without reaching for an exclamation mark,
     * which the test below rules out for the whole note. */
    const note = element('p', 'help-support-note');

    expect(note, 'the shrug is gone').not.toMatch(/\banyway\b/i);
    expect(note, 'and the reader is still let off, warmly').toMatch(/either way/i);
  });

  it('is set smaller than the smallest explanatory text on the screen', () => {
    /* "Small type" was asked for twice and is not a stylistic preference.
     * `.hint-text` is 0.82rem in styles/_modal.scss; the note must be below
     * it, so it reads as a footnote and not as another paragraph. */
    expect(fontSizeRem('.help-support-note')).toBeLessThan(0.82);
  });

  it('is muted, and never in the colours the app uses for things you press', () => {
    const body = ruleBody('.help-support-note');
    const colour = body.match(/color:\s*(#[0-9a-f]{6})/i);

    expect(colour, 'the note declares no colour, so it inherits body text').toBeTruthy();
    // The browns the app's own controls are drawn in.
    expect(['#7a5b35', '#8e5b2d', '#b98748']).not.toContain(colour![1].toLowerCase());
  });

  it('is not a button, a link, or anything else that can be pressed', () => {
    /* "No button styled like a primary action" is the line in the item. The
     * strongest version of that is that the note contains no control at
     * all: it is a sentence, and the only thing you can do with it is read
     * it and copy the handle. */
    const note = element('p', 'help-support-note');

    expect(note).not.toMatch(/<button\b/);
    expect(note).not.toMatch(/<a\b/);
    expect(note).not.toMatch(/\(click\)=/);
  });

  it('carries no emoji and no exhortation', () => {
    const note = element('p', 'help-support-note');

    // Anything outside the Basic Multilingual Plane, plus the dingbat and
    // miscellaneous-symbol ranges emoji are drawn from.
    expect(note).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
    expect(note).not.toMatch(/support my work/i);
    expect(note).not.toMatch(/donate/i);
    expect(note).not.toMatch(/!/);
  });

  it('leaves the handle as selectable text so it can be copied', () => {
    /* It is text rather than a link on purpose — there is no URL here to go
     * stale, and nothing sends the user anywhere they did not ask to go. So
     * copying is the only way to act on it, and it has to work. */
    expect(element('p', 'help-support-note')).toContain('@bgoldstein14');
    expect(ruleBody('.help-handle')).toMatch(/user-select:\s*text/);
  });
});

describe('HelpModal — the note is never a prompt', () => {
  it('appears on this screen and nowhere else in the application', () => {
    /* "Never a prompt, never a modal, never on a timer." The way that gets
     * broken later is not by someone adding a timer: it is by the handle
     * being pasted into a toast, a zero state or a first-run banner. One
     * occurrence in the whole of src/ is the shape of that promise. */
    const appRoot = join(__dirname, '..', '..');
    const hits = filesContaining(appRoot, 'bgoldstein14');

    expect(hits).toEqual(['components/help-modal/help-modal.html']);
  });

  it('is reached only from the help icon, not raised by the shell on its own', () => {
    /* The shell shows this screen behind one flag and one flag only, and the
     * only thing that sets it is the toolbar's help icon. */
    const shell = readFileSync(join(__dirname, '..', '..', 'app.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const setters = [...shell.matchAll(/showHelpModal\.set\(true\)/g)];
    expect(setters.length, 'exactly one place opens the Help screen').toBe(1);
    expect(shell, 'and nothing opens it on a timer').not.toMatch(
      /setTimeout[\s\S]{0,200}showHelpModal/
    );
  });

  it('is wired to the toolbar icon in the shell', () => {
    /* The join is the part that goes missing, not the component — the batch
     * image import once had a modal, a signal and an open/close pair with
     * nothing calling the opener. */
    const shellTemplate = readFileSync(join(__dirname, '..', '..', 'app.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '');

    expect(shellTemplate).toMatch(/\(helpRequested\)="openHelpModal\(\)"/);
    expect(shellTemplate).toMatch(/<app-help-modal[\s\S]*?\/>/);
    expect(shellTemplate).toMatch(/\(reportProblemRequested\)="openSupportModalFromHelp\(\)"/);
  });
});

/** Every file under `root` containing `needle`, as posix-ish relative paths. */
function filesContaining(root: string, needle: string): string[] {
  const found: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
      } else if (/\.(ts|html|scss|json)$/.test(entry) && !entry.endsWith('.spec.ts')) {
        if (readFileSync(full, 'utf8').includes(needle)) found.push(rel);
      }
    }
  };

  walk(root, '');
  return found.sort();
}
