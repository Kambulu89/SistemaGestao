# Plano de implementação

Fases da especificação (§11) com estado real. Cada fase entrega **fatias verticais** (migration, domínio, API, UI,
autorização, auditoria, testes). Uma fase só passa quando as verificações aplicáveis correram e a documentação foi
actualizada. Estado actualizado em: Fase 0.

| Fase | Âmbito (spec) | Estado |
| --- | --- | --- |
| **F0** Preparação | repositório, versões, Docker, CI, estrutura modular, ADRs | **Concluída** (com 2 verificações por executar — ver abaixo) |
| **F1** Fundação | C01, C04–C08: identidade, tenant, membership, RBAC/ABAC, organização, Party | **Próxima** (detalhada na secção 2) |
| F2 SaaS | C02, C03, C09, auditoria mínima S06 | Não iniciada |
| F3 Low-code | C10–C15 (Viatura ponta a ponta, Form Builder, regras, estados, aprovações, automações) | Não iniciada (existem contratos/motores no frontend — ver `architecture.md` §7) |
| F4 Operação comercial | M01–M08, S01 | Não iniciada |
| F5 Gestão empresarial | M09–M14, S02–S03 | Não iniciada |
| F6 Informação | S04 | Não iniciada |
| F7 Integrações | S05 | Não iniciada |
| F8 Verticais | V01 primeiro; V02–V06 por necessidade | Não iniciada |
| F9 Escala · F10 Marketplace | SSO, base dedicada, pacotes | Só com evidência |

## 1. Fase 0 — Preparação (concluída)

### Entregue
- Diagnóstico e documentação: `CLAUDE.md`, `docs/architecture.md`, `docs/decisions.md`, este plano; especificação em
  `docs/especificacao-v2.docx`.
- `backend/` (AdonisJS 6): ambiente validado, ligação a PostgreSQL (duas contas) e Redis, `GET /api/v1/health` e
  `/ready`, envelope de sucesso/erro, correlation id, logging com redacção, migration baseline (função de contexto de
  tenant e privilégios), 38 testes (unit + functional), lint, typecheck, build.
- Docker de desenvolvimento (`docker-compose.yml`, `Dockerfile`s, init de contas/bases) e CI (`.github/workflows/ci.yml`).
- `.env.example` (backend), `.env.test.example`, `.env.compose.example`, sem valores secretos.

### Critérios de aceitação e evidência
| Critério | Evidência |
| --- | --- |
| Projecto compila e arranca | `npm run build`; servidor compilado respondeu a `/health` e `/ready` |
| Migrations correm numa base limpa | `drop schema` + `npm run migrate` + `migrate:status` |
| Testes executáveis | `npm test` (backend, 38) e `ng test` (frontend, 582) |
| Ambiente inválido impede o arranque | execução real sem variáveis → `EnvValidationException`; `env.spec.ts` |
| Dependência em baixo → não pronto | `/ready` devolveu 503 `NOT_READY` com o Redis parado |
| Sem segredos em logs | testes de redacção; `grep` do log do servidor sem a palavra-passe |

### Por verificar (dependem de infraestrutura não disponível no ambiente de análise)
- `docker compose up`: o daemon Docker não estava acessível. O ficheiro foi validado com `docker compose config`, e a
  rotina `01-roles.sh` foi executada contra um PostgreSQL 16 local; **os contentores não foram arrancados**.
- CI no GitHub Actions: o YAML é válido e os mesmos passos foram corridos localmente; o pipeline **não foi executado**.

## 2. Fase 1 — próxima fatia: isolamento e identidade

Componentes da spec: C01 (mínimo), C04, C05, C06, C07, C08. Itens pedidos: Tenant, User, TenantMembership,
Organization/OrganizationUnit, autenticação, resolução e propagação de `TenantContext`, permissões e âmbitos de acesso,
isolamento por tenant e testes negativos com dois tenants.

### Ordem e dependências

| # | Fatia | Depende de | Entrega |
| --- | --- | --- | --- |
| 1.1 | ✅ **Núcleo de multi-tenancy e esquema** (feita — ver secção 2.1) | F0 | colunas base B/G; padrão de migration de tabela de tenant (RLS `ENABLE`+`FORCE`, política, FK composta `(tenant_id,id)`); `TenantContext` imutável; `TenantScopedConnection` (transacção + `set_config` local; sem contexto → erro); repositório base que exige contexto; **teste de conformidade do esquema** (toda a tabela com `tenant_id` tem RLS forçada e política); verificação automática das fronteiras de módulo |
| 1.2 | **Tenant e utilizadores** (C01 mínimo, C04) | 1.1 | `Tenant`, `TenantDomain`, `User`, `AuthSession`; login/logout com sessão opaca em cookie HttpOnly+Secure+SameSite, CSRF, hash de palavra-passe, rate limit em Redis, sessões activas/revogação; recuperação com token de uso único. MFA e SSO ficam **fora** (documentar) |
| 1.3 | **Membership e contexto** (C05 parte 1) | 1.2 | `TenantMembership`; pipeline de resolução do tenant (spec §10.1) como middleware; `GET /context` com `authorizationVersion`; troca de tenant; suspensão de tenant bloqueia operações |
| 1.4 | **Autorização** (C06) | 1.3 | `Permission` (catálogo por seed), `Role`, `RolePermission`, `RoleAssignment`, `MembershipScope`, `AccessPolicy` (AST ABAC declarativa, sem código); *default deny*, DENY prevalece, filtro de linhas antes de paginar, regras de campo; `POST /authorization/simulate`; decidir D-014 antes de começar |
| 1.5 | **Organização** (C07) | 1.4 | `Organization`, `OrganizationUnit` (árvore sem ciclos, pai da mesma organização), `CostCenter`, `TeamMember`; FKs compostas |
| 1.6 | **Convites e membros** (C05 parte 2) | 1.4, 1.5 | `Invitation` (aceitação exige controlo do email), quotas (stub declarado), último administrador protegido, invalidação da versão de autorização, preferências |
| 1.7 | **Party** (C08) | 1.5 | `Party`/`Person`/`OrganizationParty`/`Contact`/`Address`; aviso de duplicados (sem fusão automática). *Item da spec F1 que não constava do pedido: confirmar se entra nesta fase.* |
| 1.8 | **Frontend real** | 1.2–1.6 | adaptadores HTTP para auth/tenant/contexto/membros/papéis/organização; remover os mocks correspondentes; mapeamento de permissões (D-014); selector de tenant que cancela pedidos e limpa caches; sessão em cookie |
| 1.9 | **Matriz de isolamento** | todas | dois tenants de demonstração + utilizadores com papéis distintos; testes negativos (abaixo) em CI |

### 2.1 Fatia 1.1 — concluída
**Entregue:** `TenantContext` imutável e `TenantContextStore`; `LucidTenantDatabase` (transacção + `set_config` local);
`TenantRepository` (colunas base, versões, 404/409); helpers `createTenantTable`/`createGlobalTable`/`tenantForeignKey`;
enumeração explícita de tabelas globais; verificador de conformidade do esquema; verificador de fronteiras de módulo
(R1–R6). Detalhe em `docs/architecture.md` §2 e §5 e ADRs D-016/D-017.

**Evidência (executada):** 73 testes backend a passar (35 novos), incluindo: sem contexto → falha antes de abrir ligação;
RLS isola sem o filtro do repositório e **também a conta dona** (FORCE RLS); `WITH CHECK` recusa escrita noutro tenant;
FK composta recusa ligação A→B; 30 alternâncias A/B sobre o pool sem herdar contexto; 40 pedidos concorrentes só vêem os
seus dados; `expectedVersion` (sucesso, 409, 404 para outro tenant, corrida entre 3 escritores → 1 vence); rollback total;
colunas reservadas rejeitadas; conformidade do esquema com 6 controlos negativos (tabela sem `tenant_id`, `tenant_id`
nulo, RLS não forçada, política sem `WITH CHECK`, sem chave `(tenant_id,id)`, FK simples) e esquema real sem violações;
fronteiras de módulo com um controlo negativo por regra. Lint, `format:check`, `typecheck`, `build` e migrations numa
base limpa a passar.

**Limitações assumidas:** as tabelas dos testes vivem num esquema `probe` (fixtures criadas com os helpers reais): ainda
não há tabelas de domínio. A FK `tenant_id → tenants` só passa a existir na fatia 1.2 (os helpers já a geram por
omissão). Cache, jobs, ficheiros, pesquisa, exportações e WebSocket não existem ainda: a respectiva matriz de isolamento
fica para quando forem criados. O `TenantContext` ainda não é **construído** por nenhum middleware (fatia 1.3).

### Critérios de aceitação da Fase 1
Gate da spec: *"Testes negativos em dois tenants aprovados"*, mais os critérios de aceitação de cada componente:

- **Isolamento (dois tenants com códigos semelhantes):** ler/escrever IDs do outro tenant por API → 404 sem vazar
  existência; FK composta rejeita ligação entre tenants; RLS com a conta de runtime nega sem contexto e com contexto
  alheio; ligação reutilizada entre A e B não herda contexto; `tenant_id` no corpo do pedido é ignorado/rejeitado.
  (Cache, jobs, ficheiros, pesquisa, relatórios, exportações e WebSocket: **não existem na Fase 1** — o teste passa a
  existir quando a funcionalidade for criada e fica registado como pendente em cada fase.)
- **C01:** utilizador suspenso (tenant) não lê dados por URL directa; domínio duplicado → 409.
- **C04:** token expirado ou reutilizado falha; logout impede novo pedido autenticado; troca de tenant não reutiliza
  permissões anteriores; cookies/segredos não aparecem em logs; mensagens de recuperação não revelam se o email existe.
- **C05:** utilizador de A convidado em B mantém conta única; convite revogado falha; último administrador não sai sem
  sucessor; reduzir acesso invalida caches/`authorizationVersion` imediatamente.
- **C06:** operador sem `invoice.approve`-equivalente recebe 403; ID alheio → 404; campo restrito oculto em API/pesquisa/
  exportação/auditoria (a parte de exportação/pesquisa fica pendente até existirem); DENY prevalece; simulação não concede.
- **C07:** unidade não é pai de si própria nem de antepassado; centro de custo de outra organização rejeitado.
- **C08** (se incluída): fornecedor empresarial sem `Person`; pessoa cliente e colaborador sem duplicar contactos.
- **Concorrência/idempotência:** convites e criação de membership com limite de utilizadores sob concorrência.
- **Definição de concluído (spec §11.2):** constraints, API documentada (OpenAPI), regras no servidor, permissões e
  isolamento testados, UI com sucesso/vazio/erro/409, auditoria das mutações críticas, migrations/seeds numa base limpa,
  sem mocks no caminho real.

### Decisões a tomar antes de começar a Fase 1
1. Nomenclatura de permissões (D-014).
2. Se Party (1.7) entra na Fase 1 ou na seguinte.
3. Mecanismo de hash e de rate limit (proposta: hash do Adonis + limitador Redis); MFA fora da Fase 1.
4. Biblioteca/ferramenta para OpenAPI (a documentação de cada endpoint é obrigatória).
5. Primeiros dois tenants de demonstração (nomes, países/moeda) — parâmetros identificados como demonstração.

## 3. Regras para todas as fases
- Antes de codificar: mapa de ficheiros, entidades, contratos e testes de aceitação.
- Cada fase termina com lint, typecheck, testes, build e migrations numa base limpa; resultados registados aqui.
- Actualizar `docs/architecture.md` (estado real), `docs/decisions.md` e o OpenAPI.
- Registar o que ficou **por verificar** e porquê, sem o apresentar como concluído.
