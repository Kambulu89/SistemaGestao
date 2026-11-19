import { describe, expect, it } from 'vitest';
import { childLevel, locationRows, seriesPreview, type WarehouseLocation } from './warehouse-model';

const loc = (pathCode: string, level: WarehouseLocation['level']): WarehouseLocation => ({
  id: pathCode,
  version: 1,
  parentId: null,
  level,
  code: pathCode.split('-').at(-1)!,
  pathCode,
  name: null,
  holdsStock: level === 'BIN',
  status: 'ACTIVE',
});

describe('modelo dos armazéns', () => {
  it('hierarquia de níveis', () => {
    expect(childLevel(null)).toBe('ZONE');
    expect(childLevel('RACK')).toBe('BIN');
    expect(childLevel('BIN')).toBeNull();
  });

  it('árvore pela ordem do caminho com profundidade', () => {
    const rows = locationRows([
      loc('A-01', 'AISLE'),
      loc('B', 'ZONE'),
      loc('A', 'ZONE'),
      loc('A-01-E1-P01', 'BIN'),
    ]);
    expect(rows.map((r) => [r.pathCode, r.depth])).toEqual([
      ['A', 0],
      ['A-01', 1],
      ['A-01-E1-P01', 3],
      ['B', 0],
    ]);
  });

  it('pré-visualização da série', () => {
    expect(seriesPreview('p', 1, 20, 2)).toBe('P01 … P20 (20)');
    expect(seriesPreview('P', 3, 3, 3)).toBe('P003');
    expect(seriesPreview('P', 1, 300, 3)).toBeNull();
    expect(seriesPreview('P', 5, 1, 2)).toBeNull();
  });
});
