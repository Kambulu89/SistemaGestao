import type { ModuleGroup, ModuleManifest } from './module.model';

/**
 * Verifica a integridade do catálogo e devolve os problemas encontrados (vazio = válido).
 * Corre no arranque do registo e num teste sobre o catálogo real.
 */
export function validateCatalog(
  groups: readonly ModuleGroup[],
  manifests: readonly ModuleManifest[],
): string[] {
  const issues: string[] = [];
  const groupIds = new Set(groups.map((g) => g.id));
  const byId = new Map<string, ModuleManifest>();
  const codes = new Set<string>();
  const permissionKeys = new Set<string>();

  for (const m of manifests) {
    if (byId.has(m.id)) issues.push(`Id duplicado: ${m.id}`);
    byId.set(m.id, m);

    if (codes.has(m.code)) issues.push(`Código duplicado: ${m.code}`);
    codes.add(m.code);

    if (!groupIds.has(m.groupId)) issues.push(`${m.code}: grupo desconhecido "${m.groupId}"`);

    for (const p of m.permissions) {
      if (permissionKeys.has(p.key)) issues.push(`${m.code}: permissão duplicada "${p.key}"`);
      permissionKeys.add(p.key);
    }
    if (!m.permissions.some((p) => p.key === m.accessPermission)) {
      issues.push(`${m.code}: accessPermission "${m.accessPermission}" não está declarada`);
    }
    if (m.kind === 'foundation' && m.dependencies.length > 0) {
      issues.push(`${m.code}: capacidades de fundação não podem ter dependências`);
    }
  }

  for (const m of manifests) {
    for (const dep of m.dependencies) {
      const target = byId.get(dep);
      if (!target) issues.push(`${m.code}: dependência desconhecida "${dep}"`);
      else if (target.kind === 'module' && m.kind === 'foundation') {
        issues.push(`${m.code}: fundação a depender de módulo`);
      }
    }
  }

  issues.push(...findCycles(byId));
  return issues;
}

function findCycles(byId: ReadonlyMap<string, ModuleManifest>): string[] {
  const issues: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, path: readonly string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      issues.push(`Dependência circular: ${[...path, id].join(' → ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dep)) visit(dep, [...path, id]);
    }
    state.set(id, 'done');
  };

  for (const id of byId.keys()) visit(id, []);
  return issues;
}
