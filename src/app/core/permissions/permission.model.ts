/** Chave de permissão no formato `domínio.recurso.acção`, ex.: `tenant.users.read`. */
export type Permission = string;

/** Catálogo das permissões do core. Os módulos declaram as suas próprias no manifesto. */
export const PLATFORM_PERMISSIONS = {
  access: 'platform.access',
  tenantsRead: 'platform.tenants.read',
  plansRead: 'platform.plans.read',
  subscriptionsRead: 'platform.subscriptions.read',
} as const;

export const TENANT_PERMISSIONS = {
  organizationRead: 'tenant.organization.read',
  usersRead: 'tenant.users.read',
  settingsRead: 'tenant.settings.read',
} as const;

/**
 * `*` concede tudo; `crm.*` concede qualquer permissão que comece por `crm.`.
 */
export function permissionMatches(granted: Permission, required: Permission): boolean {
  if (granted === '*' || granted === required) return true;
  return granted.endsWith('.*') && required.startsWith(granted.slice(0, -1));
}
