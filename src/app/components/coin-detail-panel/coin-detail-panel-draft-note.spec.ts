/*
 * The detail panel's draft note for an unsaved coin. No jsdom: the decision is
 * tested through the computed, and the markup against the comment-stripped
 * template text.
 */
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { CoinDetailPanel } from './coin-detail-panel';

interface PanelUnderTest {
  draftStatus(): { chip: string; summary: string; failed: boolean } | null;
}

function createPanel(options: {
  coin: Partial<CoinRecord>;
  draftIds?: string[];
  draftHint?: string;
}): PanelUnderTest {
  const draftIds = options.draftIds ?? [];
  const injector = Injector.create({
    providers: [
      {
        provide: InventoryService,
        useValue: {
          isDraftCoin: (id: string) => draftIds.includes(id),
          draftHint: () => options.draftHint ?? ''
        }
      }
    ]
  });

  const panel = runInInjectionContext(injector, () => new CoinDetailPanel());
  // Signal inputs are ordinary configurable class fields; replacing one with
  // a plain signal is the only way to drive this component without a DOM.
  (panel as unknown as Record<string, unknown>)['coin'] =
    signal(options.coin as CoinRecord);

  return panel as unknown as PanelUnderTest;
}

describe('what the panel says about a coin that is still being typed', () => {
  it('says nothing at all for a coin that is in the database', () => {
    const panel = createPanel({ coin: { id: 'a', denomination: 'Dollar', year: '1921' } });
    expect(panel.draftStatus()).toBeNull();
  });

  it('asks for the denomination after only a Year has been typed', () => {
    const panel = createPanel({ coin: { id: 'a', year: '1921' }, draftIds: ['a'] });
    expect(panel.draftStatus()?.summary).toBe('Needs a Denomination before it can be saved.');
  });

  it('does not present a half-typed coin as a failure', () => {
    const panel = createPanel({ coin: { id: 'a', year: '1921' }, draftIds: ['a'] });
    expect(panel.draftStatus()?.failed).toBe(false);
  });

  it('DOES present a refused save as a failure, because that one is an error', () => {
    const refusal = 'Not saved yet — the last attempt failed: 500. Edit this row to retry.';
    const panel = createPanel({
      coin: { id: 'a', year: '1921', coinType: 'Morgan', denomination: 'Dollar' },
      draftIds: ['a'],
      draftHint: refusal
    });
    const status = panel.draftStatus();
    expect(status?.failed).toBe(true);
    expect(status?.summary).toBe(refusal);
  });

  it('survives an InventoryService stub that knows nothing about drafts', () => {
    const injector = Injector.create({
      providers: [{ provide: InventoryService, useValue: {} }]
    });
    const panel = runInInjectionContext(injector, () => new CoinDetailPanel());
    (panel as unknown as Record<string, unknown>)['coin'] = signal({ id: 'a' } as CoinRecord);
    expect((panel as unknown as PanelUnderTest).draftStatus()).toBeNull();
  });
});

const TEMPLATE = readFileSync(join(__dirname, 'coin-detail-panel.html'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');

describe('the panel renders the note', () => {
  it('shows the sentence rather than hiding it in a tooltip', () => {
    expect(TEMPLATE).toContain('draft.summary');
    expect(TEMPLATE).toContain('class="detail-draft-note"');
  });

  it('announces it politely while the user is still typing', () => {
    // role="status" is polite; a half-typed coin must not interrupt. Only a
    // refused save becomes an alert.
    expect(TEMPLATE).toContain("draft.failed ? 'alert' : 'status'");
  });

  it('still offers a way out of the panel, now that the row has no toggle', () => {
    // Close is the only way out of the panel, so it must stay.
    expect(TEMPLATE).toContain('closeRequested.emit()');
  });
});

const APP_TEMPLATE = readFileSync(
  join(__dirname, '..', '..', 'app.html'), 'utf8'
).replace(/<!--[\s\S]*?-->/g, '');

describe('the shell is wired to the new grid contract', () => {
  it('opens the panel when the grid reports an activated row', () => {
    expect(APP_TEMPLATE).toContain('(detailRequested)="openCoinDetail($event)"');
  });

  it('no longer listens for a selection-only output', () => {
    expect(APP_TEMPLATE).not.toContain('coinSelected');
  });

  it('passes the Add Coin focus request down to the panel', () => {
    expect(APP_TEMPLATE).toContain('[focusFirstFieldRequest]="detailFieldFocusRequest()"');
  });

  it('still routes Add Coin through the shell', () => {
    expect(APP_TEMPLATE).toContain('(addCoinRequested)="addBlankCoin()"');
  });
});
