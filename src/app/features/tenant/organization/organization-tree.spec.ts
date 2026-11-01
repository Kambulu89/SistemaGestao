import type { UnitDto } from '../data-access/organization.api';
import { buildUnitRows } from './organization-tree';

const unit = (id: string, code: string, parentId: string | null): UnitDto => ({
  id,
  organizationId: 'o',
  parentId,
  code,
  name: code,
  type: 'OTHER',
  active: true,
  version: 1,
});

describe('buildUnitRows', () => {
  it('puts parents before children, siblings by code, with depth', () => {
    const rows = buildUnitRows([
      unit('3', 'EQ-1', '2'),
      unit('2', 'VENDAS', '1'),
      unit('1', 'SEDE', null),
      unit('4', 'ARMAZEM', '1'),
      unit('5', 'ANEXO', null),
    ]);
    expect(rows.map((r) => [r.unit.code, r.depth])).toEqual([
      ['ANEXO', 0],
      ['SEDE', 0],
      ['ARMAZEM', 1],
      ['VENDAS', 1],
      ['EQ-1', 2],
    ]);
  });

  it('shows a unit whose parent is missing as a root', () => {
    expect(buildUnitRows([unit('2', 'X', 'ausente')]).map((r) => r.depth)).toEqual([0]);
  });

  it('never loops on inconsistent data', () => {
    const rows = buildUnitRows([unit('1', 'A', '2'), unit('2', 'B', '1')]);
    expect(rows.length).toBeLessThanOrEqual(2);
  });

  it('handles an empty list', () => {
    expect(buildUnitRows([])).toEqual([]);
  });
});
