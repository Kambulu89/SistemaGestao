import type { Subscription } from '../subscription/subscription.model';

export type TenantStatus = 'active' | 'trial' | 'suspended';

export interface Tenant {
  readonly id: string;
  /** Identificador legível usado no URL: /t/:slug */
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly locale: string;
  readonly currency: string;
  readonly timeZone: string;
}

/** Ligação de um utilizador a um tenant, com o papel nesse tenant. */
export interface TenantMembership {
  readonly tenant: Tenant;
  readonly roleName: string;
}

export type ModuleSettingValue = boolean | number | string;

/**
 * Relação entre um tenant e um módulo: a **decisão do tenant** de o activar,
 * as funcionalidades que tem disponíveis e os seus parâmetros.
 * Estar na subscrição (contratado) é outra coisa; ver `Subscription.moduleIds`.
 */
export interface TenantModule {
  readonly moduleId: string;
  readonly active: boolean;
  /** Ids das funcionalidades (`ModuleFeature.id`) disponibilizadas neste tenant. */
  readonly features: readonly string[];
  readonly settings: Readonly<Record<string, ModuleSettingValue>>;
}

/**
 * Tudo o que o frontend precisa para operar no contexto de um tenant.
 * Vem do backend, que é a autoridade; o frontend só o usa para navegação e UX.
 */
export interface TenantContext {
  readonly tenant: Tenant;
  readonly roleName: string;
  readonly permissions: readonly string[];
  readonly subscription: Subscription;
  readonly modules: readonly TenantModule[];
  readonly featureFlags: Readonly<Record<string, boolean>>;
}
