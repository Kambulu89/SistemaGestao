/**
 * Tabelas **globais** (plano de controlo da plataforma), enumeradas de forma explícita: não se infere
 * globalidade pela ausência de `tenant_id`. Qualquer outra tabela é considerada de tenant e tem de
 * cumprir as garantias de isolamento (ver `findTenancyViolations`).
 *
 * Cada entrada é `esquema.tabela`. Acrescentar aqui exige uma decisão registada em `docs/decisions.md`:
 * uma tabela global não tem RLS, por isso só o plano de controlo (contas e rotas próprias) lhe acede.
 * Actualmente: nenhuma (as tabelas globais Tenant, User, … chegam com as fatias 1.2 e seguintes).
 */
export const PLATFORM_TABLES: ReadonlySet<string> = new Set<string>([])

/** Tabelas do próprio framework (registo de migrations). Não contêm dados de tenants. */
export const FRAMEWORK_TABLES: ReadonlySet<string> = new Set([
  'public.adonis_schema',
  'public.adonis_schema_versions',
])
