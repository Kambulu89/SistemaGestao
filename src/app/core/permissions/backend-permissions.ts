import type { Permission } from './permission.model';

/**
 * D-014: o backend usa `<recurso>.<acção>` (ex.: `member.invite`, `iam.manage`); o frontend usa
 * `<módulo>.<recurso>.<acção>`. Este é o **único** ponto de tradução. Cada código do servidor
 * mantém-se tal e qual e ganha os aliases que as páginas do frontend esperam.
 *
 * É só conveniência de navegação: o servidor volta a verificar cada operação.
 */
const ALIASES: Readonly<Record<string, readonly Permission[]>> = {
  'organization.read': ['organization.units.read'],
  'organization.manage': ['organization.units.read', 'organization.units.manage'],
  'member.read': ['iam.users.read'],
  'member.invite': ['iam.users.read', 'iam.users.manage'],
  'member.manage': ['iam.users.read', 'iam.users.manage'],
  'iam.read': ['iam.access-control.read'],
  'iam.manage': ['iam.access-control.read', 'iam.access-control.manage'],
  'settings.read': ['tenant.settings.read'],
  'settings.manage': ['tenant.settings.read', 'tenant.settings.manage'],
  'sequence.manage': ['tenant.sequences.manage'],
  'subscription.read': ['tenant.plan.read'],
  'module.read': ['tenant.modules.read'],
  'module.manage': ['tenant.modules.read', 'tenant.modules.manage'],
  // Entidades dinâmicas (C10): as páginas do Core Dinâmico usam `configuration.forms.*`. Os registos usam
  // directamente `dynamic.*` (ver `SERVER_ENTITY_OPERATIONS`).
  'entity.read': ['configuration.forms.read'],
  'entity.design': ['configuration.forms.read', 'configuration.forms.manage'],
  'entity.publish': ['configuration.forms.read', 'configuration.forms.publish'],
  // Regras de validação (C12).
  'rule.read': ['configuration.rules.read'],
  'rule.manage': ['configuration.rules.read', 'configuration.rules.manage'],
};

/** Códigos do servidor → chaves do frontend (com os códigos originais incluídos). */
export function mapBackendPermissions(codes: readonly string[]): readonly Permission[] {
  const result = new Set<Permission>();
  for (const code of codes) {
    result.add(code);
    for (const alias of ALIASES[code] ?? []) result.add(alias);
  }
  return [...result].sort();
}

/**
 * Concessões de plataforma do servidor (`platform.tenant.manage`, `platform.billing.manage`) → chaves do
 * frontend. Qualquer concessão dá acesso à área de plataforma e ao catálogo de módulos do código (que não
 * vem da API).
 */
export function mapPlatformPermissions(codes: readonly string[]): readonly Permission[] {
  if (codes.length === 0) return [];
  const result = new Set<Permission>(['platform.access', 'platform.modules.read', ...codes]);
  if (codes.includes('platform.tenant.manage')) result.add('platform.tenants.read');
  if (codes.includes('platform.billing.manage')) {
    result.add('platform.plans.read');
    result.add('platform.subscriptions.read');
  }
  return [...result].sort();
}
