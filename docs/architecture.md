# Arquitectura

Monólito modular: `frontend/` (Angular 22 + Tailwind CSS 4) e `backend/` (AdonisJS 7 + PostgreSQL 16). Sem Redis nem
serviços externos nesta fase.

## Módulos do backend

`backend/app/modules/<módulo>/` com `domain/` (regras puras), `application/` (casos de uso), `infrastructure/` (SQL,
serviços técnicos) e `http/` (controllers e middleware, só transporte). Cada módulo expõe a sua API pública em
`index.ts`; os outros importam **só** daí (`tests/unit/architecture.spec.ts` falha caso contrário). `app/shared/` é código
técnico partilhado e não depende de módulos.

| Módulo                                                                                     | Estado    | Responsabilidade                                                                                                               |
| ------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `health`                                                                                   | Feito     | `GET /api/v1/health`                                                                                                           |
| `identity`                                                                                 | Parcial   | Utilizador global, sessão opaca em cookie, CSRF, limite de tentativas. Por fazer: convites, recuperação, sessões do utilizador |
| `tenancy`                                                                                  | Parcial   | Tenant, contexto de tenant, `runInTenant`, memberships. Por fazer: administração de tenants e memberships pela API             |
| `rbac`, `organization`, `subscription`, `approvals`, `audit`, `notifications`, `documents` | Por fazer | Prompt 03, blocos 3.3–3.6                                                                                                      |

## Multi-tenancy

- **Tenant** é a fronteira de isolamento. Tabelas globais enumeradas em `PLATFORM_TABLES`
  (`tenants`, `users`, `auth_sessions`, `rate_limit_counters`); todas as outras têm `tenant_id`.
- Tabelas de tenant criam-se com `createTenantTable` (`database/support/tables.ts`): UUID, `tenant_id`, `version`,
  auditoria, chave `(tenant_id, id)` para FKs compostas (`tenantForeignKey`) e **RLS `ENABLE` + `FORCE`** com política
  sobre `app_current_tenant_id()`. `tests/functional/schema_conformance.spec.ts` falha para qualquer tabela fora do padrão.
- **Duas contas PostgreSQL**: `app_owner` (dona do esquema, migrações, `BYPASSRLS` para manutenção) e `app` (runtime: só
  DML, sem superuser nem `BYPASSRLS`). A aplicação usa sempre `app`.
- **Contexto de tenant**: o middleware `tenant` lê `X-Tenant-Id` (só um selector), confirma a membership **activa** do
  utilizador autenticado e o estado do tenant, e cria o `TenantContext`. O acesso a dados de tenant passa por
  `runInTenant(context, fn)`, que abre uma transacção e define `app.tenant_id` com `set_config(..., true)` (local à
  transacção, nunca fica no pool). Sem contexto: erro, nunca «tenant por omissão».
- A lista das empresas de um utilizador (antes de escolher uma) usa a função `app_user_tenants(user_id)` (SECURITY DEFINER),
  chamada só com o utilizador autenticado.

## Autenticação

- Sessão opaca: token aleatório de 256 bits no cookie HttpOnly `sg_session` (`__Host-` em produção, SameSite=Lax); a base
  guarda só o SHA-256. Inactividade 8 h, máximo 7 dias, revogação no logout.
- CSRF de dupla submissão: cookie `XSRF-TOKEN` (HMAC da sessão com a `APP_KEY`), enviado pelo Angular em `X-XSRF-TOKEN`;
  obrigatório em todos os métodos que alteram dados atrás do middleware `auth`.
- Login: mensagens genéricas, tempo constante quando o email não existe, limite de tentativas por email (10/15 min) e por
  IP (100/15 min) em PostgreSQL (`rate_limit_counters`). Não há registo público: as contas vêm de convites (por fazer) ou da
  administração.

## Respostas e erros

Sucesso `{ data, meta: { requestId } }`; erro `{ error: { code, message, details[], requestId } }` (400, 401, 403, 404,
409, 422, 429, 5xx genérico). Nunca stack, SQL nem segredos. O registo de SQL está desligado.

## Autorização (RBAC)

- Permissões definidas em `app/modules/rbac/domain/permissions.ts` e sincronizadas para `permissions` com
  `node ace catalog:sync` (também actualiza o perfil de sistema `tenant_admin` de todas as empresas).
- Perfis (`roles`) por empresa; atribuições (`membership_roles`) com âmbito `TENANT`, `OWN`, `LEGAL_ENTITY`, `BRANCH`
  ou `DEPARTMENT` (este inclui os subdepartamentos). O alvo fica numa coluna própria com FK composta e um CHECK exige a
  coluna certa para cada âmbito. `permissionScope(scope, permissão)` devolve onde a permissão vale; as rotas de gestão
  continuam a exigir âmbito `TENANT`. Equipas: quando existir o cadastro de equipas.
- Rotas protegidas com `middleware.can({ permission })`; negar por omissão. Só contam membership **activa** e perfis
  **activos**.
- Anti-escalada: um perfil só leva permissões que o actor tem com âmbito de empresa; só se atribui um perfil cujas
  permissões o actor tem; ninguém altera os próprios perfis nem o próprio estado; o último administrador activo não é
  suspenso nem perde o perfil (verificado sob `FOR UPDATE`).

## Convites e email

- Convidar cria (ou reutiliza) a conta global e uma membership `INVITED`; o token de uso único (7 dias) só é emitido
  depois de gravada a membership. Aceitar consome o token e activa a membership na **mesma** transacção.
- Sem fornecedor de email escolhido: `MAIL_DRIVER=none` não envia e a API responde `delivery: NOT_CONFIGURED` (nunca finge
  envio); `dev-memory` guarda a mensagem em memória para testes/desenvolvimento (proibido em produção).

## Estrutura organizacional

- `legal_entities` (código e NIF+país únicos, moeda funcional), `branches` (tipo, entidade legal), `departments` (árvore,
  entidade legal, filial opcional), `positions` (família, categoria, nível 1–20, departamento opcional) e `cost_centers`
  (árvore, código único por entidade legal, departamento opcional). Todos com estado `ACTIVE`/`INACTIVE` e vigência
  `valid_from`/`valid_to` coerente; o código e a entidade legal não mudam depois de criados.
- Filial, pai, departamento e centro de custo referenciados têm de pertencer à **mesma entidade legal**.
- Ciclos impedidos com CTE recursiva sob um bloqueio por empresa e árvore (`pg_advisory_xact_lock`), pedido **antes** de
  bloquear a linha (evita o deadlock com a FK do pai; coberto por teste de concorrência).
- API única `/api/v1/organization/:kind` (`legal-entities`, `branches`, `departments`, `positions`, `cost-centers`) com
  `organization.read` / `organization.manage`; o domínio só aceita os campos declarados (sem mass assignment).
- Repositório genérico de tabelas de tenant em `app/shared/db/tenant_crud.ts` (listagem paginada, filtros por igualdade,
  pesquisa, versão, conflitos de unicidade → 409).

## Subscrições e entitlements

- Tabelas globais (plano de controlo, fora do RLS e só alteradas pela administração da plataforma): `features`
  (catálogo em código, `BOOLEAN` ou `LIMIT`), `plans` (`DRAFT` → `ACTIVE` → `RETIRED`; um plano publicado não muda, por
  trigger), `plan_features`, `subscriptions` (uma corrente por tenant, índice único parcial), `subscription_events`
  (só acrescentar, por trigger) e `tenant_entitlement_overrides` (excepção por funcionalidade, com motivo e validade).
- Estados: `TRIALING` → `ACTIVE` → `SUSPENDED` ↔ `ACTIVE`, qualquer um → `CANCELLED`. `EXPIRED` é derivado (período
  experimental ou período terminado), não gravado. Só `TRIALING` e `ACTIVE` dão funcionalidades.
- Entitlement ≠ autorização: `middleware.entitled({ feature })` responde 403 `NOT_ENTITLED` quando a empresa não
  tem a funcionalidade; a permissão RBAC continua a ser exigida à parte (`can`). Limites com `assertWithinLimit`, que
  conta sob `pg_advisory_xact_lock` por tenant e funcionalidade (409 `LIMIT_REACHED`); hoje `members.max` (convites) e
  `legal_entities.max`.
- Sem plano comercial semeado: preços, faturação e pagamentos ficam para quando houver decisão comercial (D-008).

## Auditoria

- `audit_events` por tenant (RLS), escrito com `audit(scope, { action, entityType, entityId, changes, metadata })` na
  **mesma** transacção da operação: se a operação falha, o evento não fica; se o evento falha, a operação também não.
- Só de acrescentar: a conta de runtime não tem `UPDATE`/`DELETE`/`TRUNCATE` e um trigger recusa alterações a qualquer
  conta. O actor vem do contexto do servidor; `changes` guarda só os campos alterados; chaves com aspecto de segredo
  (`password`, `token`, `hash`, …) ficam `[REDACTED]`.
- Auditado hoje: criação do tenant, convites e aceitação, suspensão/reactivação, atribuição e remoção de perfis,
  perfis, estrutura organizacional, workflows, pedidos e decisões de aprovação, delegações, anexos (carregar,
  descarregar, eliminar). Consulta com `audit.read`.

## Aprovações

- `approval_workflows` (DRAFT → ACTIVE → RETIRED; publicado é imutável, também por trigger nas etapas) com etapas
  ordenadas; aprovador por **perfil** (qualquer membro activo com o perfil activo, em qualquer âmbito) ou por **membro**;
  `requiredApprovals` por etapa. Publicar exige perfis activos com titulares suficientes e membros activos.
- Pedidos (`approval_requests`) sobre um assunto; hoje só `manual` (título e descrição). Os módulos de negócio vão
  registar o seu `subject_type` e o efeito da aprovação no próprio módulo.
- Decidir não depende de uma permissão: depende de ser aprovador da etapa corrente ou delegado activo de um. O pedido
  é bloqueado (`FOR UPDATE`) durante a decisão; `approval_decisions` é só de acrescentar e tem dois índices únicos: um
  voto por aprovador elegível e um voto por pessoa em cada etapa (um delegado que também é aprovador não vota duas vezes).
- Segregação de funções: o requerente (e quem lhe delegou) não decide o próprio pedido. Rejeitar exige motivo.
- Delegações: cada membro delega as suas aprovações (período, motivo, opcionalmente só um workflow); o delegado decide
  "em nome de" e fica registado quem decidiu e por quem. Sem cadeias: só se delega o que se tem directamente.
- Visibilidade: `approvals.read` vê tudo; os restantes vêem os pedidos que fizeram, em que decidiram ou que podem
  decidir agora (os outros respondem 404).

## Anexos

- Metadados em `attachments` (RLS) e ficheiro no armazenamento local (`ATTACHMENTS_DIR`), numa chave gerada pelo
  servidor `<tenant>/<prefixo>/<id>`; nunca o nome enviado. Nome apresentável limpo de caminho e caracteres de controlo.
- Tipo decidido pela extensão (lista fechada: pdf, png, jpg/jpeg, webp, txt, csv, docx, xlsx, odt, ods) e confirmado pela
  assinatura do conteúdo; até 10 MB; SHA-256 gravado e verificado na descarga. Descarga com `attachment`, `nosniff`,
  `no-store` e CSP `sandbox`.
- Acesso herdado: cada `subject_type` tem uma política (funcionalidade contratada + permissões do registo). Ler exige
  ver o registo; escrever exige poder alterá-lo. Quota `attachments.storage_mb` (soma dos activos, sob advisory lock).
- Eliminação lógica (`DELETED`): ficheiro e metadados ficam para a auditoria; purga física por política de retenção
  fica pendente.

## Notificações e centro de tarefas

- `notifications` por destinatário (membership), criadas na transacção do evento (pedido pendente, decisão,
  cancelamento, delegação recebida); o actor não se notifica a si próprio. A leitura filtra sempre pela membership em
  contexto. Só in-app: o email espera fornecedor (D-009).
- `GET /me/tasks` deriva as tarefas das fontes de verdade (hoje: etapas de aprovação que o membro pode decidir, por si ou
  por delegação); não há tabela de tarefas duplicada.

## Frontend

- Angular 22 standalone, sinais e detecção de alterações sem zone; Tailwind 4 com primitivas mínimas em `styles.css`
  (`btn-*`, `input`, `card`, `table`, `badge`) até ao design system do Prompt 04.
- `core/api.ts`: único cliente HTTP; desembrulha `data`/`meta.total` e converte erros em `ApiError` (código, mensagem,
  detalhes por campo, `requestId`). `core/http.ts`: interceptor que envia `X-Tenant-Id` e, num 401, limpa a sessão e
  volta ao login. CSRF pelo mecanismo do Angular (`XSRF-TOKEN` → `X-XSRF-TOKEN`); a sessão é só o cookie HttpOnly.
- `core/session.ts` (`/auth/me`) e `core/workspace.ts` (`/context` + `/me/permissions`): a empresa escolhida fica em
  `localStorage` apenas como preferência; o servidor valida-a em cada pedido.
- Guards: `authGuard`, `tenantGuard` (escolha automática quando há uma só empresa), `accessGuard` (permissão e
  funcionalidade em `data`) e `platformGuard`. Esconder um ecrã nunca substitui a verificação da API.
- Formulários mostram os erros de validação do servidor junto do campo; alterações enviam `expectedVersion` e só os
  campos alterados (os imutáveis nunca se reenviam).
- O painel só mostra dados reais (tarefas, notificações, subscrição); módulos de negócio ausentes não aparecem.
