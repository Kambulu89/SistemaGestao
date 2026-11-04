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
  `node ace rbac:sync` (também actualiza o perfil de sistema `tenant_admin` de todas as empresas).
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
