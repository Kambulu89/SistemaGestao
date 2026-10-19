export type TenantStatus = 'active' | 'trial' | 'suspended';

export interface Tenant {
  readonly id: string;
  /** Identificador legível usado no URL: /t/:slug */
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly planName: string;
  readonly locale: string;
  readonly currency: string;
  readonly timeZone: string;
}

/** Ligação de um utilizador a um tenant, com o papel nesse tenant. */
export interface TenantMembership {
  readonly tenant: Tenant;
  readonly roleName: string;
}

/** Estado de um módulo num tenant: contratado (plano) e activado (decisão do tenant). */
export interface TenantModuleState {
  readonly moduleId: string;
  readonly contracted: boolean;
  readonly active: boolean;
}

/**
 * Tudo o que o frontend precisa para operar no contexto de um tenant.
 * Vem do backend, que é a autoridade; o frontend só o usa para navegação e UX.
 */
export interface TenantContext {
  readonly tenant: Tenant;
  readonly roleName: string;
  readonly permissions: readonly string[];
  readonly modules: readonly TenantModuleState[];
  readonly featureFlags: Readonly<Record<string, boolean>>;
}
