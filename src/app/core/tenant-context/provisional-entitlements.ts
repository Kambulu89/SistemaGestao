import type { ModuleManifest } from '../modules/module.model';
import type { Subscription } from '../subscription/subscription.model';
import type { ModuleSettingValue, TenantModule } from './tenant.model';

/**
 * PROVISÓRIO: o backend ainda não tem planos/subscrições (C02) nem registo de módulos por tenant
 * (C03). Até existirem, todos os módulos do catálogo aparecem contratados e activos; quem decide o
 * que o utilizador consegue de facto fazer são as **permissões** devolvidas pelo servidor (um módulo
 * sem permissões no backend fica inacessível). Substituir quando C02/C03 existirem.
 */
export function provisionalEntitlements(
  tenantId: string,
  manifests: readonly ModuleManifest[],
): {
  readonly subscription: Subscription;
  readonly modules: readonly TenantModule[];
  readonly featureFlags: Readonly<Record<string, boolean>>;
} {
  const contractable = manifests.filter((m) => m.kind === 'module');
  return {
    subscription: {
      id: `provisional-${tenantId}`,
      tenantId,
      planCode: 'provisional',
      status: 'active',
      startedAt: new Date(0).toISOString(),
      renewsAt: null,
      moduleIds: contractable.map((m) => m.id),
      limits: [],
    },
    modules: contractable.map((m) => ({
      moduleId: m.id,
      active: true,
      features: m.features.map((f) => f.id),
      settings: Object.fromEntries(
        m.settings.map((s): [string, ModuleSettingValue] => [s.key, s.defaultValue]),
      ),
    })),
    featureFlags: {},
  };
}
