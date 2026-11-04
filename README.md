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
npm run dev                         # http://localhost:3333

# 3. Frontend (noutro terminal)
cd frontend
npm ci
npm start                           # http://localhost:4200 (o proxy encaminha /api para a porta 3333)
```

Os testes do backend usam a base `app_test` (`backend/.env.test`) e correm as migrações com a conta dona.
Ainda não há administração pela interface nem seed de demonstração: os utilizadores e tenants de teste são criados pelos
testes.

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

O histórico do projecto anterior (SistemaGestao) continua no Git, até ao commit `2ead09c`.
