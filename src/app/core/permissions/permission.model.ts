/** Chave de permissão no formato `domínio.recurso.acção`, ex.: `crm.customers.read`. */
export type Permission = string;

/** Operação autorizável, declarada pelo módulo/capacidade que a define. */
export interface PermissionDefinition {
  readonly key: Permission;
  readonly name: string;
  readonly description?: string;
}

/** Permissões da administração global. Só podem ser concedidas pela sessão da plataforma. */
export const PLATFORM_PERMISSIONS = {
  access: 'platform.access',
  tenantsRead: 'platform.tenants.read',
  modulesRead: 'platform.modules.read',
  plansRead: 'platform.plans.read',
  subscriptionsRead: 'platform.subscriptions.read',
  /** Concessões do servidor (D-033): gerir tenants / planos e assinaturas. */
  tenantsManage: 'platform.tenant.manage',
  billingManage: 'platform.billing.manage',
} as const;

/** Permissões das páginas de administração do tenant (as dos módulos vêm dos manifestos). */
export const TENANT_PERMISSIONS = {
  organizationRead: 'organization.units.read',
  usersRead: 'iam.users.read',
  accessRead: 'iam.access-control.read',
  settingsRead: 'tenant.settings.read',
  settingsManage: 'tenant.settings.manage',
  sequencesManage: 'tenant.sequences.manage',
  planRead: 'tenant.plan.read',
  modulesRead: 'tenant.modules.read',
  modulesManage: 'tenant.modules.manage',
  /** Definição de entidades dinâmicas (C10): traduzida de `entity.read` pelo servidor. */
  entitiesRead: 'configuration.forms.read',
  /** Caixa de aprovações (C14): o código do servidor, tal e qual. */
  approvalsDecide: 'approval.decide',
  /** Automações (C15): o código do servidor, tal e qual. */
  automationsRead: 'automation.read',
} as const;

export const PLATFORM_NAMESPACE = 'platform.';

/**
 * `*` concede tudo; `crm.*` concede qualquer permissão que comece por `crm.`.
 */
export function permissionMatches(granted: Permission, required: Permission): boolean {
  if (granted === '*' || granted === required) return true;
  return granted.endsWith('.*') && required.startsWith(granted.slice(0, -1));
}
