# Sistema de Gestão (frontend)

Base do frontend em **Angular 22** + **Tailwind CSS 4**, com Standalone Components, Signals, lazy loading, ESLint, Prettier e Vitest.

## Requisitos

- Node.js `^22.22.3` ou `^24.15.0` (exigência do Angular CLI 22)
- npm 10+

## Comandos

| Comando                     | Descrição                                        |
| --------------------------- | ------------------------------------------------ |
| `npm install`               | Instala as dependências                          |
| `npm start`                 | Servidor de desenvolvimento em `localhost:4200`  |
| `npm run start:prod`        | Serve com a configuração de produção             |
| `npm test`                  | Testes unitários (Vitest, modo watch)            |
| `npm test -- --watch=false` | Testes numa única execução (CI)                  |
| `npm run lint`              | ESLint (TypeScript, templates e acessibilidade)  |
| `npm run format`            | Formata com Prettier (`format:check` só verifica) |
| `npm run build`             | Build de produção em `dist/sistema-gestao`       |

## Estrutura

```
src/
├── environments/          # environment.ts (produção) e environment.development.ts
└── app/
    ├── core/              # singletons globais
    │   ├── config/        # APP_ENVIRONMENT (token injectável)
    │   ├── guards/        # guards de rota (a preencher)
    │   ├── interceptors/  # errorInterceptor → ApiError
    │   └── services/      # ApiService (cliente REST), ThemeService
    ├── shared/            # reutilizável e sem lógica de negócio
    │   ├── components/    # Button, Card, Icon
    │   ├── directives/
    │   └── pipes/
    ├── features/          # funcionalidades (lazy loaded): home, not-found
    ├── layouts/           # MainLayout = header + sidebar + conteúdo
    └── models/            # interfaces e tipos
```

Regra de dependências: `features` → `shared`/`core`/`models`; `shared` → `models`; `core` → `models`. Nunca o inverso, e as `features` não importam umas das outras.

## Decisões principais

- **Standalone + OnPush + Signals + `inject()`**: sem NgModules; estado em signals (`ThemeService`).
- **Lazy loading** por rota (`loadComponent`); cada feature é um chunk separado. O layout carrega de imediato por ser a casca da aplicação.
- **Tailwind 4** via `@tailwindcss/postcss` (`.postcssrc.json`) e `@import 'tailwindcss'` em `src/styles.css`. Não há `tailwind.config.js`: a configuração vive em CSS (`@theme`).
- **Design tokens**: paleta `brand-*` e cores semânticas (`bg-surface`, `text-fg`, `border-line`…) que mudam com o tema, evitando `dark:` repetido.
- **Modo claro/escuro/sistema**: classe `.dark` em `<html>`, preferência em `localStorage`, aplicada por script inline antes da primeira pintura (sem flash).
- **Acessibilidade**: link "saltar para o conteúdo", landmarks, `aria-current`, `aria-expanded`, foco visível, `prefers-reduced-motion` e regras `templateAccessibility` no ESLint.
- **API REST**: `ApiService` usa `environment.apiUrl`; `errorInterceptor` converte qualquer falha HTTP num `ApiError` uniforme. Ajuste `apiUrl` em `src/environments/`.
- **Ambientes**: `ng build` (produção) usa `environment.ts`; `ng serve` / `--configuration development` substituem-no por `environment.development.ts`.

## Adicionar uma feature

1. Criar `src/app/features/<nome>/` com o componente de página.
2. Registar a rota lazy em `app.routes.ts` (antes do `**`).
3. Acrescentar a entrada em `layouts/main-layout/nav-items.ts`.
