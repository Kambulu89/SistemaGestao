/**
 * Tabelas **globais** (plano de controlo), enumeradas explicitamente: nunca se infere globalidade pela ausência de
 * `tenant_id`. Qualquer outra tabela é de tenant e tem de ter RLS forçada (verificado em `schema_conformance.spec.ts`).
 */
export const PLATFORM_TABLES: ReadonlySet<string> = new Set([
  'tenants',
  'users',
  'auth_sessions',
  'rate_limit_counters',
  'permissions',
  'one_time_tokens',
])

/** Tabelas do framework (registo de migrações). */
export const FRAMEWORK_TABLES: ReadonlySet<string> = new Set([
  'adonis_schema',
  'adonis_schema_versions',
])
