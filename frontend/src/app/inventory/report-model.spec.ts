import { describe, expect, it } from 'vitest';
import {
  classLabel,
  coverageText,
  defaultRange,
  expiryText,
  movementsCsv,
  replenishmentCsv,
  replenishmentTone,
  turnoverText,
} from './report-model';

describe('alertas e relatórios do inventário (8.11)', () => {
  it('textos de validade, cobertura e rotação', () => {
    expect(expiryText(-3)).toBe('expirou há 3 dias');
    expect(expiryText(-1)).toBe('expirou há 1 dia');
    expect(expiryText(0)).toBe('expira hoje');
    expect(expiryText(1)).toBe('falta 1 dia');
    expect(expiryText(10)).toBe('faltam 10 dias');
    expect(coverageText(null)).toBe('sem consumo');
    expect(coverageText(1)).toBe('1 dia');
    expect(coverageText(60)).toBe('60 dias');
    expect(turnoverText('2.17')).toBe('2,17');
    expect(turnoverText(null)).toBe('—');
  });

  it('período por omissão, rótulos e cores', () => {
    expect(defaultRange(new Date('2026-11-11T10:00:00Z'))).toEqual({
      from: '2026-11-01',
      to: '2026-11-11',
    });
    expect(classLabel('ADJUSTMENT_LOSS')).toBe('Faltas de contagem');
    expect(classLabel('NOVA')).toBe('NOVA');
    expect(replenishmentTone('STOCKOUT')).toContain('danger');
    expect(replenishmentTone('REORDER')).toContain('warning');
    expect(replenishmentTone('OK')).toContain('success');
  });

  it('exportação: números como vêm da API e valores ocultos em branco', () => {
    const product = { id: 'p', sku: 'OLEO', name: 'Óleo' };
    expect(
      replenishmentCsv([
        {
          product,
          uom: 'UN',
          min: '50.000000',
          max: null,
          onHand: '46.000000',
          available: '46.000000',
          reserved: '0.000000',
          incoming: '0.000000',
          suggested: '4.000000',
          status: 'REORDER',
        },
      ]).rows[0],
    ).toEqual([
      'OLEO',
      'Óleo',
      'UN',
      'Repor',
      '50.000000',
      '',
      '46.000000',
      '0.000000',
      '46.000000',
      '0.000000',
      '4.000000',
    ]);
    expect(
      movementsCsv({
        from: '2026-11-01',
        to: '2026-11-11',
        total: 1,
        values: false,
        totals: [],
        rows: [
          {
            product,
            uom: 'UN',
            class: 'SALE',
            quantityIn: '0.000000',
            quantityOut: '4.000000',
            value: null,
          },
        ],
      }).rows[0],
    ).toEqual(['OLEO', 'Óleo', 'UN', 'Vendas', '0.000000', '4.000000', '']);
  });
});
