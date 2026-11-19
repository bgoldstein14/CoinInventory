/*
 * Component wiring tests (Node, no jsdom). The figures are tested in the
 * services/statistics specs; these check that unknowns reach the screen as
 * "—" with their coverage note.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { StatisticsModal } from './statistics-modal';
import { createTestInventoryService } from '../../testing/test-helpers';
import { statsCoin } from '../../testing/stats-coins.fixture';
import { CoinRecord, SpotPrices } from '../../types/coin.model';

const PRICES: SpotPrices = { gold: 2650, silver: 31, platinum: 980, copper: 4.2 };

function createModal(coins: CoinRecord[] = [], prices?: SpotPrices) {
  const { inv } = createTestInventoryService();
  inv.inventory.set(coins);
  if (prices) inv.updateSpotPrices(prices);

  const injector = Injector.create({
    providers: [{ provide: InventoryService, useValue: inv }]
  });
  const modal = runInInjectionContext(injector, () => new StatisticsModal());
  return { modal, inv };
}

/** Every tile in the view, flattened, so a test can look one up by label. */
function tile(modal: StatisticsModal, label: string) {
  const all = [...modal['headlineTiles'](), ...modal['metalTiles']()];
  const found = all.find(t => t.label === label);
  if (!found) throw new Error(`No tile labelled "${label}". Have: ${all.map(t => t.label).join(', ')}`);
  return found;
}

describe('StatisticsModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  // --- Empty collection ---
  describe('with an empty collection', () => {
    it('does not throw, and leads with no coins', () => {
      const { modal } = createModal([]);
      expect(modal['hero']().value).toBe('—');
      expect(tile(modal, 'Coins').value).toBe('0');
    });

    it('shows a dash for every money figure rather than a screen of $0.00', () => {
      const { modal } = createModal([]);
      expect(tile(modal, 'Total cost').value).toBe('—');
      expect(tile(modal, 'Unrealised gain').value).toBe('—');
      expect(tile(modal, 'Melt value').value).toBe('—');
    });

    it('draws no bars and no spend curve', () => {
      const { modal } = createModal([]);
      expect(modal['barChart']().bars).toEqual([]);
      expect(modal['spendChart']().linePath).toBe('');
      expect(modal['hasSpendCurve']()).toBe(false);
    });
  });

  // --- Unknown figures ---
  describe('an unknown figure reaches the screen as a dash, with a reason', () => {
    it('prints a dash for melt value when no spot prices are loaded', () => {
      const { modal } = createModal([
        statsCoin({ metalContent: 'Gold', pmWeightGrams: 31.1035, currentValue: 2700 })
      ]);
      const melt = tile(modal, 'Melt value');

      expect(melt.value).toBe('—');
      expect(melt.note).toBeTruthy();
    });

    it('prices the same coin once spot prices arrive', () => {
      const { modal } = createModal(
        [statsCoin({ metalContent: 'Gold', pmWeightGrams: 31.1035, currentValue: 2700 })],
        PRICES
      );
      expect(tile(modal, 'Melt value').value).toBe('$2,650.00');
    });

    it('names how many coins were left out of the current-value total', () => {
      const { modal } = createModal([
        statsCoin({ currentValue: 100 }),
        statsCoin(),
        statsCoin()
      ]);
      expect(modal['hero']().value).toBe('$100.00');
      expect(modal['hero']().note).toBe('Not recorded for 2 of 3 coins');
    });

    it('says nothing about coverage when every coin is accounted for', () => {
      const { modal } = createModal([statsCoin({ currentValue: 100 })]);
      expect(modal['hero']().note).toBeNull();
    });
  });

  // --- Gain and loss ---
  describe('unrealised gain and loss', () => {
    it('signs a gain and marks it as a gain', () => {
      const { modal } = createModal([statsCoin({ purchasePrice: 100, currentValue: 175 })]);
      const gain = tile(modal, 'Unrealised gain');

      expect(gain.value).toBe('+$75.00');
      expect(gain.tone).toBe('gain');
    });

    it('relabels the tile for a loss, so the word changes and not just the colour', () => {
      const { modal } = createModal([statsCoin({ purchasePrice: 500, currentValue: 120 })]);
      const loss = tile(modal, 'Unrealised loss');

      expect(loss.value).toBe('-$380.00');
      expect(loss.tone).toBe('loss');
    });

    it('carries the percentage alongside', () => {
      const { modal } = createModal([statsCoin({ purchasePrice: 100, currentValue: 175 })]);
      expect(tile(modal, 'Unrealised gain').detail).toContain('75.0%');
    });

    it('has no tone at all when there is nothing to compare', () => {
      const { modal } = createModal([statsCoin()]);
      expect(tile(modal, 'Unrealised gain').tone).toBeNull();
    });
  });

  // --- Precious metal ---
  describe('precious metal tiles', () => {
    it('shows pure grams and troy ounces for a metal that is weighed', () => {
      const { modal } = createModal([
        statsCoin({ metalContent: 'Gold', pmWeightGrams: 31.1035, pmPercent: 90 })
      ]);
      const gold = tile(modal, 'Gold held');

      expect(gold.value).toBe('31.10 g');
      expect(gold.detail).toContain('1.000 ozt');
    });

    it('shows a dash, not 0.00 g, for a metal nobody weighed', () => {
      const { modal } = createModal([statsCoin({ metalContent: 'Gold' })]);
      const gold = tile(modal, 'Gold held');

      expect(gold.value).toBe('—');
      expect(gold.note).toBe('Not recorded for any of the 1 gold coins');
    });

    it('offers no tile for a metal the collection does not contain', () => {
      const { modal } = createModal([statsCoin({ metalContent: 'Gold', pmWeightGrams: 1 })]);
      expect(modal['metalTiles']().map(t => t.label)).toEqual(['Gold held']);
    });

    it('says in words how many coins have no metal recorded', () => {
      const { modal } = createModal([statsCoin(), statsCoin({ metalContent: 'Bronze' })]);
      const notes = modal['metalNotes']().join(' | ');

      expect(notes).toContain('1 coin');
      expect(notes.toLowerCase()).toContain('metal');
    });
  });

  // --- The composition chart ---
  describe('the composition chart', () => {
    const coins = [
      statsCoin({ denomination: 'Dime', country: 'United States', currentValue: 10 }),
      statsCoin({ denomination: 'Dime', country: 'United States', currentValue: 10 }),
      statsCoin({ denomination: 'Dollar', country: 'Canada', currentValue: 900 })
    ];

    it('starts on denomination by count', () => {
      const { modal } = createModal(coins);
      expect(modal['dimension']()).toBe('denomination');
      expect(modal['metric']()).toBe('count');
      expect(modal['barChart']().bars.map(b => b.label)).toEqual(['Dime', 'Dollar']);
    });

    it('re-ranks when the metric changes, without changing the dimension', () => {
      const { modal } = createModal(coins);
      modal['setMetric']('value');

      expect(modal['dimension']()).toBe('denomination');
      expect(modal['barChart']().bars.map(b => b.label)).toEqual(['Dollar', 'Dime']);
    });

    it('switches dimension on request', () => {
      const { modal } = createModal(coins);
      modal['setDimension']('country');
      expect(modal['barChart']().bars.map(b => b.label)).toEqual(['United States', 'Canada']);
    });

    it('labels a count bar with coins and a value bar with money', () => {
      const { modal } = createModal(coins);
      expect(modal['barChart']().bars[0].valueText).toBe('2');

      modal['setMetric']('value');
      expect(modal['barChart']().bars[0].valueText).toBe('$900.00');
    });

    it('labels a value bar with a dash when nothing in that slice was appraised', () => {
      const { modal } = createModal([statsCoin({ denomination: 'Dime' })]);
      modal['setMetric']('value');
      expect(modal['barChart']().bars[0].valueText).toBe('—');
    });

    it('says underneath how many coins the chart could not place', () => {
      const { modal } = createModal([
        statsCoin({ denomination: 'Dime' }),
        statsCoin({ denomination: '' })
      ]);
      expect(modal['breakdownNote']()).toBe('Not recorded for 1 of 2 coins');
    });

    it('explains what went into the Other bar when the tail is folded', () => {
      const coins12 = Array.from({ length: 12 }, (_, i) =>
        statsCoin({ category: `Cat-${i}` })
      );
      const { modal } = createModal(coins12);
      expect(modal['setDimension']('category'));
      expect(modal['otherNote']()).toContain('further');
    });

    it('offers no Other explanation when nothing was folded', () => {
      const { modal } = createModal(coins);
      expect(modal['otherNote']()).toBeNull();
    });
  });

  // --- Hover and keyboard ---
  describe('the bar readout', () => {
    const coins = [
      statsCoin({ denomination: 'Dime', currentValue: 10 }),
      statsCoin({ denomination: 'Dime' })
    ];

    it('is empty until something is pointed at', () => {
      const { modal } = createModal(coins);
      expect(modal['barReadout']()).toBeNull();
    });

    it('names the category, the count and the value when a bar is hovered', () => {
      const { modal } = createModal(coins);
      modal['onBarFocus'](0);
      const readout = modal['barReadout']() ?? '';

      expect(readout).toContain('Dime');
      expect(readout).toContain('2 coins');
      expect(readout).toContain('$10.00');
    });

    it('admits in the readout that part of the slice has no value', () => {
      const { modal } = createModal(coins);
      modal['onBarFocus'](0);
      expect(modal['barReadout']()).toContain('1 of 2');
    });

    it('clears when the pointer leaves', () => {
      const { modal } = createModal(coins);
      modal['onBarFocus'](0);
      modal['onBarBlur']();
      expect(modal['barReadout']()).toBeNull();
    });

    it('ignores an index that is not on the chart', () => {
      const { modal } = createModal(coins);
      modal['onBarFocus'](99);
      expect(modal['barReadout']()).toBeNull();
    });
  });

  // --- The spend curve ---
  describe('the spend curve', () => {
    const coins = [
      statsCoin({ purchaseDate: '2022-01-02', purchasePrice: 500 }),
      statsCoin({ purchaseDate: '2023-06-30', purchasePrice: 250 }),
      statsCoin({ purchaseDate: '2024-03-15', purchasePrice: 150 })
    ];

    it('draws a rising curve through every purchase date', () => {
      const { modal } = createModal(coins);
      expect(modal['hasSpendCurve']()).toBe(true);
      expect(modal['spendChart']().points).toHaveLength(3);
      expect(modal['spendChart']().linePath.startsWith('M ')).toBe(true);
    });

    it('labels the x axis with months, in UTC', () => {
      const { modal } = createModal(coins);
      expect(modal['spendXLabels']()[0].text).toBe('Jan 2022');
    });

    it('direct-labels only the END of the curve, not every point', () => {
      const { modal } = createModal(coins);
      expect(modal['spendEndLabel']()?.text).toBe('$900.00');
    });

    it('snaps the crosshair to the nearest point', () => {
      const { modal } = createModal(coins);
      const chart = modal['spendChart']();
      modal['onPlotMove']({ offsetX: chart.points[1].x + 2 } as PointerEvent);

      expect(modal['activeSpendPoint']()?.date).toBe('2023-06-30');
    });

    it('moves the crosshair with the arrow keys, so it is reachable without a mouse', () => {
      const { modal } = createModal(coins);
      modal['onPlotKey']({ key: 'ArrowRight', preventDefault: () => {} } as KeyboardEvent);
      expect(modal['activeSpendPoint']()?.date).toBe('2022-01-02');

      modal['onPlotKey']({ key: 'ArrowRight', preventDefault: () => {} } as KeyboardEvent);
      expect(modal['activeSpendPoint']()?.date).toBe('2023-06-30');
    });

    it('does not run off the end of the series with the arrow keys', () => {
      const { modal } = createModal(coins);
      for (let i = 0; i < 20; i++) {
        modal['onPlotKey']({ key: 'ArrowRight', preventDefault: () => {} } as KeyboardEvent);
      }
      expect(modal['activeSpendPoint']()?.date).toBe('2024-03-15');
    });

    it('offers the same figures as a table, so the curve never gates a value', () => {
      const { modal } = createModal(coins);
      const rows = modal['spendTableRows']();

      expect(rows).toHaveLength(3);
      expect(rows[2].date).toBe('15 Mar 2024');
      expect(rows[2].cumulative).toBe('$900.00');
    });

    it('says how much spend is missing from the curve for want of a date', () => {
      const { modal } = createModal([
        ...coins,
        statsCoin({ purchaseDate: '', purchasePrice: 4000 })
      ]);
      const notes = modal['spendNotes']().join(' | ');

      expect(notes).toContain('$4,000.00');
      expect(notes).toContain('1 coin');
    });

    it('always states that value over time is not stored, however good the data', () => {
      const { modal } = createModal(coins);
      expect(modal['valueHistoryNote']().toLowerCase()).toContain('current value');
    });
  });

  // --- Closing ---
  describe('closing', () => {
    it('emits closed', () => {
      const { modal } = createModal([]);
      let closed = false;
      modal.closed.subscribe(() => (closed = true));
      modal['close']();
      expect(closed).toBe(true);
    });
  });
});
