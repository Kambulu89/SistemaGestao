import type { Permission } from '../permissions/permission.model';
import { isSubscriptionUsable, type Subscription } from '../subscription/subscription.model';
import type { TenantModule } from '../tenant-context/tenant.model';
import type { ModuleFeature, ModuleManifest } from './module.model';

/**
 * Resultado da resolução de um módulo para um tenant e utilizador, pela ordem de verificação.
 * Cada valor corresponde a um conceito distinto: não se confunde "contratado" com "activo"
 * nem "activo" com "autorizado".
 */
export type ModuleAccessStatus =
  | 'retired'
  | 'subscription-inactive'
  | 'not-contracted'
  | 'inactive'
  | 'missing-dependency'
  | 'flag-disabled'
  | 'forbidden'
  | 'accessible';

export interface ModuleAccessContext {
  readonly subscription: Subscription | null;
  readonly tenantModules: readonly TenantModule[];
  readonly manifestOf: (moduleId: string) => ModuleManifest | undefined;
  readonly isFlagEnabled: (flag: string) => boolean;
  readonly can: (permission: Permission) => boolean;
}

/** Um módulo está "pronto" para servir de dependência se estiver contratado e activo. */
function isReady(moduleId: string, context: ModuleAccessContext): boolean {
  const dependency = context.manifestOf(moduleId);
  if (!dependency) return false;
  if (dependency.kind === 'foundation') return true;
  return (
    context.subscription?.moduleIds.includes(moduleId) === true &&
    context.tenantModules.find((m) => m.moduleId === moduleId)?.active === true
  );
}

/**
 * Ordem: ciclo de vida → subscrição utilizável → contratado → activado → dependências →
 * feature flag → permissão. Dependências avaliam-se de forma não recursiva.
 * Capacidades de fundação saltam os passos de contrato e activação.
 */
export function resolveModuleAccess(
  manifest: ModuleManifest,
  context: ModuleAccessContext,
): ModuleAccessStatus {
  if (manifest.lifecycle === 'retired') return 'retired';

  if (manifest.kind === 'module') {
    if (!isSubscriptionUsable(context.subscription)) return 'subscription-inactive';
    if (!context.subscription?.moduleIds.includes(manifest.id)) return 'not-contracted';
    if (context.tenantModules.find((m) => m.moduleId === manifest.id)?.active !== true) {
      return 'inactive';
    }
    if (!manifest.dependencies.every((id) => isReady(id, context))) return 'missing-dependency';
  }

  if (manifest.featureFlag && !context.isFlagEnabled(manifest.featureFlag)) return 'flag-disabled';
  if (!context.can(manifest.accessPermission)) return 'forbidden';
  return 'accessible';
}

export type FeatureAccessStatus =
  'available' | 'module-unavailable' | 'not-enabled' | 'flag-disabled' | 'forbidden';

/**
 * Uma funcionalidade só está disponível se o módulo estiver acessível, o tenant a tiver
 * disponibilizado, a feature flag estiver ligada e o utilizador tiver a permissão.
 */
export function resolveFeatureAccess(
  feature: ModuleFeature,
  moduleStatus: ModuleAccessStatus,
  tenantModule: TenantModule | undefined,
  context: Pick<ModuleAccessContext, 'isFlagEnabled' | 'can'>,
): FeatureAccessStatus {
  if (moduleStatus !== 'accessible') return 'module-unavailable';
  if (!tenantModule?.features.includes(feature.id)) return 'not-enabled';
  if (feature.flag && !context.isFlagEnabled(feature.flag)) return 'flag-disabled';
  if (feature.permission && !context.can(feature.permission)) return 'forbidden';
  return 'available';
}
