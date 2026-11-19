import { describe, expect, it } from 'vitest';
import {
  daysToExpiry,
  lotActions,
  lotLabel,
  lotStatusLabel,
  lotTone,
  sourceLink,
} from './lot-model';

describe('lotes (8.8)', () => {
  it('estado, cor e validade', () => {
    expect(lotStatusLabel({ status: 'ACTIVE', expired: true })).toBe('Expirado');
    expect(lotStatusLabel({ status: 'RECALLED', expired: true })).toBe('Recolhido');
    expect(lotTone({ status: 'ACTIVE', expired: false })).toContain('success');
    expect(lotTone({ status: 'BLOCKED', expired: false })).toContain('warning');
    expect(lotLabel({ code: 'L1', expiryDate: '2026-12-31' })).toBe('L1 (val. 31/12/2026)');
    expect(lotLabel({ code: 'L1', expiryDate: null })).toBe('L1');
    expect(daysToExpiry('2026-05-20', '2026-05-10')).toBe(10);
    expect(daysToExpiry('2026-05-01', '2026-05-10')).toBe(-9);
    expect(daysToExpiry(null)).toBeNull();
  });

  it('acções por estado e direito; ligações às origens', () => {
    const can = { manage: true };
    expect(lotActions({ status: 'ACTIVE', can })).toEqual({
      block: true,
      unblock: false,
      recall: true,
    });
    expect(lotActions({ status: 'BLOCKED', can })).toEqual({
      block: false,
      unblock: true,
      recall: true,
    });
    expect(lotActions({ status: 'RECALLED', can })).toEqual({
      block: false,
      unblock: false,
      recall: false,
    });
    expect(lotActions({ status: 'ACTIVE', can: { manage: false } }).block).toBe(false);
    expect(sourceLink({ type: 'INTERNAL_REQUISITION', id: 'x' })).toEqual([
      '/inventario/requisicoes',
      'x',
    ]);
    expect(sourceLink({ type: 'TEST', id: 'x' })).toBeNull();
    expect(sourceLink({ type: 'STOCK_DOCUMENT', id: null })).toBeNull();
  });
});
