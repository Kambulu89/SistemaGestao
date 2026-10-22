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
| 1.2 | ✅ **Tenant e utilizadores** (feita — ver secção 2.2) (C01 mínimo, C04) | 1.1 | `Tenant`, `TenantDomain`, `User`, `AuthSession`; login/logout com sessão opaca em cookie HttpOnly+Secure+SameSite, CSRF, hash de palavra-passe, rate limit em Redis, sessões activas/revogação; recuperação com token de uso único. MFA e SSO ficam **fora** (documentar) |
| 1.3 | ✅ **Membership e contexto** (feita — ver secção 2.3) (C05 parte 1) | 1.2 | `TenantMembership`; pipeline de resolução do tenant (spec §10.1) como middleware; `GET /context` com `authorizationVersion`; troca de tenant; suspensão de tenant bloqueia operações |
| 1.4 | ✅ **Autorização** (C06; feita — ver secção 2.4) | 1.3 | `Permission` (catálogo por seed), `Role`, `RolePermission`, `RoleAssignment`, `MembershipScope`, `AccessPolicy` (AST ABAC declarativa, sem código); *default deny*, DENY prevalece, filtro de linhas antes de paginar, regras de campo; `POST /authorization/simulate`; decidir D-014 antes de começar |
| 1.5 | ✅ **Organização** (C07; feita — ver secção 2.5) | 1.4 | `Organization`, `OrganizationUnit` (árvore sem ciclos, pai da mesma organização), `CostCenter`, `TeamMember`; FKs compostas |
| 1.6 | ✅ **Convites e membros** (C05 parte 2; feita — ver secção 2.6) | 1.4, 1.5 | `Invitation` (aceitação exige controlo do email), quotas (stub declarado), último administrador protegido, invalidação da versão de autorização, preferências |
| 1.7 | ✅ **Party** (C08; feita — ver secção 2.7) | 1.5 | `Party`/`Person`/`OrganizationParty`/`Contact`/`Address`; aviso de duplicados (sem fusão automática). *Item da spec F1 que não constava do pedido: confirmar se entra nesta fase.* |
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
fica para quando forem criados. O `TenantContext` passou a ser construído pelo middleware `tenant` na fatia 1.3.

### 2.2 Fatia 1.2 — concluída
**Entregue:** migrations `tenants`, `tenant_domains`, `users`, `auth_sessions`, `one_time_tokens`; módulos `core/auth`
(login, logout, `GET /me`, sessões activas e revogação, alteração de palavra-passe, recuperação, verificação de email)
e `platform/tenants` (ciclo de vida, domínios únicos e verificação); middleware `auth`/`origin`; comandos `tenant:create`,
`tenant:status`, `tenant:domain:add|verify`, `user:create`; seeder de demonstração (dois tenants, só fora de produção,
palavra-passe via `DEMO_USER_PASSWORD`); `openapi/openapi.yaml` com teste de paridade com as rotas. ADRs D-013/D-018–D-022.

**Evidência (executada):** 117 testes backend a passar (44 novos): login com cookie `HttpOnly`/`SameSite`, token só como
hash na base; credenciais inválidas indistinguíveis (3 causas); 429 + `Retry-After`; CSRF em falta/de outra sessão → 403;
`Origin` alheio → 403; logout impede o pedido seguinte; sessão expirada e conta bloqueada → 401; sessão alheia → 404;
alteração de palavra-passe revoga as outras sessões; recuperação: resposta igual com/sem conta, token de uso único
(reuso → 400, **4 pedidos concorrentes → 1 vence**), expirado/inventado → 400, palavra-passe fraca não gasta o token,
pedido novo invalida o anterior; verificação de email de uso único; email duplicado → 409; domínio duplicado → 409
(entre tenants e com maiúsculas); máquina de estados do tenant. Conformidade do esquema e fronteiras de módulo (R1–R6)
a passar com o código novo. Lint, `format:check`, `typecheck`, `build` e migrations numa base limpa (`drop schema` +
`migrate` + `migrate:status`) a passar; seeder corrido duas vezes (idempotente); servidor compilado: login real `200`
com cookie e `401` indistinguível, sem a palavra-passe no log.

**Por verificar / limitações assumidas:**
- Sem fornecedor de email (D-021): recuperação e verificação só são testáveis via `dev-redis`.
- `trustProxy` por configurar (D-020): o IP de rate limit é o do socket.
- Não existe auditoria (`AuditLog`/`SecurityEvent`, Fase 2): login, logout e alterações de palavra-passe **não** são
  registados num log de auditoria; só há logs estruturados sem segredos.
- "Tenant suspenso bloqueia operações" e a troca de tenant ficaram cobertos na fatia 1.3 (2.3); aqui só estava testada
  a máquina de estados. Não há API HTTP de plataforma para tenants (apenas comandos).
- Tabelas globais de identidade sem RLS (D-022). `ProvisioningStep` adiado. MFA/SSO fora.
- Frontend não ligado (fatia 1.8); o `sessionStorage` do mock mantém-se até lá.
- Teste de "cookies/segredos fora dos logs" cobre a configuração de redacção (unit) e uma verificação manual do log do
  servidor compilado; não há teste automático que capture os logs de um pedido real.

### 2.3 Fatia 1.3 — concluída
**Entregue:** migration `tenant_memberships` (RLS forçada, `unique(tenant_id,user_id)`, `authorization_version`, política de
leitura própria); módulo `core/membership` (estados INVITED/ACTIVE/SUSPENDED/LEFT, `AddMember`, `ChangeMembershipStatus`,
directório de leitura por utilizador); em `platform/tenants`: `ResolveTenantContext`, `ListMyTenants`, middleware `tenant`,
`GET /context`, `GET /me/tenants`; comandos `membership:add|status`; seeder com memberships (inclui um utilizador nos dois
tenants); OpenAPI actualizado. ADR D-023.

**Evidência (executada):** 132 testes backend a passar (15 novos): selector em falta/inválido/ambíguo → 400; contexto por id
e por código; sem membership ≡ tenant inexistente (mesma resposta 403); membership convidada não dá acesso; troca A↔B devolve
a membership de cada tenant e quem só pertence a A recebe 403 em B; suspender a membership corta o acesso da sessão já
aberta de imediato e `authorizationVersion` sobe (1→2→3); `LEFT` terminal (409), membership inexistente (404), duplicada
(409); tenant suspenso → 403 `TENANT_NOT_ACTIVE` por URL directa (e 403 genérico para quem não é membro) e volta ao
reactivar; `/me/tenants` só com membership activa; domínio verificado como selector, não verificado ignorado, conflito →
400; RLS: sem contexto 0 linhas, leitura por utilizador só devolve as suas, `app.user_id` não permite inserir nem alterar.
Lint, `format:check`, `typecheck`, `build` e migrations numa base limpa (4 migrations) a passar; seeder corrido duas vezes;
comandos `membership:status` executados; o dono vê 0 linhas sem contexto (FORCE RLS).

**Por verificar / limitações:**
- `GET /context` não traz módulos, funcionalidades, permissões nem configurações (C03/C06/C09 não existem).
- `unitScope` fica vazio (nega por omissão) até haver `MembershipScope`/organizações (1.4/1.5).
- Sem API HTTP de membros/convites (1.6); `AddMember` com `userId` inexistente depende da FK e não tem tradução de erro
  própria (só é chamado por comandos que verificam o utilizador antes).
- Sem auditoria das mudanças de membership/tenant (Fase 2). Sem cache de contexto: cada pedido consulta tenant e membership.
- O pedido paga duas consultas extra por pedido de tenant (tenant + membership); optimizar só se a medição o justificar.

### 2.4 Fatia 1.4 — concluída
**Entregue:** migration `permissions` (global) + `roles`, `role_permissions`, `role_assignments`, `access_policies` (tenant,
RLS forçada); módulo `core/permissions` (catálogo, condições ABAC declarativas, decisão RBAC+ABAC, regras de campo, casos
de uso de papéis/atribuições/políticas/simulação, `EnsureTenantAdmin`); middleware `can`; endpoints `/permissions`,
`/roles`, `/role-assignments`, `/access-policies`, `POST /authorization/simulate`; `permissions` em `GET /context`;
comandos `iam:sync` e `iam:bootstrap`; seeder dá `tenant_admin` aos administradores demo; OpenAPI actualizado.
ADRs D-014 (aceite) e D-024.

**Evidência (executada):** 160 testes backend a passar (28 novos). Unit: validação da AST (operadores/variáveis/profundidade/
tamanho/`in`), avaliação (decimais `"100"` > `"99.99"`, segregação de funções, sem acesso a `constructor`/`__proto__`),
decisão (default deny, DENY prevalece mesmo com ALLOW de prioridade maior, DENY inválido falha fechado, ALLOW sem match
nega, rascunho/desactivada/outro recurso ignorados, `*`, atribuição por unidade, `HIDDEN` > `READ_ONLY`, `redactFields`,
`forbiddenChanges`). Funcionais: operador sem papel → 403 e admin → 200; criar/alterar/apagar papéis (422, 409 de código e
de versão); papel de sistema imutável; atribuir dá acesso de imediato e revogar corta, `authorizationVersion` sobe;
alterar permissões do papel invalida quem o tem; papel em uso não se apaga; janelas de validade (expirada, futura,
corrente, invertida → 422); isolamento (papéis/membership/atribuições de outro tenant → 404; admin de A em B → 403);
política DENY activa bloqueia mesmo com o papel, rascunho/desactivada não, versão sobe; AST inválida → 422 com caminho;
regras de campo guardadas e devolvidas; simulação mostra origem, não altera nada, exige `iam.manage`, membership alheia
→ 404; RLS em `roles`/`role_assignments`. Lint, `format:check`, `typecheck`, `build`, migrations numa base limpa (5) e
seeder duas vezes a passar; servidor compilado: `GET /context` do admin demo devolve as permissões e o selector do outro
tenant dá 403.

**Por verificar / limitações:**
- `MembershipScope` e hierarquia de unidades: 1.5 (atribuições por unidade só casam com `resource.unitId` igual).
- Filtro de linhas antes de paginar/agregar e ocultação de campos em pesquisa, exportação, auditoria e realtime: o motor
  (`decide`, `redactFields`) existe e está testado, mas **ainda não há** listagens de domínio, pesquisa, exportações nem
  realtime onde aplicá-lo; a verificação ponta-a-ponta (ex.: "salário restrito não surge numa exportação") fica para
  quando existirem.
- Aprovação própria/segregação: expressável por política DENY (testado ao nível da condição), sem fluxo de aprovação real.
- Sem protecção do último administrador (um admin pode retirar-se `tenant_admin`; 1.6) nem auditoria (Fase 2).
- Sem cache de decisões; sem rate limit específico nos endpoints de IAM.
- O catálogo só tem permissões do núcleo (`iam`, `member`, `organization`); cada módulo acrescenta as suas.

### 2.5 Fatia 1.5 — concluída
**Entregue:** migration `organizations`, `organization_units`, `cost_centers`, `team_members`, `membership_scopes` (mais as FKs
compostas de `role_assignments.organization_unit_id` e `tenant_memberships.default_organization_id`); módulo `core/organization`
(casos de uso, store Lucid, API `/organizations`, `/organization-units`, `/organization-units/:id/members`, `/team-members/:id`,
`/cost-centers`, `/membership-scopes`); `unitScope` real no `TenantContext` e em `GET /context`; `decide` com
`UNIT_OUT_OF_SCOPE`; simulação e atribuições de papel por unidade validadas; seeder com organização, árvore de unidades e
âmbito total para os administradores demo; OpenAPI actualizado. ADR D-025. Higiene: `backend/dump.rdb` (dump do Redis que
entrou por engano no commit da 1.4) deixou de ser versionado e passou a estar no `.gitignore`.

**Evidência (executada):** 182 testes backend a passar (22 novos). Unit: antepassados, ciclos (si próprio, descendente, dados
corrompidos), campos da organização, `UNIT_OUT_OF_SCOPE`, `ALL`, `in` com lista em variável. Funcionais: RBAC `organization.*`;
organização (201+Location, 422 de país/moeda/mês/nome/código, 409 de código, `expectedVersion`, código imutável); unidades
(árvore, pai de outra organização → 422, código único 409, tipo inválido, organização inexistente → 404); "unidade não pode ser
pai de si nem de antepassado" (3 casos) e mover para ramo válido/raiz; **a base de dados recusa** pai de outra organização
(`organization_units_parent_fk`) e pai de si (`…_not_own_parent`) mesmo por SQL directo; gestor de outro tenant → 422; inactivar
preserva leitura; centros de custo (pai de outra organização → 422, ciclo → 422, código 409, responsável); equipas (janela,
unidade inactiva → 409, remoção); isolamento entre tenants (404) e RLS; âmbitos: sem âmbito = nenhuma unidade, organização
inteira, unidade ± descendentes, soma de âmbitos, duplicado 409, unidade de outra organização 422, membership/organização
alheias 404, `authorizationVersion` sobe ao adicionar e remover; o âmbito limita a decisão (simulação com `unitId` fora →
`UNIT_OUT_OF_SCOPE`); atribuição de papel com unidade de outro tenant → 404. Lint, `format:check`, `typecheck`, `build`,
migrations numa base limpa (6), seeder duas vezes e `iam:sync` a passar; servidor compilado: o admin demo lista as 3 unidades e o
`/context` traz o `unitScope` com as 3.

**Por verificar / limitações:**
- O filtro por âmbito de unidade nos **dados de domínio** (linhas, pesquisa, exportações) não tem onde aplicar-se ainda: só
  existem decisões individuais (`decide`) e a lista `subject.unitIds`; o filtro de linhas antes de paginar fica para o primeiro
  módulo com listagens por unidade.
- Moeda base/país e "unidade com documentos": regras dependentes de lançamentos/documentos (D-025). Sem preview de impacto ao
  reorganizar. Sem permissão `organization.*` por unidade (a estrutura é só RBAC).
- Sem API para `default_organization_id` da membership (preferências/convites: 1.6). Sem auditoria (Fase 2).
- O lock consultivo serializa a edição da estrutura de um tenant (adequado a edições raras; rever se houver importações em massa).

### 2.6 Fatia 1.6 — concluída
**Entregue:** migration `invitations`, `user_preferences` e `tenants.max_members`; módulo `core/members` (convites, membros,
preferências); `AdminGuard` no módulo de permissões; API `/invitations` (listar, criar, revogar), `POST /invitations/accept`,
`/memberships` (listar, ver, suspender/reactivar/terminar), `/me/preferences`, `/me/default-organization`; comando
`tenant:limit`; OpenAPI actualizado. ADR D-026. O mailer passa a aceitar a finalidade `INVITATION`.

**Evidência (executada):** 199 testes backend a passar (17 novos). Convites: exige `member.invite`; resposta sem token e hash na
base; validações (email, prazo 1–30, papéis/unidades inexistentes com caminho, já membro, pendente duplicado, re-convite depois
de revogar); aceitar com a **mesma conta** que já pertence a outro tenant (conta única, papéis e âmbito aplicados, `/me/tenants`
com 2); uso único (reuso → 400); sem sessão 401, sem CSRF 403, email de outra conta, token adulterado, tenant trocado → 400 e o
token certo continua válido; expirado (estado `EXPIRED`, liberta o email), revogado, tenant suspenso; `LEFT` volta com a mesma
membership e suspenso não; quota (recusa e aceita ao subir o limite); **concorrência**: com um lugar livre só um de dois
convidados entra, e o mesmo token aceite 3× em paralelo → 1 sucesso; RLS. Membros: listagem com utilizador e papéis; suspender
corta o acesso de imediato só nesse tenant; `expectedVersion`; transições; **último administrador** protegido ao suspender,
terminar, revogar a atribuição e retirar a permissão ao papel (transacção anulada, estado intacto), com segundo administrador já
pode sair; **concorrência**: dois administradores a suspenderem-se mutuamente → 1×200 e 1×409 `LAST_ADMIN`. Preferências: só
chaves conhecidas (impostos/moeda/segurança recusados), valores validados, privadas por membro, apagar/atualizar. Organização por
omissão. Lint, `format:check`, `typecheck`, `build`, migrations numa base limpa (7), seeder duas vezes e `iam:sync` a passar;
servidor compilado: o admin demo cria um convite e lista os membros.

**Por verificar / limitações:**
- Sem fornecedor de email o convite só chega via `dev-redis` (D-021). Nada reenvia um convite (revoga-se e cria-se outro).
- Quota provisória por tenant (`max_members`), não por plano (C02). O limite não impede que um convite seja **criado** acima do
  limite, só aceite.
- "Registo verificado" no aceite: a aceitação usa uma conta existente com sessão; o fluxo de registo público de novas contas
  (auto-registo) não existe (só `user:create` e `CreateUser`); um convidado sem conta tem de a ter criado antes.
- Sem auditoria dos convites/alterações de membros (Fase 2). O `AdminGuard` não cobre políticas DENY que excluam todos.
- Sem rate limit específico em `POST /invitations`/`accept`.
- Alterar a organização por omissão não valida unidades; preferências sem versões/expectedVersion (última escrita ganha).

### 2.7 Fatia 1.7 — concluída
**Entregue:** migration `parties`, `people`, `organization_parties`, `contacts`, `addresses`, `party_relationships` e a FK
`tenant_memberships.person_id → people`; módulo `core/party` (casos de uso, store Lucid, API `/parties`, `/people`,
`/organization-parties`, `/parties/:id/contacts|addresses|relationships|possible-duplicates`, `/contacts/:id`, `/addresses/:id`,
`/party-relationships/:id`, `PUT /memberships/:id/person`); permissões `party.read|create|update` no catálogo; seeder com uma
pessoa e um fornecedor por tenant demo; OpenAPI actualizado. ADR D-027. (O pedido original não incluía Party; entrou a seu
pedido, nesta fase.)

**Evidência (executada):** 219 testes backend a passar (20 novos). Unit: chaves de duplicados (documento, NIF, email, telefone,
site), validação de contactos por tipo, pessoa (datas, país, documento completo), organização, morada, datas ISO. Funcionais:
RBAC `party.*`; criação de pessoa com subtipo, contactos e moradas numa operação (404/422 com caminhos completos);
fornecedor empresarial sem `Person` (0 linhas em `people`); a **base recusa** pessoa sobre party de organização,
organização sobre party de pessoa e dois subtipos (`people_party_kind_fk`, `organization_parties_party_kind_fk`,
`people_party_unique`); um contacto principal por tipo (também na base, `contacts_one_primary`); novo valor deixa de estar
verificado; moradas; duplicados por identificação, contacto e NIF (sem fundir: continuam dois registos), desaparecem ao corrigir
o NIF, e o mesmo email noutro tenant não conta; `expectedVersion`, `KIND_MISMATCH`, estado `INACTIVE`; pesquisa por nome e
contacto, `%` literal, paginação, e sem procurar por identificação; relações (duplicada 409, mesma party 422, alheia 404, visível
dos dois lados); **regras de campo** a esconder `birthDate`/`identityNumber` em leitura/criação/alteração e a recusar a alteração
de `nationality` (403); ligação membership↔pessoa (única, só PERSON, desligar); isolamento (404 e RLS em 6 tabelas). Lint,
`format:check`, `typecheck`, `build`, migrations numa base limpa (8), seeder duas vezes e `iam:sync` a passar; servidor
compilado lista os dois cadastros demo.

**Por verificar / limitações:**
- **Fusão assistida (`party.merge`) não feita:** precisa de auditoria (Fase 2) e de módulos com ligações a remapear.
- "Uma pessoa pode ser cliente e colaborador": o modelo permite (um party, vários perfis), mas Customer/Employee ainda não
  existem; só está testado que não se duplica contacto e que o aviso de duplicados não dispara entre tenants.
- "Alteração de NIF não muda fatura emitida" depende de documentos (snapshot) que ainda não existem.
- Sem restrição de base de dados que force a existência do subtipo (só a aplicação); sem regras de campo em contactos/moradas.
- Sem auditoria das alterações a dados pessoais (Fase 2) — relevante para dados sensíveis/RGPD.

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
1. ~~Nomenclatura de permissões (D-014)~~ — decidida na fatia 1.4.
2. Se Party (1.7) entra na Fase 1 ou na seguinte.
3. ~~Mecanismo de hash e de rate limit~~ — decidido na fatia 1.2 (D-019/D-020); MFA fora da Fase 1.
4. ~~Ferramenta OpenAPI~~ — ficheiro `backend/openapi/openapi.yaml` mantido à mão + teste de paridade com as rotas (fatia 1.2); rever se for preferível gerar.
5. Primeiros dois tenants de demonstração (nomes, países/moeda) — parâmetros identificados como demonstração.

## 3. Regras para todas as fases
- Antes de codificar: mapa de ficheiros, entidades, contratos e testes de aceitação.
- Cada fase termina com lint, typecheck, testes, build e migrations numa base limpa; resultados registados aqui.
- Actualizar `docs/architecture.md` (estado real), `docs/decisions.md` e o OpenAPI.
- Registar o que ficou **por verificar** e porquê, sem o apresentar como concluído.
