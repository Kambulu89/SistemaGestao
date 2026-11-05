# Projecto

ERP SaaS multiempresa em construção: **frontend Angular 22 + Tailwind CSS 4** e **API AdonisJS 7** sobre **PostgreSQL 16**.
Estado actual: **fundação do Prompt 03 concluída** (blocos 3.1–3.8): empresas isoladas por RLS, identidade e sessão,
RBAC com âmbitos, estrutura organizacional, planos e subscrições, auditoria, aprovações, anexos, notificações e a interface
de todas estas áreas. Ainda sem módulos de negócio (contabilidade, RH, inventário…). Ver `docs/architecture.md`,
`docs/decisions.md` e o relatório `docs/reports/prompt-03.md`.

## Requisitos

- Node.js 24 (o Angular CLI exige ≥ 22.22.3 ou 24.15)
- PostgreSQL 16 (local ou `docker compose up -d postgres`)

## Estrutura

| Pasta       | Conteúdo                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `frontend/` | Angular 22 (componentes standalone, sinais), Tailwind CSS 4, testes com Vitest, ESLint (angular-eslint) |
| `backend/`  | AdonisJS 7 (kit API), Lucid + PostgreSQL, VineJS, sessão em cookie HttpOnly + CSRF, testes com Japa     |

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

### Dados de demonstração (opcional, só desenvolvimento)

Em vez dos comandos do passo 2 a partir de `plan:create`, pode criar uma empresa fictícia já preenchida:

```bash
cd backend
DEMO_PASSWORD='uma-frase-com-12-ou-mais' npm run seed:demo   # sem DEMO_PASSWORD gera uma e mostra-a uma vez
```

Cria o plano `DEMO`, a empresa `DEMO` (entidade legal, filiais, departamentos, cargo, centro de custo, perfis `aprovador`
e `colaborador`, workflow `DESPESAS`) e as contas `admin@demo.invalid`, `aprovacao@demo.invalid` e
`colaborador@demo.invalid`. Não altera nada se a empresa `DEMO` já existir e o Lucid recusa-o em produção. São dados
fictícios: não usar como referência fiscal ou legal.

### Verificação rápida

1. `http://localhost:4200` → entrar com `colaborador@demo.invalid` → **Aprovações → Novo pedido** (workflow `DESPESAS`).
2. Entrar com `aprovacao@demo.invalid` → o pedido aparece em **As minhas tarefas** e nas notificações → aprovar.
3. Entrar com `admin@demo.invalid` → **Auditoria** mostra o pedido e a decisão; **Organização** tem os registos
   de demonstração.

## Interface (frontend)

Em `http://localhost:4200`: `/entrar`, `/recuperar`, `/redefinir-palavra-passe?token=`, `/aceitar-convite?token=` (as
ligações dos emails), `/empresas` (escolha da empresa; com uma só, entra directamente) e, dentro da aplicação:

| Área          | Ecrãs                                                                                              | Acesso                                                       |
| ------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Geral         | Painel (tarefas, notificações, subscrição), Notificações, A minha conta (sessões)                  | sessão + empresa                                             |
| Organização   | Entidades legais, filiais, departamentos, cargos, centros de custo (lista, criar, alterar, anexos) | `organization.read`/`manage` + funcionalidade `organization` |
| Administração | Membros (convidar, suspender, perfis com âmbito), Perfis, Subscrição, Auditoria                    | `members.*`, `roles.*`, `subscription.read`, `audit.read`    |
| Aprovações    | Para decidir, pedidos, novo pedido, detalhe (decidir, cancelar, anexos), delegações, workflows     | funcionalidade `approvals` (+ `approvals.request`/`manage`)  |
| Plataforma    | Empresas (criar, suspender, subscrição, excepções, histórico), Planos (criar, publicar, retirar)   | `is_platform_admin`                                          |

A navegação esconde o que o membro não pode usar ou a empresa não contratou; a autorização é sempre a da API.

Moldura e atalhos (Prompt 04): tema claro/escuro/sistema e modo compacto no menu da conta; troca de empresa e âmbito
de trabalho (entidade legal/filial) na barra superior; pesquisa global com **Ctrl+K** ou **/**; menu lateral
recolhível; trilho de navegação e títulos por página. Componentes e tokens em `docs/design-system.md`.

## Comandos

|            | Frontend (`frontend/`) | Backend (`backend/`)   |
| ---------- | ---------------------- | ---------------------- |
| Lint       | `npm run lint`         | `npm run lint`         |
| Formatação | `npm run format:check` | `npm run format:check` |
| Tipos      | (no build)             | `npm run typecheck`    |
| Testes     | `npm test`             | `npm test`             |
| Build      | `npm run build`        | `npm run build`        |

O que os testes do backend garantem (além dos testes de cada módulo):

- `routes_protection.spec.ts`: cada rota registada é pública por lista, de conta, de plataforma ou de empresa com
  `can()` (ou com a autorização no caso de uso, justificada); um membro sem perfis recebe 403 em todas as rotas `can()`.
- `isolation_matrix.spec.ts`: o administrador de outra empresa recebe 404 em leituras e escritas de cada tipo de
  registo, não consegue referir ids de outra empresa e as listas não misturam dados; `X-Tenant-Id` alheio dá 403.
- `schema_conformance.spec.ts`: todas as tabelas de empresa têm RLS forçada e política.
- `hardening.spec.ts` e testes de módulo: concorrência (convites, limites, quotas, decisões, árvores, último
  administrador), tokens expirados, integridade dos anexos.
- Cada execução aplica e reverte todas as migrações.

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
