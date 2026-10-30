import type { UnitDto } from '../data-access/organization.api';

export interface UnitRow {
  readonly unit: UnitDto;
  readonly depth: number;
}

/**
 * Ordena as unidades em árvore (pai antes dos filhos, irmãos por código) e indica a profundidade.
 * Tolera dados inconsistentes: uma unidade cujo pai não está na lista aparece como raiz, e um ciclo
 * (que o servidor não permite) nunca entra em ciclo infinito.
 */
export function buildUnitRows(units: readonly UnitDto[]): readonly UnitRow[] {
  const ids = new Set(units.map((u) => u.id));
  const children = new Map<string | null, UnitDto[]>();
  for (const unit of units) {
    const parent = unit.parentId !== null && ids.has(unit.parentId) ? unit.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), unit]);
  }
  for (const list of children.values()) list.sort((a, b) => a.code.localeCompare(b.code));

  const rows: UnitRow[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const unit of children.get(parent) ?? []) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      rows.push({ unit, depth });
      visit(unit.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}
