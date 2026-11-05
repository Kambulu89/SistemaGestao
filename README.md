# Projecto

ERP SaaS multiempresa em construção: **frontend Angular 22 + Tailwind CSS 4** e **API AdonisJS 7** sobre **PostgreSQL 16**.
Estado actual: fundação parcial (tenants com isolamento por RLS, utilizadores globais, memberships, sessão em cookie com
CSRF e limite de tentativas, contexto de tenant). Ainda sem módulos de negócio. Ver `docs/architecture.md` e
`docs/decisions.md`.

## Requisitos

- Node.js 24 (o Angular CLI exige ≥ 22.22.3 ou 24.15)
- PostgreSQL 16 (local ou `docker compose up -d postgres`)

## Estrutura

| Pasta       | Conteúdo                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `frontend/` | Angular 22 (componentes standalone, sinais), Tailwind CSS 4, testes com Vitest, ESLint (angular-eslint) |
| `backend/`  | AdonisJS 7 (kit API), Lucid + PostgreSQL, VineJS, autenticação por token de acesso, testes com Japa     |

## Arranque local

```bash
# 1. PostgreSQL com as contas app_owner (migrações) e app (runtime, sem BYPASSRLS)
cp .env.compose.example .env        # defina as três palavras-passe
docker compose up -d postgres       # cria as contas e as bases app e app_test
#    (sem Docker: com um superuser, DB_PASSWORD=… DB_OWNER_PASSWORD=… DATABASES="app app_test" docker/postgres/create-roles.sh)

# 2. API
cd backend
npm ci
cp .env.example .env                # DB_PASSWORD e DB_OWNER_PASSWORD iguais aos do passo 1
node ace generate:key               # gera APP_KEY no .env
npm run migrate                     # migrações com a conta dona
node ace catalog:sync               # catálogos de permissões e de funcionalidades
node ace plan:create BASE "Base" --feature=organization --feature=approvals --limit=members.max=25 \
  --limit=legal_entities.max=5 --limit=attachments.storage_mb=100 --publish
node ace user:create --email=admin@exemplo.ao --name="Administrador"   # pede a palavra-passe
node ace tenant:create ACME "Acme, Lda." --admin-email=admin@exemplo.ao
node ace subscription:start ACME BASE --skip-trial   # sem subscrição, o tenant não tem funcionalidades
node ace platform:admin --email=admin@exemplo.ao    # opcional: acesso a /api/v1/platform
npm run dev                         # http://localhost:3333

# 3. Frontend (noutro terminal)
cd frontend
npm ci
npm start                           # http://localhost:4200 (o proxy encaminha /api para a porta 3333)
```

Os testes do backend usam a base `app_test` (`backend/.env.test`) e correm as migrações com a conta dona.
Ainda não há interface de administração nem seed de demonstração: tenants e o primeiro administrador criam-se com os
comandos acima; os restantes membros entram por convite (`POST /api/v1/members/invitations`).

## Comandos

|            | Frontend (`frontend/`) | Backend (`backend/`)   |
| ---------- | ---------------------- | ---------------------- |
| Lint       | `npm run lint`         | `npm run lint`         |
| Formatação | `npm run format:check` | `npm run format:check` |
| Tipos      | (no build)             | `npm run typecheck`    |
| Testes     | `npm test`             | `npm test`             |
| Build      | `npm run build`        | `npm run build`        |

## API

| Método | Rota                  | Acesso                                       | Descrição                                                                                   |
| ------ | --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/health`      | público                                      | Estado da API e da base (503 se o PostgreSQL falhar)                                        |
| POST   | `/api/v1/auth/login`  | público, com limite de tentativas            | Cria sessão (cookies `sg_session` e `XSRF-TOKEN`) e devolve o utilizador e as suas empresas |
| GET    | `/api/v1/auth/me`     | sessão                                       | Utilizador e empresas                                                                       |
| POST   | `/api/v1/auth/logout` | sessão + CSRF                                | Revoga a sessão                                                                             |
| GET    | `/api/v1/context`     | sessão + `X-Tenant-Id` com membership activa | Contexto da empresa                                                                         |

Subscrições (bloco 3.5): `GET /api/v1/tenant/subscription` (permissão `subscription.read`) devolve o plano, o estado e as
funcionalidades efectivas da empresa. A administração da plataforma (`users.is_platform_admin`, sessão + CSRF, sem
`X-Tenant-Id`) fica em `/api/v1/platform`: `features`, `plans` (criar, editar em rascunho, `publish`, `retire`),
`tenants` (listar, criar, suspender), `tenants/:id/subscription` (ver, iniciar), `subscriptions/:id/transitions` e
`tenants/:id/entitlements/:feature` (PUT/DELETE de excepções com motivo e validade).

Transversais (bloco 3.6), todas com `X-Tenant-Id`:

- `GET /api/v1/audit-events` (`audit.read`): auditoria da empresa, filtros `entityType`, `entityId`, `action` (ou
  prefixo `member.*`), `actorUserId`, `from`, `to`.
- `GET /api/v1/me/notifications` (`?unread=true`), `POST /api/v1/me/notifications/:id/read`,
  `POST /api/v1/me/notifications/read-all`; `GET /api/v1/me/tasks` (centro de tarefas).
- `/api/v1/approvals` (funcionalidade `approvals`): `workflows` (`approvals.manage`: criar, editar em rascunho,
  `publish`, `retire`, eliminar rascunho), `available-workflows` e `POST requests` (`approvals.request`), `requests`,
  `requests/:id`, `requests/:id/decisions`, `requests/:id/cancel`, `delegations`, `delegations/:id/revoke`.
- `/api/v1/attachments`: `GET ?subjectType=&subjectId=`, `POST` (multipart: `file`, `subjectType`, `subjectId`),
  `GET :id/content`, `DELETE :id`. O acesso herda do registo (`legal_entity`, `branch`, `department`, `position`,
  `cost_center`, `approval_request`).

O histórico do projecto anterior (SistemaGestao) continua no Git, até ao commit `2ead09c`.
