# Relatório — Prompt 03 (arquitectura SaaS multiempresa e fundação técnica)

Estado: **blocos 3.1 a 3.8 implementados e verificados**, no branch `claude/pensive-clarke-5gm075` (3.4–3.8 ainda não
estão na `main`; 3.1–3.3 entraram pelo PR #2). Este relatório resume o que existe, onde está a prova e o que falta.
Nada aqui foi copiado do projecto anterior (arquivado em `archive/legacy-sistemagestao-v1`).

## Critérios de aceitação do Prompt 03

| Critério                              | Estado   | Evidência                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duas empresas isoladas                | Cumprido | RLS forçada em todas as tabelas de empresa (`schema_conformance.spec.ts`); conta de runtime sem `BYPASSRLS` nem posse das tabelas (`tenancy.spec.ts`); FKs compostas `(tenant_id, id)`; matriz de isolamento com 18 acessos cruzados → 404, referências cruzadas recusadas e listas sem mistura (`isolation_matrix.spec.ts`) |
| Autenticação, membership e RBAC reais | Cumprido | Sessão opaca em cookie HttpOnly + CSRF, limite de tentativas (`auth.spec.ts`); membership activa obrigatória, `X-Tenant-Id` só selector (`tenancy.spec.ts`, `isolation_matrix.spec.ts`); perfis com âmbitos, anti-escalada, último administrador (`rbac.spec.ts`, `organization.spec.ts`)                                    |
| Administração funcional               | Cumprido | Interface (bloco 3.7) para empresa, estrutura organizacional, membros, perfis, subscrição, auditoria, aprovações e plataforma; verificada no browser com dois utilizadores (20 passos)                                                                                                                                       |
| Planos aplicados                      | Cumprido | `middleware.entitled`, limites e quotas sob bloqueio (`subscription.spec.ts`, `hardening.spec.ts`); entitlement separado da permissão (D-008)                                                                                                                                                                                |
| Autorização no backend                | Cumprido | Todas as rotas classificadas automaticamente (pública, conta, plataforma ou empresa com `can()`/autorização justificada) e um membro sem perfis recebe 403 em todas as rotas `can()` (`routes_protection.spec.ts`)                                                                                                           |
| Testes documentados                   | Cumprido | README (secção Comandos), este relatório; CI corre lint, formatação, tipos, testes e build nos dois lados                                                                                                                                                                                                                    |

## Blocos

| Bloco | Conteúdo                                                                                 | Commit               |
| ----- | ---------------------------------------------------------------------------------------- | -------------------- |
| 3.1   | Monólito modular (`app/modules/*` com `index.ts` público), teste de arquitectura         | `5dab682`            |
| 3.2   | Tenants, `runInTenant`, RLS com contas dona/runtime, contexto de empresa                 | `5dab682`            |
| 3.3   | Utilizadores globais, memberships, sessão, convites, recuperação, RBAC com anti-escalada | `3469e10`            |
| 3.4   | Entidades legais, filiais, departamentos, cargos, centros de custo; âmbitos de perfis    | `c577d7b`            |
| 3.5   | Funcionalidades, planos, subscrições, excepções, limites, API de plataforma              | `a1f6498`            |
| 3.6   | Auditoria só de acrescentar, aprovações com delegações, anexos, notificações, tarefas    | `61bd24c`            |
| 3.7   | Interface web de todas as áreas acima                                                    | `47e6a1f`            |
| 3.8   | Testes transversais, dados de demonstração, documentação, este relatório                 | (commit deste bloco) |

## Modelo de dados

12 migrações (`backend/database/migrations/0001`–`0012`). Globais (plano de controlo, enumeradas em `PLATFORM_TABLES`):
`tenants`, `users`, `auth_sessions`, `rate_limit_counters`, `permissions`, `one_time_tokens`, `features`, `plans`,
`plan_features`, `subscriptions`, `subscription_events`, `tenant_entitlement_overrides`. Todas as outras são de empresa,
criadas com `createTenantTable` (RLS, versão, auditoria de criação/alteração). Históricos só de acrescentar:
`audit_events`, `approval_decisions`, `subscription_events` (trigger e, onde aplicável, sem privilégios de alteração).

## Testes e resultados (última execução)

| Lado     | Comando                                                                           | Resultado                                                                            |
| -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Backend  | `npm run lint` · `format:check` · `typecheck` · `build`                           | sem erros                                                                            |
| Backend  | `npm test` (Japa, base `app_test`, aplica e reverte as 12 migrações)              | 68/68, três execuções seguidas                                                       |
| Frontend | `npm run lint` · `format:check` · `build`                                         | sem erros                                                                            |
| Frontend | `npm test` (Vitest)                                                               | 21/21                                                                                |
| Browser  | cenário Playwright contra o backend real (dois utilizadores, telemóvel e desktop) | 20/20 passos, 0 erros na consola (executado no bloco 3.7; guião fora do repositório) |

Cobertura por tema: isolamento (`tenancy`, `schema_conformance`, `isolation_matrix`, e um teste por módulo); RBAC
(`rbac`, `routes_protection`); concorrência (árvores, último administrador, convites e limites, quotas de anexos,
decisões simultâneas, decisão contra cancelamento, aceitação simultânea do mesmo convite); convites (aceitação única,
expirado, inválido, duplicado); workflows (imutável publicado, retirado sem pedidos novos, segregação de funções,
delegação); anexos (tipos, assinatura, quota, permissões herdadas, integridade SHA-256).

## Dados de demonstração e execução local

`npm run seed:demo` (só desenvolvimento/testes; o Lucid recusa em produção) cria a empresa fictícia `DEMO` com contas
`@demo.invalid`, sem alterar nada se já existir. Execução local completa no README (Docker ou PostgreSQL local).

## Riscos e pendências

| Tema                   | Situação                                                                   | Próximo passo                                                             |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Email                  | Só `none` e `dev-memory`; convites e recuperação não chegam a caixas reais | Escolher fornecedor (decisão do utilizador)                               |
| Anexos eliminados      | Ficam no disco (eliminação lógica)                                         | Política de retenção e purga                                              |
| Aprovadores por perfil | Contam em qualquer âmbito do perfil                                        | Restringir por âmbito quando houver pedidos ligados a registos de negócio |
| Delegação              | Escolher o delegado exige `members.read`                                   | Directório mínimo de colegas (decisão)                                    |
| Teste no browser       | Não corre no CI                                                            | Introduzir com o design system (Prompt 04) ou no Prompt 15                |
| Design system          | Primitivas mínimas                                                         | Prompt 04                                                                 |
| `main`                 | 3.4–3.8 só no branch                                                       | PR quando autorizado                                                      |

Próximo: Prompt 04 (design system), depois Prompt 05 (administração empresarial).
