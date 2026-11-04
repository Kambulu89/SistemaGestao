# Projecto

Estrutura base de uma aplicação web com **frontend Angular 22 + Tailwind CSS 4** e **API AdonisJS 7** sobre
**PostgreSQL 16**. Ainda não tem funcionalidades de negócio: só a moldura da interface, a verificação de saúde da API e a
autenticação por token que vem com o kit API do AdonisJS.

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
# 1. Base de dados (ou use um PostgreSQL já instalado)
cp .env.compose.example .env        # defina DB_PASSWORD
docker compose up -d postgres

# 2. API
cd backend
npm ci
cp .env.example .env                # preencha DB_PASSWORD (igual ao do compose)
node ace generate:key               # gera APP_KEY no .env
node ace migration:run
npm run dev                         # http://localhost:3333

# 3. Frontend (noutro terminal)
cd frontend
npm ci
npm start                           # http://localhost:4200 (o proxy encaminha /api para a porta 3333)
```

Os testes do backend usam a base `app_test` (ver `backend/.env.test`); crie-a antes de os correr.

## Comandos

|            | Frontend (`frontend/`) | Backend (`backend/`)   |
| ---------- | ---------------------- | ---------------------- |
| Lint       | `npm run lint`         | `npm run lint`         |
| Formatação | `npm run format:check` | `npm run format:check` |
| Tipos      | (no build)             | `npm run typecheck`    |
| Testes     | `npm test`             | `npm test`             |
| Build      | `npm run build`        | `npm run build`        |

## API

| Método | Rota                      | Descrição                                                     |
| ------ | ------------------------- | ------------------------------------------------------------- |
| GET    | `/api/v1/health`          | Estado da API e da base de dados (503 se o PostgreSQL falhar) |
| POST   | `/api/v1/auth/signup`     | Cria conta e devolve um token                                 |
| POST   | `/api/v1/auth/login`      | Devolve um token de acesso                                    |
| GET    | `/api/v1/account/profile` | Perfil (exige `Authorization: Bearer <token>`)                |
| POST   | `/api/v1/account/logout`  | Revoga o token actual                                         |

O histórico do projecto anterior (SistemaGestao) continua no Git, até ao commit `2ead09c`.
