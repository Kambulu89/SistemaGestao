/**
 * Tabelas **globais** (plano de controlo da plataforma), enumeradas de forma explícita: não se infere
 * globalidade pela ausência de `tenant_id`. Qualquer outra tabela é considerada de tenant e tem de
 * cumprir as garantias de isolamento (ver `findTenancyViolations`).
 *
 * Cada entrada é `esquema.tabela`. Acrescentar aqui exige uma decisão registada em `docs/decisions.md`:
 * uma tabela global não tem RLS, por isso só o plano de controlo (contas e rotas próprias) lhe acede.
 * Actualmente: tenants, tenant_domains, users, auth_sessions e one_time_tokens (fatia 1.2) e permissions (fatia 1.4).
 */
export const PLATFORM_TABLES: ReadonlySet<string> = new Set<string>([
  // Plano de controlo (C01)
  'public.tenants',
  'public.tenant_domains',
  // Identidade global (C04)
  'public.users',
  'public.auth_sessions',
  'public.one_time_tokens',
  // Catálogo de permissões (C06): igual para todos os tenants, semeado a partir do código
  'public.permissions',
  // Planos e assinaturas SaaS (C02): plano de controlo; a leitura por tenant filtra pelo tenant do contexto
  'public.plan_versions',
  'public.subscriptions',
  'public.subscription_changes',
  // Eventos de segurança (S06): tenant_id opcional, só INSERT/SELECT; a leitura por tenant filtra no repositório
  'public.security_events',
])

/** Tabelas do próprio framework (registo de migrations). Não contêm dados de tenants. */
export const FRAMEWORK_TABLES: ReadonlySet<string> = new Set([
  'public.adonis_schema',
  'public.adonis_schema_versions',
])
