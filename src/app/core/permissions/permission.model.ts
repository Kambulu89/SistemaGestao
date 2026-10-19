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
  settingsRead: 'platform.settings.read',
} as const;

/** Permissões das páginas de administração do tenant (as dos módulos vêm dos manifestos). */
export const TENANT_PERMISSIONS = {
  organizationRead: 'organization.units.read',
  usersRead: 'iam.users.read',
  accessRead: 'iam.access-control.read',
  settingsRead: 'tenant.settings.read',
} as const;

export const PLATFORM_NAMESPACE = 'platform.';

/**
 * `*` concede tudo; `crm.*` concede qualquer permissão que comece por `crm.`.
 */
export function permissionMatches(granted: Permission, required: Permission): boolean {
  if (granted === '*' || granted === required) return true;
  return granted.endsWith('.*') && required.startsWith(granted.slice(0, -1));
}
