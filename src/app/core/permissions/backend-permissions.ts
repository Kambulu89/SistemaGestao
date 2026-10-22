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
