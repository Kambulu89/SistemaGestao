import type { PermissionDto } from '../data-access/iam.api';

export interface PermissionGroup {
  readonly moduleCode: string;
  readonly permissions: readonly PermissionDto[];
}

/** Agrupa o catálogo de permissões por módulo, ambos ordenados (a leitura fica estável). */
export function groupPermissions(list: readonly PermissionDto[]): readonly PermissionGroup[] {
  const byModule = new Map<string, PermissionDto[]>();
  for (const permission of list) {
    const group = byModule.get(permission.moduleCode) ?? [];
    group.push(permission);
    byModule.set(permission.moduleCode, group);
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([moduleCode, permissions]) => ({
      moduleCode,
      permissions: [...permissions].sort((a, b) => a.code.localeCompare(b.code)),
    }));
}

/** Liga ou desliga um código sem repetir nem desordenar o resto. */
export function toggleCode(codes: readonly string[], code: string, on: boolean): readonly string[] {
  const without = codes.filter((c) => c !== code);
  return on ? [...without, code].sort() : without;
}
