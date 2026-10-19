import type { Permission } from '../permissions/permission.model';
import type { TenantModuleState } from '../tenant-context/tenant.model';
import type { ModuleAccessStatus, ModuleManifest } from './module.model';

export interface ModuleAccessContext {
  readonly tenantModules: readonly TenantModuleState[];
  readonly isFlagEnabled: (flag: string) => boolean;
  readonly can: (permission: Permission) => boolean;
}

/**
 * Distingue os quatro conceitos que não devem ser confundidos:
 * catálogo (manifest existe) → contratado → activado → autorizado (permissões).
 * Dependências são avaliadas de forma não recursiva: basta estarem contratadas e activadas.
 */
export function resolveModuleAccess(
  manifest: ModuleManifest,
  context: ModuleAccessContext,
): ModuleAccessStatus {
  const stateOf = (id: string) => context.tenantModules.find((m) => m.moduleId === id);
  const state = stateOf(manifest.id);

  if (!state?.contracted) return 'not-contracted';
  if (!state.active) return 'inactive';

  const dependenciesReady = manifest.dependencies.every((id) => {
    const dep = stateOf(id);
    return dep?.contracted === true && dep.active;
  });
  if (!dependenciesReady) return 'missing-dependency';

  if (manifest.featureFlag && !context.isFlagEnabled(manifest.featureFlag)) return 'flag-disabled';
  if (!manifest.permissions.every((p) => context.can(p))) return 'forbidden';

  return 'accessible';
}
