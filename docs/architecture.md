# Arquitectura

Este documento descreve a arquitectura **efectivamente implementada** e a que está prevista na especificação
(`docs/especificacao-v2.docx`). Marca sempre a diferença: o que existe, o que é mock e o que ainda não existe.
Última actualização: Fase 0 (preparação técnica).

## 1. Visão geral

```
Browser ── Angular 22 (src/) ──HTTP /api/v1──▶ AdonisJS 6 (backend/) ──▶ PostgreSQL 16 (RLS)
                │                                   │                  └▶ Redis 7 (cache, limites, filas)
          adaptadores mock                          └──▶ (futuro) armazenamento S3 · workers
         (core/mock) — a substituir
```

- **Monólito modular** `API First`. Frontend e backend vivem no mesmo repositório (D-002).
- **Plano de controlo** (plataforma SaaS) separado do **plano de dados** (tenants). O administrador SaaS não tem acesso
  implícito a dados empresariais.
- Estado real: o backend contém apenas a fundação (Fase 0). O frontend é uma aplicação funcional **sobre dados mock**.

## 2. Backend (`backend/`)

AdonisJS 6.21 · Lucid 21 · VineJS 3 · Redis (`@adonisjs/redis`) · Japa 4 · TypeScript 5.9 · Node ≥ 22.

```
backend/
  bin/            entrypoints (server, console, test)
  start/          env (validação), kernel (middleware), routes
  config/         app, bodyparser, cors, database (2 ligações), logger (redacção), redis
  app/
    exceptions/   handler → formato uniforme de erros
    middleware/   container bindings, correlation id, force JSON
    core/
      http/       ApiError, envelope de sucesso/erro, correlation id
      health/     application (CheckReadiness) · infrastructure (sondas DB/Redis) · presentation (controller)
  database/migrations/   baseline da plataforma (função de contexto de tenant + privilégios)
  tests/          unit + functional (Japa)
```

### Estrutura modular prevista (spec §1.2) — ainda **não** criada

```
app/core/{tenancy,auth,permissions,audit,files,settings,events}
app/platform/{tenants,plans,subscriptions,registry}
app/modules/{crm,catalog,sales,purchases,inventory,finance,hr,projects,support}
app/dynamic/{metadata,forms,rules,states,workflows}
app/verticals/{training,school,healthcare,sports,logistics}
```

Só se cria uma pasta quando há código real nela (sem directórios vazios). Cada módulo contém `domain`
(invariantes, sem HTTP), `application` (casos de uso, transacções, políticas, portas), `infrastructure`
(repositórios, filas, fornecedores) e `presentation` (controllers, validadores, rotas). `core/health` já segue este
desenho em miniatura.

### Regras de fronteira (a verificar automaticamente a partir da Fase 1)

1. `domain` não importa `application`, `infrastructure`, `presentation`, `@adonisjs/*` nem `pg`.
2. `application` não importa `presentation`.
3. Um módulo só importa de outro através da sua interface pública (`index.ts` do módulo / porta), nunca das tabelas ou
   ficheiros internos. Um módulo **não escreve** nas tabelas de outro.
4. `core` não depende de módulos de negócio, nem de verticais. Verticais dependem de módulos, nunca o inverso.

> Estado: regras documentadas; **ainda sem verificação automática** (não há módulos para verificar). Entrar em
> `docs/implementation-plan.md`, Fase 1, item 1.1.

## 3. Pedido HTTP (implementado na Fase 0)

1. `container_bindings` regista `HttpContext`/logger.
2. `correlation_id`: gera ou valida `X-Correlation-Id` (`[A-Za-z0-9._-]`, 8–63 caracteres; caso contrário novo UUID);
   expõe-o na resposta e no logger do pedido (`ctx.correlationId`).
3. `force_json`: a API só responde JSON. CORS com lista explícita de origens (credenciais activas).
4. Bodyparser (JSON ≤ 1 MB; multipart não processado automaticamente: uploads usam prepare/complete, Fase 4).
5. Controller → caso de uso. Erros → `HttpExceptionHandler`.

Previsto (spec §10.1) e **ainda não implementado**: autenticar identidade → resolver tenant candidato → validar
membership/estado → `TenantContext` imutável → transacção de acesso com `set_config('app.tenant_id', …, true)` →
RBAC/ABAC → caso de uso → outbox.

## 4. Convenções transversais

| Tema | Convenção |
| --- | --- |
| API | `/api/v1`; DTO `camelCase`; tabelas `snake_case`; UUID em string; `POST` cria com 201 + `Location`; `DELETE` só em rascunhos |
| Sucesso | `{ "data": …, "meta": { "correlationId": "…" } }` (listas acrescentam `meta`/`links`: Fase 1) |
| Erro | `{ "error": { "code", "message", "details": [{ "path", "code", "message" }], "correlationId" } }` — sem stack, SQL ou segredos |
| Códigos | `VALIDATION_ERROR` 422 · `NOT_FOUND` 404 · `UNAUTHENTICATED` 401 · `FORBIDDEN` 403 · `RATE_LIMITED` 429 · `PAYLOAD_TOO_LARGE` 413 · `BAD_REQUEST` 400 · `NOT_READY` 503 · `INTERNAL_ERROR` 500 · conflitos 409 com código de domínio (`VERSION_CONFLICT`, …) |
| Decimais | `money` numeric(19,4), `qty` numeric(19,6), `rate` numeric(9,6): sempre strings na API; sem float |
| Datas | `date` civil (`YYYY-MM-DD`) ≠ `instant` (`timestamptz` UTC, ISO 8601); timezone IANA onde relevante |
| Entidades de tenant | colunas base: `id uuid`, `tenant_id uuid`, `created_at`, `updated_at`, `created_by_membership_id`, `updated_by_membership_id`, `version int = 1`; códigos `[a-z0-9_]+`, `str(50)` |
| Enumerações | códigos em inglês na base; a interface traduz |
| Transacções | um caso de uso = uma `UnitOfWork`; efeitos externos por outbox (assíncronos) |
| Concorrência | `expectedVersion` → 409 `VERSION_CONFLICT`; comandos críticos com `Idempotency-Key` |
| Logs | JSON estruturado; `correlationId` em todos; campos sensíveis redigidos (`config/logger.ts`) |

Convenções de UUID/decimais/datas/erros/transacções ficam aqui, não repetidas nos módulos.

## 5. Base de dados e isolamento

- PostgreSQL 16, base e esquema partilhados no início. Redis 7.
- **Duas contas** (D-006), criadas por `docker/postgres/init/01-roles.sh`:
  - `sg_owner`: dona das bases e do esquema; só migrations e seeds (`npm run migrate`, ligação `owner`).
  - `sg_runtime`: conta da aplicação (ligação `runtime`, por omissão): `NOSUPERUSER`, `NOBYPASSRLS`, sem `CREATE`,
    só DML nas tabelas criadas pela `owner` (default privileges). É por ela que a RLS tem de passar.
- Migration `create_platform_baseline`: função `app_current_tenant_id()` que lê `app.tenant_id` do contexto SQL da
  transacção; sem contexto devolve `NULL` (e, nas políticas, nega).
- Padrão a aplicar a cada tabela de tenant (Fase 1; ver spec §10.1):

  ```sql
  ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE customers FORCE ROW LEVEL SECURITY;
  CREATE POLICY customers_tenant ON customers
    USING (tenant_id = app_current_tenant_id())
    WITH CHECK (tenant_id = app_current_tenant_id());
  ```
  Chaves únicas `(tenant_id, id)` nos alvos e FKs compostas `(tenant_id, target_id)`; índices a começar em `tenant_id`.
- Testado (ver `backend/tests/functional/database.spec.ts`): a conta de runtime não é superuser nem `BYPASSRLS`, não
  altera a estrutura, não lê o registo de migrations; `set_config(..., true)` só vale dentro da transacção e **uma
  ligação reutilizada entre tenants não herda o contexto anterior**.
- Política de eliminação (spec §9.1): `RESTRICT` em documentos, movimentos, pessoas com histórico e configurações
  publicadas; `CASCADE` só em filhos de rascunhos e tabelas de ligação sem história.

## 6. Frontend (`src/`)

Angular 22 standalone + signals + Tailwind 4. Estrutura: `core` (sessão, tenant, módulos, permissões, dinâmico, mock) ·
`shared` (ui + dynamic renderers) · `layouts` · `features`. Regras: `core` não importa `features`/`layouts`;
`shared/ui` é independente de `core`.

- **Dados:** gateways abstractos (`*Gateway`) com adaptadores **mock** (`core/mock`) que simulam o backend. Servem para
  desenvolver a interface; **não são prova de que a funcionalidade existe**. Cada fatia da Fase 1+ substitui o mock
  correspondente por um adaptador HTTP e remove o caminho mock (ver plano).
- **Core Dinâmico** (entidades, campos, formulários, validação, condições, workflow local) já existe em `core/dynamic` e
  `shared/dynamic` com contratos próprios; relação com C10–C15 na secção 7.
- **Segurança no cliente:** guards e menus são só conveniência. Divergência conhecida: o mock guarda o token em
  `sessionStorage`; a especificação (C04) exige **sessão opaca em cookie HttpOnly + Secure + SameSite + CSRF**, a
  implementar na Fase 1 com o backend.

## 7. Comparação com a especificação (estado real)

Legenda: **AUSENTE** (não existe), **MOCK** (existe só no frontend com dados simulados), **PARCIAL**, **FEITO**.

### Fundação (Fase 0)

| Item | Estado | Evidência |
| --- | --- | --- |
| Monólito modular — estrutura base | PARCIAL | `core/http`, `core/health`; restantes módulos por criar |
| Validação de ambiente e `.env.example` | FEITO | `start/env_schema.ts`, `tests/unit/env.spec.ts` |
| Ligação à base e Redis; `health` / `ready` | FEITO | `GET /api/v1/health`, `/ready`; testes funcionais |
| Formato comum de respostas/erros | FEITO | `core/http/*`, `app/exceptions/handler.ts`, `tests/functional/errors.spec.ts` |
| `correlation_id` e logging sem dados sensíveis | FEITO | middleware + `config/logger.ts` + testes |
| Migrations e seeds (convenção) | PARCIAL | migration baseline; **sem seeds** (ainda não há dados de referência) |
| RLS | PARCIAL | só a fundação (`app_current_tenant_id()`, contas); **nenhuma política aplicada** (sem tabelas) |
| Docker de desenvolvimento | PARCIAL | `docker-compose.yml` validado com `docker compose config`; **não executado** (sem daemon no ambiente de análise); sem worker |
| CI | PARCIAL | `.github/workflows/ci.yml` com YAML válido; **não executado** no GitHub |

### Componentes da especificação

| Componente | Backend | Frontend |
| --- | --- | --- |
| C01 Tenants e provisionamento | AUSENTE | MOCK (admin de plataforma, listagem) |
| C02 Planos, assinaturas, limites | AUSENTE | MOCK (planos/subscrições estáticos) |
| C03 Registo de módulos e funcionalidades | AUSENTE | PARCIAL (catálogo e manifestos reais no frontend; activação por tenant é mock) |
| C04 Identidade, autenticação, sessões | AUSENTE | MOCK (login simulado; token em `sessionStorage`) |
| C05 Membros, convites, preferências | AUSENTE | AUSENTE |
| C06 Papéis, permissões, políticas | AUSENTE | PARCIAL (permissões por chave e avaliador RBAC+ABAC no cliente; só conveniência) |
| C07 Organizações, unidades, centros de custo | AUSENTE | AUSENTE |
| C08 Pessoas, organizações externas, contactos | AUSENTE | AUSENTE |
| C09 Configurações, impostos, sequências | AUSENTE | AUSENTE |
| C10 Metadados, entidades dinâmicas, campos | AUSENTE | PARCIAL/MOCK (contratos e motores no cliente; persistência mock) |
| C11 Formulários | AUSENTE | PARCIAL (contratos, motores e integridade; sem Form Builder visual) |
| C12 Regras e fórmulas | AUSENTE | PARCIAL (condições declarativas e fórmulas no cliente; sem editor/AST persistido) |
| C13 Máquinas de estados | AUSENTE | PARCIAL (motor local de workflow de entidade) |
| C14 Workflows, aprovações, delegações | AUSENTE | AUSENTE |
| C15 Automações | AUSENTE | AUSENTE |
| M01–M14, S01–S06 (excepto observabilidade mínima), V01–V06 | AUSENTE | AUSENTE |

### Divergências e pontos a decidir (ver `docs/decisions.md`)

- **Angular 22** (spec refere Angular 19 como referência de fonte): mantido (D-004).
- **AdonisJS v6** fixado (existe v7): mantido (D-003).
- **Nomes de permissões:** o frontend usa `<módulo>.read|manage` e `entities.<chave>.<op>`; a spec usa
  `<recurso>.<acção>` (`invoice.approve`, `platform.tenant.manage`, `dynamic.vehicle.*`). A reconciliar antes de a
  Fase 1 criar o catálogo de permissões (D-014, **aberta**).
- **Selector de tenant:** o frontend usa `/t/:slug`; o servidor tem de o tratar apenas como selector (D-013).
- O dicionário de dados da especificação (B/G, `version`, `created_by_membership_id`…) ainda não tem tabelas.
