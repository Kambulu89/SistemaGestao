# Plataforma de Gestão Empresarial (frontend)

Fundação frontend de uma plataforma SaaS **multi-tenant, modular e configurável**.
Angular 22 · Tailwind CSS 4 · TypeScript estrito · Signals · RxJS · Reactive Forms · Vitest.

> **Segurança:** isolamento de dados e verificação efectiva de permissões são responsabilidade do backend.
> Guards, menus filtrados e elementos ocultos no frontend servem apenas para navegação e experiência de utilização.

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

| Email                | O que demonstra                                                                         |
| -------------------- | --------------------------------------------------------------------------------------- |
| `plataforma@demo.pt` | Administração global (`/platform`) + suporte na Escola Horizonte                        |
| `multi@demo.pt`      | Dois tenants, papéis diferentes: **Secretário** na Escola, **Administrador** na Clínica |
| `escola@demo.pt`     | Administrador da Escola Horizonte (sem acesso à plataforma)                             |

## Arquitectura

```
Plataforma SaaS → Core Empresarial → Módulos Gerais → Motor de Personalização → Módulos Verticais → Integrações
```

```
src/app/
├── core/                 infraestrutura transversal (não conhece UI nem features)
│   ├── auth/             sessão: AuthService + AuthGateway (contrato)
│   ├── tenant-context/   tenant activo e memberships: TenantContextService + TenantGateway
│   ├── permissions/      catálogo de permissões e PermissionService
│   ├── modules/          manifesto, ModuleRegistryService, resolveModuleAccess
│   ├── navigation/       NavigationService (menus) e BreadcrumbService
│   ├── config/           AppConfigService, FeatureFlagService, ThemeService, ambiente
│   ├── api/              ApiService, paginação/ordenação/filtros, ApiError
│   ├── guards/           auth, guest, platform, tenant, permission, module, home-redirect
│   ├── interceptors/     auth (token + tenant) e error (ApiError, 401)
│   ├── mock/             adapters mock — a única pasta a apagar ao ligar o backend
│   └── testing/          utilitários de teste
├── shared/ui/            design system (sem dependência de core): button, input, table, shell…
├── layouts/              auth-layout · platform-layout · tenant-layout (+ componentes de layout)
└── features/
    ├── auth/             login, recuperação de palavra-passe
    ├── system/           404 e "sem acesso"
    ├── platform/         administração global (painel, tenants, planos, subscrições)
    ├── tenant/           administração de uma organização (painel, organização, utilizadores, configurações)
    ├── business/         módulos gerais (CRM, financeiro, RH…)     — vazio
    ├── dynamic/          motor de personalização e workflows       — vazio
    └── verticals/        módulos por sector                        — vazio
```

Dependências permitidas: `features → layouts/shared/core`; `layouts → shared/core`; `shared` não importa de `core`; `core` não importa de `features` nem de `layouts`. Features de negócio não se importam entre si: partilham-se contratos em `core`.

### Rotas

| URL                                     | Layout           | Protecção                           |
| --------------------------------------- | ---------------- | ----------------------------------- |
| `/`                                     | —                | decide: login / plataforma / tenant |
| `/auth/login`, `/auth/forgot-password`  | `AuthLayout`     | `guestGuard`                        |
| `/platform/**`                          | `PlatformLayout` | `authGuard`, `platformGuard`        |
| `/t/:tenantSlug/**`                     | `TenantLayout`   | `authGuard`, `tenantGuard`          |
| `/t/:slug/modules/:moduleId[/:section]` | `TenantLayout`   | `moduleGuard`                       |

O tenant vai no URL: deep links funcionam, vários separadores podem ter tenants diferentes e não existe estado "escondido" a dessincronizar.

### Módulo instalado ≠ contratado ≠ activado ≠ autorizado

`resolveModuleAccess` (função pura em `core/modules/module-access.ts`) avalia, por ordem:
**catálogo** (manifesto) → **contratado** (plano) → **activado** (decisão do tenant) → **dependências** → **feature flag** → **permissões**.
O resultado é um estado explícito (`accessible`, `not-contracted`, `inactive`, `missing-dependency`, `flag-disabled`, `forbidden`).
A navegação do tenant mostra apenas `accessible`; o painel do tenant mostra todos, com o motivo.

O estado de activação **não** vive no manifesto (que é global) mas em `TenantModuleState`.
Dependências avaliam-se de forma não recursiva (basta estarem contratadas e activadas).

### Integração com o backend

Cada domínio define um `*Gateway` abstracto (o contrato) e `core/mock/` fornece adapters mock, ligados em `provideMockBackend()` (`app.config.ts`).
Para ligar a uma API real: criar adapters HTTP sobre `ApiService` e trocar os providers. Nenhum componente muda.

Pressupostos **provisórios** a confirmar com o backend (nenhum endpoint está inventado):
cabeçalho `X-Tenant-Id` (`core/api/api.constants.ts`), `Authorization: Bearer`, parâmetros de listagem `page/pageSize/sort=chave:dir` (`pageRequestToParams`), e a forma de `TenantContext` devolvida ao activar um tenant.
O token guarda-se em `sessionStorage` só para a demonstração; com backend, preferir cookie `httpOnly`.

### Design system

Tailwind 4 sem `tailwind.config.js`: tokens em `src/styles.css` (`@theme`). Cores semânticas (`bg-surface`, `text-fg`, `border-line`…) mudam com o tema claro/escuro/sistema, evitando `dark:` repetido. A administração global usa sidebar escura e etiqueta "Administração global" para não se confundir com a de um tenant.
Componentes actuais: Button, Input (Reactive Forms), Badge, Alert, Card, PageHeader, EmptyState, LoadingState, Breadcrumb, Dropdown, Table, Pagination, SidebarNav, Shell, Icon, Spinner.

## Adicionar um módulo

1. Registar o `ModuleManifest` no catálogo (backend; em dev, `core/mock/mock-data.ts`).
2. Implementar o módulo em `features/business|dynamic|verticals/<módulo>/` com as suas rotas lazy.
3. Ligar as rotas em `features/tenant/tenant.routes.ts` (substituindo o `ModulePlaceholder`) com `moduleGuard`.

## Fora do âmbito desta etapa

Auditoria, motor de personalização (formulários/workflows/regras), CRUD de utilizadores/organização, Select/Checkbox/Dialog e os módulos de negócio e verticais.
