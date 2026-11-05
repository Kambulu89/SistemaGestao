# CLAUDE.md — instruções de desenvolvimento

Aplicação web nova: `frontend/` (Angular 22 + Tailwind CSS 4) e `backend/` (AdonisJS 7, kit API, PostgreSQL 16).
Objectivo: ERP SaaS multiempresa (Prompts 01–22 do utilizador). Estado: Prompts 03, 04 e 05 concluídos; Prompt 06 (contabilidade) com 6.1 e 6.2 feitos (tenants com RLS,
identidade, sessão, contexto de tenant, RBAC com âmbitos, convites, recuperação, estrutura organizacional, planos,
subscrições e entitlements, auditoria, aprovações com delegações, anexos, notificações e centro de tarefas; interface de todas estas áreas com design system, painel e pesquisa global; administração empresarial: perfil e
configurações da empresa, câmbios, séries documentais, calendários, contas bancárias com aprovação, organograma e matriz
de permissões). Arquitectura e invariantes em `docs/architecture.md`; decisões em
`docs/decisions.md`. Um bloco de cada vez; não implementar módulos sem a fundação de que dependem.

## Comandos

- Frontend (`cd frontend`): `npm ci` · `npm run lint` · `npm run format:check` · `npm test` · `npm run build` · `npm start`
- Backend (`cd backend`): `npm ci` · `npm run migrate` (conta dona) · `npm run lint` · `npm run format:check` ·
  `npm run typecheck` · `npm test` · `npm run build` · `npm run dev`
- Node 24. Os testes do backend usam a base `app_test` (`backend/.env.test`).

## Regras

- Frontend: componentes standalone com sinais, `Api` (`core/api.ts`) para todos os pedidos, `Workspace` para a
  empresa/permissões; a navegação filtrada é só usabilidade (a API decide). Sem dados fictícios nem módulos sem backend.
- UI: só tokens semânticos (`docs/design-system.md`), nunca cores do Tailwind; listas com `DataTable`, formulários com
  `FormField`/`appControl`, confirmações com `ConfirmService`; o teste de contraste tem de passar nos dois temas.

- Nunca fazer commit de `.env` nem de segredos (só `*.example` e `backend/.env.test`, que não tem segredos).
- Sem Redis por agora; o estado partilhado fica no PostgreSQL.
- Tabelas de tenant só com `createTenantTable`/`tenantForeignKey`; dados de tenant só via `runInTenant`; módulos importam
  outros só por `index.ts`. Os testes de arquitectura e de esquema falham caso contrário.
- O `X-Tenant-Id` do cliente é só um selector: a autorização vem da membership activa resolvida no servidor.
- API em `/api/v1`, validação com VineJS nos controllers, regras de negócio fora dos controllers.
- Operações sensíveis gravam `audit(scope, …)` na mesma transacção; nunca segredos na auditoria.
- Dinheiro e quantidades nunca em `float` (usar `numeric` e strings na API).
- Rotas novas: o teste `routes_protection` exige `auth`, `tenant` e `can()` (ou justificação explícita) e o
  `isolation_matrix` deve ganhar o novo tipo de registo.
- Cada alteração vem com testes; antes de dar algo por concluído correr lint, formatação, tipos, testes e build nos dois
  lados e dizer o que não foi possível executar.
- Não fazer commit, push, merge, deploy nem operações destrutivas sem autorização explícita.
