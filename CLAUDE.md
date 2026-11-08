# CLAUDE.md — instruções de desenvolvimento

Aplicação web nova: `frontend/` (Angular 22 + Tailwind CSS 4) e `backend/` (AdonisJS 7, kit API, PostgreSQL 16).
Objectivo: ERP SaaS multiempresa (Prompts 01–22 do utilizador). Estado: Prompts 03, 04 e 05 concluídos; Prompt 06 (contabilidade) com 6.1 a 6.8 e 6.10 feitos (6.9 SAF-T bloqueado pela especificação oficial); interface profissional em curso (UI-1: identidade Corporate Blue, AppShell por domínios, paleta, favoritos e painel; UI-2: modelos de lista, formulário e configurações, filtros na URL, colunas, vista rápida e rascunhos; UI-3: modelos de aprovação, relatório, assistente, calendário, kanban e pré-visualização, centro de notificações; UI-4: modelos aplicados à organização, tabelas da empresa, perfis, auditoria, razão e analítica; UI-5: contabilidade, demonstrações e barra de acções nos formulários de edição; UI-6: aprovações, notificações, plataforma e varredura de acessibilidade/responsividade); Prompt 07 (RH) em curso com 7.1 (ficha do colaborador com âmbitos e dados pessoais por campo), 7.2 (recrutamento e onboarding), 7.3 (contratos com adendas e carreira com vigência) , 7.4 (férias e ausências com política versionada) , 7.5 (compensação com incidência IRT/INSS versionada) e 7.6 (adiantamentos e empréstimos com limites configurados e liquidação única) feitos (tenants com RLS,
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
