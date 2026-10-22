# Plataforma de Gestão Empresarial

Plataforma SaaS **multi-tenant, modular e configurável**. Este repositório tem duas partes:

| Parte | Pasta | Estado |
| --- | --- | --- |
| Frontend (Angular 22 · Tailwind 4) | raiz (`src/`) | ligado à API para identidade, tenants, membros, convites, organização e perfis; o resto (core dinâmico, plataforma) ainda sobre **dados mock** |
| Backend (AdonisJS 6 · PostgreSQL 16 · Redis) | [`backend/`](backend/) | **Fase 0, Fase 1 (fatias 1.1–1.9) e Fase 2 fatias 2.1–2.4**: tenants, autenticação, membros e convites, autorização RBAC+ABAC, organização, Party, matriz de isolamento, auditoria mínima, planos e assinaturas, registo de módulos e configurações/sequências. Sem módulos de negócio |

Contrato funcional: [`docs/especificacao-v2.docx`](docs/especificacao-v2.docx). Regras permanentes: [`CLAUDE.md`](CLAUDE.md).
Arquitectura: [`docs/architecture.md`](docs/architecture.md) · decisões: [`docs/decisions.md`](docs/decisions.md) ·
plano e estado das fases: [`docs/implementation-plan.md`](docs/implementation-plan.md).

> **Segurança:** isolamento de dados e verificação efectiva de permissões são responsabilidade do **backend**.
> Guards, menus filtrados e elementos ocultos no frontend servem apenas para navegação e experiência de utilização.

## Executar o backend (desenvolvimento)

Requisitos: Node ≥ 22.22, PostgreSQL 16, Redis 7 (ou Docker).

**Opção A — Docker Compose** (PostgreSQL, Redis, MinIO, API e frontend):

```bash
cp .env.compose.example .env        # preencher os valores (openssl rand -hex 16; APP_KEY: openssl rand -hex 32)
docker compose up --build
docker compose exec api npm run migrate
curl localhost:3333/api/v1/ready
```

**Opção B — serviços locais:**

```bash
# 1) Contas e bases (uma vez). Define as palavras-passe que vai pôr no .env do backend.
SG_OWNER_PASSWORD=... SG_RUNTIME_PASSWORD=... POSTGRES_USER=postgres bash docker/postgres/init/01-roles.sh
# 2) API
cd backend
cp .env.example .env                 # preencher APP_KEY (node ace generate:key) e as palavras-passe
npm ci
npm run migrate                      # conta sg_owner
npm run dev                          # http://localhost:3333/api/v1/health
```

Validar (backend): `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build`.
Os testes usam a base `sistema_gestao_test` (`cp .env.test.example .env.test` e preencher).
Endpoints actuais: `health`, `ready`, `auth/*` (login, logout, recuperação, verificação de email) e `me/*` (utilizador,
sessões, palavra-passe, tenants), `context`, `roles`, `role-assignments`, `access-policies`, `permissions`, `authorization/simulate`, `organizations`, `organization-units`, `cost-centers`, `membership-scopes`, `memberships`, `invitations`, `me/preferences`, `parties`, `people` e `organization-parties` — contrato em `backend/openapi/openapi.yaml`.

Gestão da plataforma (sem API HTTP ainda): `node ace tenant:create|tenant:status|tenant:domain:add|tenant:domain:verify`
`USER_PASSWORD=… node ace user:create <email> <nome> --verified` e `node ace membership:add|membership:status <tenant> <email> [estado]` e, para planos (D-030), `node ace plan:create|plan:publish|plan:retire|plan:list` e `subscription:assign|subscription:change|subscription:status <tenant> …` e `modules:sync` (registo de módulos, D-031) e `node ace iam:sync` / `iam:bootstrap <tenant> <email>`
(catálogo de permissões e papel `tenant_admin`; correr `iam:sync` em cada ambiente depois de migrar).
Os pedidos de tenant (`GET /context`) indicam o tenant em `X-Tenant-Id` ou `X-Tenant-Code`. Dados de demonstração (dois tenants, só fora de
produção): `DEMO_USER_PASSWORD=… npm run seed`. Em desenvolvimento use `MAIL_DRIVER=dev-redis` (as mensagens com tokens
ficam na lista Redis `dev:mailbox`); não há fornecedor de email real.

---

# Frontend

> Em desenvolvimento o frontend (`ng serve`, `:4200`) fala com a API em `http://localhost:3333/api/v1` (ver
> `src/environments/environment.development.ts`); a API tem de ter `CORS_ORIGINS=http://localhost:4200` (a sessão é um cookie
> `HttpOnly`, enviado com `withCredentials`). Contas de demonstração: ver o seeder do backend (`DEMO_USER_PASSWORD`).

Angular 22 · Tailwind CSS 4 · TypeScript estrito · Signals · RxJS · Reactive Forms · Vitest.

## Requisitos

- Node.js `^22.22.3` ou `^24.15.0` (exigência do Angular CLI 22) · npm 10+

## Comandos

| Comando                     | Descrição                                         |
| --------------------------- | ------------------------------------------------- |
| `npm install`               | Instala as dependências                           |
| `npm start`                 | Servidor de desenvolvimento em `localhost:4200`   |
| `npm test -- --watch=false` | Testes unitários (Vitest); sem a flag, modo watch |
| `npm run lint`              | ESLint (TypeScript, templates e acessibilidade)   |
| `npm run format`            | Prettier (`format:check` apenas verifica)         |
| `npm run build`             | Build de produção em `dist/sistema-gestao`        |

### Contas de demonstração (palavra-passe `demo1234`)

| Email                | O que demonstra                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `plataforma@demo.pt` | Platform Admin (`/platform`) + suporte na Escola Horizonte                                       |
| `multi@demo.pt`      | **Secretário** na Escola (menu reduzido) e **Administrador** na Clínica (plano Starter em teste) |
| `escola@demo.pt`     | Administrador da Escola Horizonte (plano Business, funcionalidades e parâmetros activos)         |

## O catálogo: 46 capacidades

O catálogo oficial tem **19 grupos** e **46 capacidades**, divididas em dois tipos:

| Tipo         | Qtd | O que é                                                                                                                                                                                                                                                            |
| ------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fundação** | 11  | Estrutural: Multi-Tenancy, Tenant Management, Subscription, Feature Flags, Module Registry, Autenticação, Utilizadores, RBAC/ABAC, Empresa e unidades, Notificações, Auditoria. Sempre activas, **não se contratam nem se desactivam**; só dependem de permissões. |
| **Módulo**   | 35  | Unidade funcional contratável e activável por tenant (CRM, Comercial, Compras, Inventário, Financeiro, RH, Projectos, Atendimento, Documentos, Agenda, Workflow, Reporting, Integrações, Governance, Configuração, Equipas, Centros de custo).                     |

Nenhum dos 35 módulos tem lógica de negócio: usam um ecrã provisório (`ModuleScaffold`) que mostra o que a arquitectura já resolve para eles.

### Os sete conceitos

| Conceito        | Contrato                                    | Onde vive                                              |
| --------------- | ------------------------------------------- | ------------------------------------------------------ |
| Grupo funcional | `ModuleGroup`                               | `core/modules/catalog/module-groups.ts`                |
| Módulo          | `ModuleManifest`                            | manifesto junto de cada feature                        |
| Funcionalidade  | `ModuleFeature` (no manifesto)              | por módulo; disponibilizada por tenant                 |
| Permissão       | `PermissionDefinition`                      | declarada no manifesto do módulo                       |
| Feature Flag    | `FeatureFlagService` + `flag`/`featureFlag` | contexto do tenant; liga módulo ou funcionalidade      |
| Tenant Module   | `TenantModule`                              | decisão do tenant: activo, funcionalidades, parâmetros |
| Subscription    | `Subscription` + `Plan`                     | `core/subscription`: módulos incluídos e limites       |

### Contratado ≠ activado ≠ autorizado

`resolveModuleAccess` (função pura, `core/modules/module-access.ts`) avalia por esta ordem:

1. **ciclo de vida** — `retired` nunca fica acessível
2. **subscrição utilizável** — `trial`, `active`, `past_due`; `suspended`/`cancelled` bloqueiam
3. **contratado** — o módulo está em `Subscription.moduleIds`? (`not-contracted`)
4. **activado** — o tenant activou-o? (`inactive`)
5. **dependências** — contratadas **e** activas? (`missing-dependency`; não recursivo)
6. **feature flag** do módulo (`flag-disabled`)
7. **autorizado** — o utilizador tem a `accessPermission`? (`forbidden`)

Só `accessible` aparece no menu. A página **Módulos** do tenant mostra todos, com o motivo.
Uma funcionalidade (`resolveFeatureAccess`) exige ainda: módulo acessível + disponibilizada no `TenantModule` + flag + permissão própria.

## Arquitectura

```
Plataforma SaaS → Core Empresarial → Módulos Gerais → Motor de Personalização → Módulos Verticais → Integrações
```

```
src/app/
├── module-catalog.ts       raiz de composição: lista de todos os manifestos
├── module-routes.ts        gera as rotas lazy dos módulos a partir dos manifestos
├── core/                   infraestrutura transversal (não importa de features/layouts/shared)
│   ├── modules/            ModuleManifest, defineModule, ModuleRegistryService,
│   │                       TenantModulesService, resolveModuleAccess, validação do catálogo
│   │   └── catalog/        grupos e capacidades de fundação
│   ├── subscription/       Plan, Subscription, limites
│   ├── tenant-context/     tenant activo, memberships, TenantContext
│   ├── permissions/        catálogo/isolamento de permissões, PermissionService
│   ├── navigation/         NavigationService (menus) e BreadcrumbService
│   ├── auth/ config/ api/ guards/ interceptors/
│   ├── mock/               adapters mock — a única pasta a apagar ao ligar o backend
│   └── testing/
├── shared/ui/              design system (independente de core)
├── layouts/                auth-layout · platform-layout · tenant-layout
└── features/
    ├── auth/  system/      login, recuperação, 404, sem acesso
    ├── platform/           painel, tenants, catálogo de módulos, planos, subscrições, configurações
    ├── tenant/             painel, módulos, permissões, utilizadores, organização, configurações,
    │                       module-scaffold  (+ manifestos: equipas, governance)
    ├── business/           manifestos: organização, crm, sales, procurement, inventory, finance,
    │                       hr, projects, support, documents, calendar
    ├── dynamic/            manifestos: workflow, reporting, integrations, configuration
    └── verticals/          módulos por sector (vazio)
```

Dependências permitidas: `features → layouts/shared/core`; `layouts → shared/core`; `shared/ui` não importa de `core` (`shared/dynamic` importa de `core/dynamic`); `core` não importa de `features` nem de `layouts`. Só `module-catalog.ts`/`module-routes.ts` (raiz de composição) conhecem todas as features. Features de negócio não se importam entre si.

### Rotas

| URL                                            | Layout           | Protecção                           |
| ---------------------------------------------- | ---------------- | ----------------------------------- |
| `/`                                            | —                | decide: login / plataforma / tenant |
| `/auth/login`, `/auth/forgot-password`         | `AuthLayout`     | `guestGuard`                        |
| `/platform/**`                                 | `PlatformLayout` | `authGuard`, `platformGuard`        |
| `/t/:tenantSlug/**`                            | `TenantLayout`   | `authGuard`, `tenantGuard`          |
| `/t/:slug/<code com / >` (ex. `crm/customers`) | `TenantLayout`   | `moduleGuard` + permissão da rota   |

O tenant vai no URL (deep links, vários separadores, sem estado escondido). As rotas dos módulos são geradas dos manifestos, em lazy loading.

### Integração com o backend

Cada domínio define um `*Gateway` abstracto e `core/mock/` fornece os adapters mock (`provideMockBackend()`). Para ligar a uma API real: adapters HTTP sobre `ApiService` e trocar os providers; nenhum componente muda. Os manifestos **não** vêm da API (referenciam código: rotas lazy); o backend só diz o que o tenant contratou e activou.

Pressupostos **provisórios** a confirmar com o backend (nenhum endpoint está inventado): cabeçalho `X-Tenant-Id`, `Authorization: Bearer`, parâmetros de listagem `page/pageSize/sort=chave:dir`, e a forma de `TenantContext` (permissões, subscrição, tenant modules, flags). O token fica em `sessionStorage` só para a demonstração; com backend, preferir cookie `httpOnly`.

Isolamento de âmbitos: `platform.*` só pode vir da sessão da plataforma; nem `*` num papel de tenant a concede.

## Core Dinâmico (Dynamic Core Engine)

Plataforma orientada por metadados: `EntityDefinition → motores → interfaces e operações`.
Não existe nenhum componente específico de uma entidade; `npm run check:generic` falha se o código genérico passar a referir Viatura, Condutor, etc.

```
core/dynamic/      contratos (models/), motores puros (engine/), gateways (data-access/), registo e acesso
shared/dynamic/    DynamicFormRenderer, DynamicListRenderer (reutilizáveis por qualquer feature)
features/dynamic-core/  administração (Configuração → Core Dinâmico) e páginas de registos
core/mock/         definições e repositório mock (simula o BACKEND, não o frontend)
```

| Peça                                                                                                                             | Responsabilidade                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EntityDefinition`, `FieldDefinition` (união discriminada, 22 tipos), `FormDefinition`, `StatusDefinition`, `WorkflowDefinition` | metadados versionados (`draft → published → archived`), âmbito `global` ou `tenant`                                                              |
| `Condition`                                                                                                                      | gramática declarativa única (`eq/in/and/or/not…`) para visibilidade, obrigatoriedade, validações, transições e políticas. Nunca código do tenant |
| motor de validação                                                                                                               | regras executáveis no cliente; `unique` é decidida só pelo servidor; padrões protegidos contra ReDoS                                             |
| `evaluateOperation`                                                                                                              | RBAC (permissões `entities.<chave>.<op>` do IAM existente) + ABAC (políticas "negar quando…")                                                    |
| workflow                                                                                                                         | transições com condição, permissão, aprovação e acções declarativas; sem workflow, mudança livre                                                 |
| `DynamicEntityRegistryService`                                                                                                   | definições do tenant activo; nunca mistura tenants                                                                                               |
| compatibilidade                                                                                                                  | `diffDefinitions`/`checkPublishable`: remover/renomear campo, mudar tipo ou retirar opção bloqueia a publicação. Nenhuma migração automática     |

### Contratos de API (propostos, não existentes)

`ENTITY_API` em `core/dynamic/data-access/entity-api-paths.ts`: `GET/POST v1/entities`, `GET v1/entities/{key}/definition`, `GET/POST v1/entities/{key}/records`, `GET/PATCH/DELETE …/records/{id}`, `POST …/transitions`, `GET …/audit`. O tenant viaja em `X-Tenant-Id`.

### Persistência futura (sem stack de backend definida)

Híbrida: tabelas relacionais para o estrutural; definições versionadas em tabela própria; atributos configuráveis em `JSONB` com índices GIN/expressão nos campos pesquisáveis; `tenant_id` em todas as linhas com row-level security; auditoria append-only. A stack do backend tem de ser decidida antes de implementar.

### Custom Fields e entidades dinâmicas

Extensão do mesmo núcleo (sem segundo motor, registo ou sistema de permissões); documentação completa, contratos de API e DDL PostgreSQL em [`docs/custom-fields-e-entidades.md`](docs/custom-fields-e-entidades.md).

- **Campos personalizados por tenant** em entidades nativas `extensible` (ex.: Cliente): `CustomFieldDefinition` → `mergeCustomFields` → o registo devolve uma `EntityDefinition` normal; um tenant nunca vê os campos de outro.
- **Entidades criadas pelo tenant** só com metadados (designer em Configuração → Core Dinâmico → *Nova entidade*): formulários, listagens, pesquisa, filtros, permissões `entities.<chave>.*`, auditoria e menu «Dados» são gerados.
- **22 tipos** com capacidades por tipo (`FIELD_TYPE_CATALOG`): inclui moeda com precisão, fórmulas declarativas (aritmética decimal exacta, sem JS, ciclos detectados), valores relacionados com as permissões do alvo, numeração automática atribuída pelo servidor, referência a entidade/utilizador, ficheiro/imagem.
- **Versões**: rascunho → publicado → arquivado; alterações destrutivas bloqueiam a publicação; arquivar nunca apaga dados.
- **Permissões** `configuration.forms.read | manage | publish`; campos `sensitive` exigem permissões explícitas de leitura/escrita e o servidor nunca devolve o que o utilizador não pode ler.

Demonstração: `escola@demo.pt` (admin da Escola Horizonte) e `frota@demo.pt` (Transportes Atlas) têm campos personalizados **diferentes** em *Clientes*; em *Core Dinâmico → Nova entidade* cria-se, por exemplo, um *Equipamento* e aparece logo em «Dados».

### Demonstração

`frota@demo.pt` (admin) e `operador@demo.pt` (permissões limitadas) nos Transportes Atlas: Viaturas (v1→v2), Condutores (regras condicionais, referência) e Notas (global). A Escola vê Clientes (com os seus campos personalizados) e Notas.

## Acrescentar um módulo (sem tocar no core)

1. Criar `features/<área>/<módulo>/<módulo>.manifest.ts` com `defineModule({ code, name, group, dependencies, features, settings, … })`.
   Permissões por omissão: `<code>.read` e `<code>.manage`; `accessPermission` por omissão: `<code>.read`.
2. Acrescentá-lo ao array em `module-catalog.ts`.
3. Sem `routes`, usa o `ModuleScaffold`. Para o implementar, declarar `routes: [{ path, title, permission?, loadComponent }]` no manifesto.
4. O backend passa a poder incluí-lo em planos/subscrições (`moduleId(code)`) e activá-lo por tenant.

O teste `module-catalog.spec.ts` valida o catálogo (ids/códigos únicos, grupos, dependências, ciclos) e que planos e dados mock só referenciam módulos existentes.

## Design system

Tailwind 4 sem `tailwind.config.js`: tokens em `src/styles.css` (`@theme`). Cores semânticas (`bg-surface`, `text-fg`, `border-line`…) mudam com o tema claro/escuro/sistema. Platform Admin usa sidebar escura e etiqueta "Administração global".
Componentes: Button, Input (Reactive Forms), Badge, Alert, Card, PageHeader, EmptyState, LoadingState, Breadcrumb, Dropdown, Table, Pagination, SidebarNav, Shell, Icon, Spinner. Select, Checkbox e Dialog só serão criados quando houver uso concreto.

## Fora do âmbito desta fase

Lógica de negócio dos 35 módulos, CRUD real (utilizadores, organização, activação de módulos), motor de personalização, auditoria, e adapters HTTP.
