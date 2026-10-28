# Plano de implementação

Fases da especificação (§11) com estado real. Cada fase entrega **fatias verticais** (migration, domínio, API, UI,
autorização, auditoria, testes). Uma fase só passa quando as verificações aplicáveis correram e a documentação foi
actualizada. Estado actualizado em: Fase 3, fatia 3.2 (C10, frontend).

| Fase | Âmbito (spec) | Estado |
| --- | --- | --- |
| **F0** Preparação | repositório, versões, Docker, CI, estrutura modular, ADRs | **Concluída** (com 2 verificações por executar — ver abaixo) |
| **F1** Fundação | C01, C04–C08: identidade, tenant, membership, RBAC/ABAC, organização, Party | **Próxima** (detalhada na secção 2) |
| **F2** SaaS | C02, C03, C09, auditoria mínima S06 | **Em curso**: fatias 2.1 (auditoria), 2.2 (planos/assinaturas) e 2.3 (registo de módulos) e 2.4 (configurações/sequências) e 2.5 (administração da plataforma) concluídas no backend; o frontend da Fase 2 está ligado (2b.6) (ver secção 2b) |
| F3 Low-code | C10–C15 (Viatura ponta a ponta, Form Builder, regras, estados, aprovações, automações) | **Em curso**: fatias 3.1 (C10 no backend) e 3.2 (C10 no frontend) concluídas (ver secção 2c); C11–C15 só têm contratos/motores no frontend — ver `architecture.md` §7 |
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
| 1.8 | ✅ **Frontend real** (feita parcialmente — ver secção 2.9) | 1.2–1.6 | adaptadores HTTP para auth/tenant/contexto/membros/papéis/organização; remover os mocks correspondentes; mapeamento de permissões (D-014); selector de tenant que cancela pedidos e limpa caches; sessão em cookie |
| 1.9 | ✅ **Matriz de isolamento** (feita — ver secção 2.8) | todas | dois tenants de demonstração + utilizadores com papéis distintos; testes negativos (abaixo) em CI |

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
- Frontend ligado na fatia 1.8 (2.9): a sessão já é só cookie `HttpOnly`.
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
- (Superado na 2.2) Quota provisória por tenant (`max_members`), não por plano (C02). O limite não impede que um convite seja **criado** acima do
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

### 2.8 Fatia 1.9 — concluída
**Entregue:** `tests/functional/isolation_matrix.spec.ts` + `tests/support/matrix_fixture.ts`: dois tenants com **os mesmos**
códigos, nomes, emails, NIF e documento, cada um com todas as entidades de tenant (papéis, atribuições, políticas, organização,
unidades, centro de custo, equipa, âmbito, pessoa, organização externa, contacto, morada, relação, convite, preferência) e
utilizadores com papéis distintos (administrador, membro com papel limitado, operador sem papéis). Corre em `npm test` e, por isso,
na CI (`.github/workflows/ci.yml`). Nenhuma alteração ao código de produção foi necessária: a matriz não encontrou fugas.

**O que a matriz impõe (13 testes, 232 no total):**
- Ids de **outro tenant → 404 em 30 operações** (GET/PATCH/DELETE/POST sobre cada recurso), nos dois sentidos, e o estado dos dois
  tenants fica **idêntico** antes e depois (snapshot completo de listagens e detalhes).
- Listagens só com dados do próprio tenant e com a mesma dimensão; preferências, pesquisa (`q`) e duplicados não atravessam tenants.
- **19 referências cruzadas** em corpos de pedido (papel/membro/unidade/organização/pai/gestor/responsável/pessoa/convite/simulação de
  B usados por A) → 404 ou 422; `tenantId`/`tenant_id` no corpo é ignorado; selectores contraditórios → 400.
- **Varrimento de todas as rotas de tenant do OpenAPI** (57 operações): sem sessão 401; sem selector 400; tenant alheio ou
  inexistente 403 `TENANT_ACCESS_DENIED` (iguais); CSRF falso 403; operador sem papel 403 `PERMISSION_DENIED`. Uma rota nova sem
  selector no OpenAPI falha o teste (lista explícita das rotas que não são de tenant).
- Membro com papel limitado só faz o que o papel permite; trocar de tenant (A→B→A…) não reutiliza permissões; 24 pedidos
  intercalados A/B não se misturam; tenant suspenso bloqueia todas as rotas testadas.
- **Base de dados, automático para toda a tabela com `tenant_id`** (descoberta no esquema; as globais excluídas): o cenário tem de
  ter dados nos dois tenants (senão falha e pede para estender a fixture); sem contexto 0 linhas; A vê exactamente as suas e nenhuma
  de B; `DELETE` cruzado afecta 0; mudar linhas para B é recusado pela RLS (`WITH CHECK`). 7 FKs compostas cruzadas recusadas.
- **Redis:** nenhuma chave fora de `ratelimit:*`, `dev:mailbox` e `tenant:{id}:*`; nenhum email de cadastro em chaves.

**Prova de eficácia:** com a RLS desligada na tabela `addresses` (migration alterada temporariamente e reposta) a matriz falhou
(`addresses sem contexto: expected 2 to equal 0`). Uma verificação inicial da matriz também apanhou um erro do próprio teste
(a RLS escondia a linha alvo e a FK nunca era exercida); corrigido lendo o id com o contexto do outro tenant.

**Por verificar / limitações:**
- Cache, jobs, ficheiros, pesquisa dedicada, relatórios, exportações e WebSocket **não existem**: o isolamento deles fica por testar
  (só há a guarda de prefixos do Redis) e passa a ser obrigatório quando forem criados — a guarda do Redis e a descoberta
  automática de tabelas obrigam a estender a matriz.
- O administrador da plataforma (SaaS) ainda não existe como actor: "sem acesso automático aos dados dos tenants" está garantido
  por não haver nenhuma rota de plataforma nem papel que atravesse tenants, mas não há teste de concessão de suporte.
- A matriz exercita a API HTTP e a base; não inclui o frontend (fatia 1.8).
- Não houve execução da CI no GitHub (continua por executar); os mesmos comandos correm localmente.

### 2.9 Fatia 1.8 — concluída (parcialmente: ver limites)
**Entregue (frontend `src/`):** `HttpAuthGateway` e `HttpTenantGateway` (login, logout, restauro de sessão por `GET /me`,
recuperação e nova palavra-passe, organizações do utilizador, contexto do tenant); sessão **só em cookie `HttpOnly`** + CSRF em
memória; `ApiService` que desembrulha o envelope; interceptores de credenciais/CSRF/selector de tenant, de cancelamento na troca de
tenant e de erros (envelope, `Retry-After`, 401); `mapBackendPermissions` (D-014); `TENANT_SCOPE_RESETTERS`; páginas reais de
**Utilizadores** (membros, estados, convidar/revogar, último administrador), **Organização** (árvore de unidades, criar, inactivar,
409/422 nos campos), **Permissões** (perfis do servidor), **Reset de palavra-passe** e **Aceitar convite**; login com 429 e sem
palavra-passe pré-preenchida; os mocks de identidade/tenants passaram a duplos de teste. ADR D-028.

**Evidência (executada):** `ng test` **647 testes a passar** (eram 582; +65): gateways HTTP, interceptores (cookie, CSRF só em
escritas, selector só em rotas de tenant e nunca em `/auth/*`, cancelamento na troca de tenant e no logout, envelope de erros,
`Retry-After`, 401 sem laço), `AuthService` (nada em storage, restauro, logout emite o pedido antes de limpar o CSRF), tradução de
permissões, `TenantContextService` (resetters, `switched$`, `refreshMemberships`), `tenantGuard` com tenant recusado, e as páginas
(sucesso, vazio, erro, 409 `LAST_ADMIN`/`VERSION_CONFLICT`/código repetido, erros por campo, permissões que escondem acções, recarga
ao trocar de tenant). `ng lint`, `format:check`, `check:generic` e `ng build` (produção) a passar. **Verificação num browser real
(Chromium, Playwright) contra a API real e a base de dados**, front em `localhost:4200` e API em `localhost:3333` (cross-origin com
cookies): **26/26** verificações — login errado/certo, cookie `HttpOnly`+`SameSite=Lax` invisível a `document.cookie`, storage sem
sessão, membros reais, convite (201), segundo convite (409), revogação, suspender o último administrador (LAST_ADMIN explicado),
árvore de unidades, código de unidade repetido (409 no campo), criar unidade, perfis, recarregar mantém a sessão, logout (`/me` →
401) e área do tenant a pedir login de novo, membro de dois tenants com o seu selector, membro sem perfis recusado, tenant alheio →
sem acesso, sem erros de JavaScript. O script do E2E **não** está no repositório (usou o Playwright global do ambiente).

**Por verificar / limites (a fatia NÃO elimina todos os mocks):**
- **Ainda mock no caminho real:** entidades dinâmicas, campos personalizados e registos (C10–C15 sem backend); administração da
  plataforma; e, provisoriamente, **módulos/subscrição/feature flags** do contexto (`provisional-entitlements.ts`). Páginas de
  módulos de negócio (CRM, vendas…) continuam scaffolds e o servidor não concede permissões para elas.
- Sem UI para: papéis (criar/editar/atribuir), políticas ABAC, simulação, âmbitos de acesso, Party, preferências, perfil/sessões
  activas e alteração de palavra-passe — a API existe; as páginas ficam para a(s) próxima(s) fatia(s).
- `roleName` e a moeda do tenant não vêm do servidor (`null`): o painel mostra-os vazios. O logout falha em silêncio no servidor se
  a rede cair (o estado local é limpo na mesma; a sessão expira por tempo).
- Um pedido cancelado por troca de tenant **completa sem valor** (quem usa `firstValueFrom` recebe `EmptyError`); as páginas
  actuais usam `rxResource`, que lida com isso. Os testes E2E não cobrem a corrida de cancelamento num browser (só unitária).
- Produção: `apiUrl: '/api/v1'` pressupõe a API atrás do mesmo domínio (proxy); sem proxy é preciso configurar `apiUrl` e
  `CORS_ORIGINS` (com credenciais). O `Dockerfile.web.dev` e o `docker-compose` não foram ajustados nem executados.
- A verificação visual foi feita com capturas de ecrã das páginas de utilizadores, organização, permissões e sem-acesso em 1300 px;
  não houve verificação em ecrãs pequenos, nem de acessibilidade para além do que os componentes partilhados já cobrem.

### Critérios de aceitação da Fase 1 — estado
Gate da spec: *"Testes negativos em dois tenants aprovados"* — **cumprido ao nível do backend** (fatia 1.9). A Fase 1 **não está
fechada**: a fatia 1.8 ligou o frontend mas ficou parcial (ver 2.9), a auditoria das mutações críticas foi entregue na fatia 2.1.

| Critério | Estado | Evidência |
| --- | --- | --- |
| Isolamento com dois tenants de códigos semelhantes (404, FK composta, RLS, ligação reutilizada, `tenant_id` no corpo) | FEITO (backend) | `isolation_matrix.spec.ts`, `tenancy.spec.ts`, `schema_conformance.spec.ts` |
| Isolamento de cache, jobs, ficheiros, pesquisa, relatórios, exportações, WebSocket | PENDENTE (não existem) | só a guarda de prefixos do Redis |
| C01 tenant suspenso bloqueia por URL directa; domínio duplicado 409 | FEITO | `context.spec.ts`, `tenants.spec.ts`, matriz |
| C04 token expirado/reutilizado, logout, troca de tenant, cookies fora dos logs, recuperação sem revelar email | FEITO (logs: só redacção + verificação manual) | `auth.spec.ts`, `logger_redaction.spec.ts`, matriz |
| C05 conta única em vários tenants, convite revogado falha, último administrador, `authorizationVersion` | FEITO | `members.spec.ts` |
| C06 sem permissão 403, ID alheio 404, DENY prevalece, simulação não concede | FEITO | `iam.spec.ts`, `authorization_domain.spec.ts`, matriz |
| C06 campo restrito oculto em exportação/pesquisa/auditoria/realtime | PARCIAL (API e pesquisa de Party; resto não existe) | `party.spec.ts` |
| C07 unidade não é pai de si nem de antepassado; centro de custo de outra organização rejeitado | FEITO | `organization.spec.ts` (+ FK na base) |
| C08 fornecedor sem Person; pessoa cliente e colaborador sem duplicar contactos | PARCIAL (Customer/Employee não existem) | `party.spec.ts` |
| Concorrência: convites/membership com limite de utilizadores | FEITO | `members.spec.ts` |
| OpenAPI, regras no servidor, permissões e isolamento testados, migrations/seeds numa base limpa | FEITO | paridade OpenAPI↔rotas; migrations (8) e seeder em base limpa |
| Auditoria das mutações críticas | FEITO (fatia 2.1) | `audit.spec.ts`, matriz de isolamento, D-029 |
| UI com sucesso/vazio/erro/409, sem mocks no caminho real | PARCIAL (fatia 1.8): membros, organização, perfis e auth reais; papéis, políticas, âmbitos, Party e conta têm UI real (fatia 1.10, D-049); persistem mocks do core dinâmico e da plataforma | `ng test` (647), E2E no browser (26/26) |

### Decisões a tomar antes de começar a Fase 1
1. ~~Nomenclatura de permissões (D-014)~~ — decidida na fatia 1.4.
2. Se Party (1.7) entra na Fase 1 ou na seguinte.
3. ~~Mecanismo de hash e de rate limit~~ — decidido na fatia 1.2 (D-019/D-020); MFA fora da Fase 1.
4. ~~Ferramenta OpenAPI~~ — ficheiro `backend/openapi/openapi.yaml` mantido à mão + teste de paridade com as rotas (fatia 1.2); rever se for preferível gerar.
5. Primeiros dois tenants de demonstração (nomes, países/moeda) — parâmetros identificados como demonstração.

## 2b. Fase 2 — SaaS (em curso)
Sem decomposição prévia no plano; proposta (uma fatia de cada vez, ordem sujeita a confirmação):

| Fatia | Âmbito | Estado |
| --- | --- | --- |
| 2.1 | Auditoria mínima (S06): `audit_logs` imutável por triggers, `security_events`, consulta com RBAC e regras de campo | **Concluída** |
| 2.2 | C02 planos, assinaturas e limites no backend (substitui a quota provisória de convites). Os entitlements provisórios do frontend ficam para depois de 2.3 | **Concluída** (backend) |
| 2.3 | C03 registo de módulos e funcionalidades por tenant | **Concluída** (backend) |
| 2.4 | C09 configurações, impostos, unidades e sequências (numeração sem lacunas e concorrente) | **Concluída** (backend) |
| 2.5 | API de administração da plataforma (C01/C02) | **Concluída** (backend) |
| 2.6 | Frontend da Fase 2: plataforma (tenants, planos, subscrições), plano, módulos e configurações do tenant; fim dos direitos provisórios | **Concluída** (ver 2b.6) |

### 2b.1 Fatia 2.1 — concluída
**Entregue** (ver D-029): migration `create_audit` (`audit_logs` tenant + imutável; `security_events` global; funções e triggers de
auditoria sobre 18 tabelas de tenant e de mudança em `users`/`tenants`), `auditTable` nos helpers de migration, GUCs de actor em
`LucidTenantDatabase.run()`, módulo `core/audit` (redacção, registo de eventos, consulta), permissão `audit.read`, rotas
`GET /audit-logs`, `GET /security-events`, `GET /me/security-events`, eventos de segurança no login/logout/recuperação e nos
middlewares (origem, CSRF, tenant, permissão), OpenAPI actualizado.
**Evidência:** 242 testes no backend (novos: `audit.spec.ts` — actor/correlação/antes-depois, redacção de sensíveis, filtros e
validação, permissão por recurso, regras de campo, isolamento entre tenants, imutabilidade (dona e runtime), eventos de
segurança, conformidade do esquema; `audit_redaction.spec.ts`; matriz de isolamento com `audit_logs` só-leitura para o runtime).
**Limites / por verificar:** sem UI de auditoria (frontend não alterado); sem hash encadeado, exportação nem retenção automática;
auditoria de leitura inexistente; MFA/SSO não existem; desempenho dos triggers em escrita intensiva não medido; o
`security_events` do utilizador mostra IP apenas nos metadados dos eventos de login.

### 2b.2 Fatia 2.2 — concluída (backend)
**Entregue** (ver D-030): migration `create_billing` (`plan_versions` imutáveis depois de publicadas, `subscriptions` com uma aberta por
tenant, `subscription_changes` append-only; remove `tenants.max_members`), módulo `platform/billing` (domínio de limites,
direitos e transições; casos de uso de planos, atribuição idempotente, mudança de plano com adequação, estados e limite efectivo),
permissão `subscription.read`, `GET /tenant/subscription` (versão contratada, consumo, limites, bloqueios, histórico), quota de
membros ligada ao plano (sem assinatura ou sem direitos → 0), comandos `plan:*` e `subscription:*` (substituem `tenant:limit`),
planos e assinaturas no seeder demo (`demo_a` básico/10 membros, `demo_b` profissional/ilimitado), OpenAPI e matriz de isolamento.
**Evidência:** 259 testes no backend (novos: `billing.spec.ts` — revisões concorrentes, publicação e imutabilidade na base,
validação, atribuição idempotente e concorrente, estados e direitos, histórico imutável, leitura com permissão, isolamento entre
tenants, upgrade/downgrade com e sem adequação; `billing_domain.spec.ts`; `members.spec.ts` reescrito para quotas por plano, incluindo
tenant sem assinatura/suspenso e a concorrência com um lugar livre).
**Limites / por verificar:** sem API `/platform/*` (não existe identidade de plataforma: fatia 2.5); sem `UsageCounter`,
`SaasBillingRecord`/webhooks, pedido de mudança de plano pelo tenant, renovação automática de períodos nem validação de
módulos contra o registo (C03); o frontend continua com entitlements provisórios e sem página de plano; um downgrade e uma
aceitação de convite simultâneos podem, em teoria, deixar o tenant acima do novo limite (o excesso apenas bloqueia novos
membros, nada se elimina). Tenants criados antes desta fatia ficam **sem assinatura** (limite 0) até `subscription:assign`.

### 2b.3 Fatia 2.3 — concluída (backend)
**Entregue** (ver D-031): migration `create_modules` (`modules`, `module_dependencies`, `features` globais; `tenant_modules` e
`tenant_features` de tenant, auditadas), módulo `platform/modules` (validação do grafo e das versões, activação com dependências,
desactivação sem apagar, overrides, acesso efectivo), `ResolveEntitlements` no billing, permissões `module.read`/`module.manage`,
rotas `GET /modules`, `POST /tenant/modules/{code}/enable|disable`, `PUT /tenant/features/{code}`, `GET /context/features`
(+ `modules`/`features` em `GET /context`), `middleware.feature`, comando `modules:sync`, OpenAPI e matriz de isolamento.
**Evidência:** 281 testes (novos: `modules_domain.spec.ts` — versões, ciclos, dependências, decisão de funcionalidade;
`modules.spec.ts` — sincronização idempotente e que recusa ciclos, SALES sem dependências, activação ordenada e concorrente sem
duplicados, licença, descontinuado, núcleo, desactivação com dependentes sem apagar, falha→ERROR→retoma, funcionalidades e overrides
(nunca ultrapassam a licença), bloqueio pela API, assinatura suspensa, isolamento).
**Limites / por verificar:** o código só declara o módulo `core` (nenhum módulo de negócio existe); o plano não valida os códigos
de módulos/funcionalidades contra o registo; sem API de configuração por módulo nem de plataforma; frontend ainda com
`provisional-entitlements.ts` (não ligado a `GET /context`/`/modules`); sem estado `DISABLING` nem tratamento de processos em curso.

### 2b.4 Fatia 2.4 — concluída (backend)
**Entregue** (ver D-032): migration `create_settings` (`setting_values`, `tax_rates`, `units_of_measure`, `sequences`; RLS, FKs
compostas, auditoria, unicidade por âmbito e trigger anti-sobreposição de taxas), módulo `core/settings` (definições por código,
precedência, validação, conversão de unidades exacta, formatação de sequências e `SequenceIssuer`), permissões `settings.read`,
`settings.manage` e `sequence.manage`, rotas `GET /settings/effective`, `GET|PUT|DELETE /settings…`, `PUT|DELETE /me/settings/{key}`,
`/tax-rates`, `/units` (+ `/units/convert`), `/sequences` (+ `/sequences/preview`), OpenAPI, matriz de isolamento e seeder demo
(unidades, IVA e sequência por tenant).
**Evidência:** 306 testes (novos: `settings_domain.spec.ts` — precedência de 6 níveis, âmbitos fiscais, conversão e formatos;
`settings.spec.ts` — efectivo e origem, repor herança, preferência de idioma não altera imposto, versões e referências de outro
tenant, permissões, auditoria, taxas sobrepostas (incl. concorrência), imutabilidade da taxa, unidades, **100 emissões concorrentes
distintas e contíguas**, não-reutilização e devolução em rollback, escolha de filial/período, isolamento entre tenants).
**Limites / por verificar:** sem catálogo de moedas/idiomas; períodos novos exigem criar a sequência (falha em vez de criar);
as chaves fiscais existem mas ainda não há cálculo de impostos; o custo de auditar cada emissão não foi medido; sem UI; o frontend
continua sem ligação a esta API.

### 2b.5 Fatia 2.5 — concluída (backend)
**Entregue** (ver D-033): migration `create_platform_grants` (concessões imutáveis, revogáveis), módulo `platform/administration`
(autorização de plataforma, concessões, provisionamento idempotente, ciclo de vida), middleware `platform`, rotas `/api/v1/platform/*`
(`tenants`, provisionar, estado, `suspend|resume`, `plans` com publicar/retirar, assinatura: ver/atribuir/mudar plano/estado), eventos
`PLATFORM_ACCESS_DENIED`/`PLATFORM_ACTION`/`PLATFORM_GRANT_CHANGED`, comandos `platform:grant|revoke|list`, utilizador demo
`platform@demo.invalid` (só `platform.*`), OpenAPI.
**Evidência:** 318 testes (novos: `platform.spec.ts` — acesso negado e registado a quem não tem concessão (incl. administrador de tenant),
permissões separadas, revogação e expiração, concessões imutáveis na base, a concessão não dá acesso a dados de tenants, provisionamento
completo e idempotente (um convite/email, uma organização), aceitação do convite pelo administrador, retoma após falha, validação,
suspensão com efeito imediato por URL directa e reactivação, planos e assinaturas pela API incl. adequação).
**Limites / por verificar:** não existe MFA nem reautenticação para acções de plataforma; sem acesso de suporte a dados de um tenant (a
concessão excepcional, limitada no tempo e auditada, não foi implementada); sem fecho de tenant; o frontend de administração da
plataforma continua mock (nenhuma UI foi ligada a estas rotas) e `provisional-entitlements.ts` mantém-se: **o fecho dos mocks do
frontend fica por fazer** e é a lacuna principal da Fase 2.

### 2b.6 Fatia 2.6 — frontend da Fase 2 (concluída; ver D-034)
**Entregue:** `provisional-entitlements.ts` removido (o contexto traz módulos/funcionalidades do registo e, com `subscription.read`, o plano e
o consumo); `GET /platform/me` (backend) e `mapPlatformPermissions`; área de plataforma real — painel com contagens reais, tenants
(provisionar com passos, suspender/reactivar com motivo), planos (criar revisão, publicar, retirar) e subscrições (plano contratado,
consumo, histórico, atribuir, mudar de plano com adequação, mudar estado); páginas do tenant: Plano, Módulos (registo real) e
Configurações com separadores (preferências com origem e herança, impostos, unidades com conversão, sequências com pré-visualização).
Removidos: gateways mock de tenants e de billing, página «Configurações da plataforma» (sem backend). Backend: `/context` só lista módulos
licenciados; `GET /settings/effective` passou a incluir descrição, tipo/opções e versão da origem.
**Evidência:** backend 319 testes; frontend 692 testes (novos: gateways de autenticação e de tenant com os dados do servidor, páginas de
plataforma e do tenant com APIs duplicadas), lint, `format:check`, `check:generic` e build limpos; **verificação no browser contra a API
real** (Chromium + backend + PostgreSQL + Redis, base limpa com seeds): login de conta só de plataforma → `/platform`, painel com contagens
reais, criação e publicação de um plano, provisionamento de um tenant e repetição sem duplicar (1 organização, 1 convite), suspensão com
motivo, mudança de plano de um tenant, página do plano e dos módulos do tenant, administrador de tenant sem acesso à plataforma, nenhum
token em storage. Defeitos reais encontrados e corrigidos nessa verificação: o diálogo de subscrições fechava-se a si próprio ao recarregar; e um validador `required` obsoleto (campo oculto) tornava silenciosamente inválida a segunda criação de uma unidade ou de um plano (teste de regressão em `registry-pages.spec.ts`). Unidades, sequências, impostos, preferências e módulos também foram exercitados.
**Limites / por verificar:** o registo de módulos só declara o núcleo, por isso nenhum módulo de negócio fica acessível no frontend (a
activação de módulos foi exercitada na API com módulos de teste inseridos só na base de desenvolvimento); configurações por filial/módulo e
as páginas de papéis, políticas, Party e âmbitos (Fase 1) continuam sem UI real; sem UI de auditoria; E2E não automatizado no repositório
(correu-se por script local); o core dinâmico (C10–C15) continua mock.

## 2c. Fase 3 — motor configurável (em curso)
Decomposição proposta (uma fatia de cada vez, ordem sujeita a confirmação; a especificação não a fixa):

| Fatia | Âmbito | Estado |
| --- | --- | --- |
| 3.1 | C10 no backend: entidades, versões imutáveis, campos tipados, registos com únicos concorrentes, sensíveis, propriedade, pesquisa e auditoria; «Viatura» como entidade definida por um tenant | **Concluída** (backend; ver 2c.1) |
| 3.2 | Frontend de C10: Entity Designer, publicação e listagem/formulário genérico de registos sobre a API (fim do mock do core dinâmico) | **Concluída** (ver 2c.2) |
| 3.3 | C12 no servidor: campo FORMULA (gramática restrita → AST, ordem topológica, ciclos) e regras de validação por AST (publicação imutável, simulação, avaliações registadas); FORMULA no designer | **Concluída** (ver 2c.3); LOOKUP e a UI de regras ficam por fazer |
| 3.4 | Editor de regras (UI) sobre `/rules`: construtor de condições, simulação, publicação, revisões e avaliações | **Concluída** (ver 2c.4) |
| 3.5 | Tipo LOOKUP (valor lido em tempo real de um registo referenciado, com a autorização do destino) | **Concluída** (ver 2c.5) |
| 3.6 | C11 formulários no servidor (secções, ligações a campos, condições de apresentação, publicação imutável, verificação contra a entidade) e usados pelos registos no frontend | **Concluída** (ver 2c.6); Form Builder visual e submissões por fazer |
| 3.7 | Form Builder visual sobre `/forms`: secções, arrastar campos, ajuda e condições, pré-visualização, verificação e publicação | **Concluída** (ver 2c.7); teste com papéis simulados por fazer |
| 3.8 | C13 máquinas de estados (transições com `expectedVersion`, histórico, outbox): servidor, estado e acções nos registos | **Concluída** (ver 2c.8); designer visual por fazer |
| 3.9 | Designer visual de máquinas de estados sobre `/state-machines` (estados, transições, guardas, mapa, verificação, publicação) | **Concluída** (ver 2c.9) |
| 3.10 | C14 workflows de aprovação, tarefas e delegações: servidor, caixa de aprovações, painel do registo e designer | **Concluída** (ver 2c.10) |
| 3.11 | C15 automações (servidor, trabalhador e interface) e a prova de «Viatura» ponta a ponta | **Concluída** (ver 2c.11) |

### 2c.1 Fatia 3.1 — C10 no backend (concluída; ver D-035)
**Entregue:** migration `create_metadata` (5 tabelas de tenant com RLS, FKs compostas e auditoria; triggers de imutabilidade de versões
publicadas e campos), módulo `dynamic/metadata` (domínio: matriz de tipos, validação/normalização de valores, decimais exactos, compatibilidade
entre versões, unicidade, referências, pesquisa; aplicação: definição de entidades com rascunho/pré-visualização/publicação/arquivo e registos
com autorização por registo; infraestrutura Lucid), rotas `/entity-definitions…` e `/dynamic/{entityCode}/records…`, permissões
`entity.read|design|publish` e `dynamic.read|create|update|archive|sensitive|all`, alias `#dynamic/*`, `can` com `resource` por parâmetro de
rota, OpenAPI, matriz de isolamento estendida (entidade, registo, 11 ids alheios, referência cruzada, tabelas novas).
**Evidência:** backend 353 testes (34 novos: `metadata_domain.spec.ts` — tipos, decimais, datas, padrões, validação de registos, compatibilidade;
`metadata.spec.ts` — ciclo completo da Viatura (CRUD, pesquisa, arquivo), erros 422 com caminho completo, versão antiga legível e migrada ao
alterar, publicação incompatível bloqueada sem alterar nada, imutabilidade por SQL directo, 6 criações concorrentes com o mesmo valor único →
1 passa, referências de outro tenant recusadas, permissões por comando, campos sensíveis (leitura, escrita, pesquisa, auditoria), política ABAC por
entidade e regra de campo, modos OWNER e UNIT), lint, `format:check`, typecheck, build e migrations numa base limpa (subida e descida das 14
migrations pelo próprio `npm test`).
**Limites / por verificar:** ver «Fora desta fatia» em D-035. Em particular: o frontend continua com o core dinâmico mock (3.2); não há
mecanismo de migração de dados, por isso alterações incompatíveis só se fazem por um campo novo; a pesquisa é `LIKE` sem índice; a divergência
das permissões `dynamic.{código}.*` face à especificação aguarda decisão. Não foi feito teste de carga nem E2E no browser (não há UI).

### 2c.2 Fatia 3.2 — C10 no frontend (concluída; ver D-036)
**Entregue:** gateways HTTP de definições e de registos (`core/dynamic/http`) e tradução num só ponto (`dynamic-mapper.ts`); designer de entidades, listagem
(paginação, ordenação, pesquisa e filtros no servidor), formulário, detalhe e histórico de auditoria sobre a API real; `/t/:slug/entities` no menu e nas
rotas do tenant; tipos do designer limitados aos do servidor (`DESIGNER_FIELD_TYPES`); permissões `entity.*` traduzidas para as páginas; fim dos dados
simulados do core dinâmico na aplicação (os duplos ficam só nos testes) e do contrato «proposto» `ENTITY_API`. Backend (migration 14 `presentation`):
apresentação da entidade e dos campos, `meta.total`, `sort`, `filter.<campo>`, `DELETE` de entidade nunca publicada, `referenceEntityCode`, auditoria das tabelas
de C10.
**Evidência:** backend 360 testes (7 novos: apresentação, total/paginação/ordenação por valor, filtros, recusas e campos escondidos, `searchable=false`,
remoção, auditoria com e sem permissão), lint, `format:check`, typecheck, build e migrations (15) numa base limpa; frontend 729 testes (37 novos: mapper,
gateways de definições e de registos, permissões, tipos do designer), lint, `format:check`, `check:generic` e build limpos; **verificação no browser contra a API real**
(Chromium + backend + PostgreSQL + Redis, base limpa): sem entidades no início; definir «Viatura» com sete campos (único, obrigatório, limites, decimal,
lista, data, sensível); só os tipos do servidor escolhíveis; publicar; entrada no menu «Dados»; criar três registos (sensível visível ao administrador,
decimal com a escala); matrícula repetida → erro de valor único no campo; limite fora do intervalo recusado; ordenar por preço pelo valor; pesquisa e ordenação no
servidor; editar; eliminar (arquiva); nova versão com campo novo e registos antigos legíveis; apertar um limite publicado → o servidor recusa e o designer
mostra o motivo; descartar o rascunho mantém a publicada; o tenant B não vê a entidade nem os registos; `X-Tenant-Id` e CSRF em todos os pedidos; nada em storage; zero erros
de página. Defeitos reais encontrados pela verificação: o servidor não incluía as tabelas de C10 no histórico (auditoria visível vazia); uma listagem
sem total/ordenação por campo.
**Limites / por verificar:** ver «Fora desta fatia» em D-036. Em particular: sem E2E automatizado no repositório (correu-se por script local); o decimal da
interface é um número (15 dígitos) e recusa o que não cabe; as entidades criadas pela API com códigos que a interface não representa não aparecem na lista; só o
Core Dinâmico foi ligado — formulários (C11), regras (C12), estados (C13), workflows (C14) e automações (C15) continuam sem servidor; uma conta com uma regra de campo
que esconde um campo pesquisável não pode usar a pesquisa (422).

### 2c.3 Fatia 3.3 — fórmulas e regras no servidor (concluída; ver D-037)
**Servidor.** Campo `FORMULA` (migration 15): expressão em gramática restrita (`+ - * /`, `round/min/max/abs`, até 500 caracteres/100 nós/profundidade 20) convertida em AST
na gravação; cálculo em ponto fixo (BigInt) no servidor, em ordem topológica, no fim da validação do registo; ciclos, referências inexistentes/arquivadas/não numéricas e
fórmulas que expõem campos sensíveis são recusadas ao gravar o rascunho e ao publicar. Módulo `app/dynamic/rules` (migration 16): regras `VALIDATE`→`BLOCK` com condição na AST de
permissões, rascunho/publicada/desactivada, revisões, janela de vigência, prioridade, simulação sem efeitos e registo de avaliações (FAIL/ERROR, em transacção separada). Permissões
`rule.read`/`rule.manage`. A matriz de isolamento cobre `/rules*`, `rule_definitions` e `rule_evaluations`.
**Frontend.** `FORMULA` passou a tipo do servidor: o mapper traduz a expressão (identificadores camelCase ⇄ snake_case), a escala e o valor calculado (texto ⇄ número); o campo é só de leitura.
**Verificado:** backend lint, typecheck, format, build e `npm test` (385 testes); frontend lint, format, `check:generic`, 732 testes unitários e build.
**Não verificado:** E2E em browser com campo FORMULA (só testes unitários dos mappers; o servidor está coberto por testes funcionais).

### 2c.4 Fatia 3.4 — editor de regras (concluída; ver D-038)
**Frontend.** Página `/t/:slug/entities/:entityKey/regras` (`features/dynamic-core/rules`), ligada ao detalhe da entidade; permissões `rule.read`/`rule.manage` traduzidas para `configuration.rules.*`.
Lista as revisões de cada regra com mensagem, prioridade, vigência e estado; cria e edita rascunhos (construtor de condições: comparações de campos ligadas por «e»/«ou», «preenchido»/«vazio»);
publica, desactiva e abre revisões (`expectedVersion`); simula com valores de exemplo (só os campos que a condição lê) e consulta as avaliações recusadas. Uma condição que o construtor
não representa (aninhada, sobre `subject`/`env`, `in`) mostra-se como JSON e grava-se tal como está, nunca é descartada. Decimais seguem como texto. O servidor não mudou.
**Verificado:** frontend lint, format, `check:generic`, 746 testes unitários e build; E2E em browser real (Chromium) sobre a API real: criar rascunho, simular (bloqueia/não bloqueia), publicar,
o servidor bloquear a gravação de um registo com a mensagem, gravar com valor dentro da alçada, avaliação FAIL registada, nova revisão, editar, publicar a revisão 2 desactivando a 1; zero erros de página.
**Não verificado / limites:** o E2E correu por script local (não está no repositório); sem teste de acessibilidade dedicado nem de leitura sem `rule.manage` no browser (só em teste unitário);
LOOKUP continua por fazer (fatia 3.5); sem remoção de rascunhos (a API não a tem).

### 2c.5 Fatia 3.5 — valores relacionados, LOOKUP (concluída; ver D-039)
**Servidor.** Campo `LOOKUP` (migration 17) com `validation {relationField, sourceField, onMissing}`; o servidor acrescenta `sourceType` e `scale` do campo de origem. **Nunca se guarda**: lê-se do registo de origem
em cada `GET`/listagem/escrita (`LookupReader`), segundo a **versão em vigor** da entidade (os registos antigos também o mostram). Só aparece a quem pode ler o registo de origem (permissão `dynamic.read`, modo
OWNER/`dynamic.all`, políticas ABAC da entidade de destino, regras de campo `HIDDEN`) e, se a origem for sensível, a quem tem `dynamic.sensitive`; caso contrário `null`. Definição verificada ao gravar o rascunho e
ao publicar: relação existe, activa e é `ENTITY_REFERENCE`; origem existe, de tipo escalar (sem cadeias de lookups, sem multi-selecção/referências); origem sensível ⇒ valor relacionado sensível. Só de leitura, não
obrigatório, sem valor por omissão, sem pesquisa/filtro/ordenação, fora das regras (C12) e das fórmulas. `onMissing: error` recusa gravar sem a relação (422 `LOOKUP_RELATION_REQUIRED`).
**Frontend.** O mapper traduz o lookup (códigos snake_case ⇄ chaves camelCase) e converte para número a origem decimal; o designer já tinha a configuração de «Valor relacionado».
**Verificado:** backend lint, typecheck, format, build e `npm test` (397 testes, migrations numa base limpa); frontend lint, format, `check:generic`, `ng test` (750 testes) e build; E2E em browser real sobre a API real: criar o campo no designer, publicar,
ver o valor (decimal formatado) na lista e no detalhe, incluindo num registo escrito antes do campo, ver a alteração da origem reflectir-se, e o valor ficar vazio quando uma política impede ler o destino.
**Não verificado / limites:** o E2E correu por script local, em duas execuções sobre o mesmo ambiente (designer e leitura); sem teste no browser de `onMissing: error`; um valor relacionado cuja origem for retirada do destino
mostra vazio (a publicação do destino não verifica quem o usa); N leituras por página de resultados (uma por registo de origem distinto, sem cache entre pedidos); `snapshot` (cópia ao gravar) não existe.

### 2c.6 Fatia 3.6 — formulários (concluída; ver D-040)
**Servidor.** Módulo `app/dynamic/forms` (migration 18, `form_definitions`): formulário por entidade e código, revisões `DRAFT → PUBLISHED → RETIRED`, publicada imutável (trigger; só passa a `RETIRED`), um rascunho e
uma publicada por código, `schema_revision` com a revisão da entidade verificada. Layout = secções (`columns` 1–3, `visibleWhen`) com ligações a campos **por código** (`span`, `label`, `placeholder`, `help`,
`visible`, `editable`, `required`, `visibleWhen/editableWhen/requiredWhen`); condições declarativas (`eq…lte`, `in/nin`, `empty/notEmpty`, `and/or/not`; ≤ 8 níveis, ≤ 50 nós). Rascunho só precisa de estar bem
formado; **publicar** verifica contra os campos em vigor: existem e estão activos, cada um uma vez, condições só sobre campos não sensíveis, e nada que impeça preencher um obrigatório (`FORM_HIDES_REQUIRED`,
`FORM_MISSING_REQUIRED`); um formulário por omissão por modo. API: `/forms` (+ `preview`, `publish`, `retire`, `revisions`) com `form.read|design|publish`, e `GET /dynamic/{entity}/forms` (publicados, com `issues`) para quem lê
registos. Os registos escrevem-se sempre na entidade (autorização e validação inalteradas: um campo escondido no pedido continua sujeito a elas).
**Frontend.** O gateway carrega os formulários publicados (sem `issues`) para `entity.forms`; o renderer passou a aplicar `applyFormConfiguration` (rótulos, ajudas, condições, campos não incluídos escondidos e não enviados).
**Verificado:** backend lint, typecheck, format, build e `npm test` (410 testes; matriz de isolamento estendida); frontend lint, format, `check:generic`, `ng test` (753) e build; E2E em browser real sobre a API real:
secções e título, rótulo/ajuda do formulário, secção condicionada, campo não incluído, gravação na entidade, e regresso ao formulário gerado ao retirar.
**Não verificado / limites:** o E2E correu por script local; sem Form Builder visual (3.7), sem `FormSubmission` (o CRUD escreve directamente), sem política de valores escondidos (preservar/limpar), sem grupos nem valores por omissão por formulário,
`span`/`columns` até 3 (a spec fala em 1–12 para a largura) — ver D-040.

### 2c.7 Fatia 3.7 — Form Builder (concluída; ver D-041)
**Frontend** (`features/dynamic-core/forms`; servidor inalterado). Página `/t/:slug/entities/:entityKey/formularios` ligada ao detalhe da entidade; permissões `form.read|design|publish` traduzidas para `configuration.form-layouts.*`.
Lista as revisões (modos, por omissão, estado, «com problemas») e permite criar formulários, editar o rascunho, abrir nova revisão, publicar e retirar. O editor: nome, código, descrição, modos e «por omissão»; secções (título, 1–3 colunas, condição
de visibilidade, subir/descer/remover); campos ligados por código com **arrastar e largar** (e botões subir/descer para teclado) entre secções; por campo, rótulo, ajuda, texto de exemplo, largura, escondido/só leitura/obrigatório e as
condições «mostrar/editável/obrigatório quando» (construtor de comparações ligadas por «e»/«ou»; condições mais ricas ficam descritas e preservadas). **Pré-visualização** ao vivo com o renderer real, por modo e com largura de telemóvel
(só estreita o contentor). **Verificar com o servidor** guarda o rascunho e mostra os problemas com o caminho completo (ou confirma que é publicável); publicar guarda, verifica e publica. Nada duplica definições de campo.
**Verificado:** frontend lint, format, `check:generic`, `ng test` (772 testes) e build; E2E em browser real sobre a API real: criar formulário, ligar campos, segunda secção com condição, configurar rótulo/ajuda, pré-visualização, arrastar e «Descer»,
guardar, verificar, publicar, uso do formulário nos registos (rótulo, ajuda e secção condicionada), e recusa do servidor a um formulário sem o campo obrigatório.
**Não verificado / limites:** o E2E correu por script local, em duas execuções (a segunda só falhou no último passo por reutilizar o código do formulário de teste, já verificado na primeira); o «modo móvel» não reproduz os pontos de quebra do
ecrã (só limita a largura); sem teste com papéis simulados; sem grupos nem valores por omissão por formulário; arrastar só com rato (os botões cobrem o teclado); sem `@angular/cdk` (sem ADR para nova dependência).

### 2c.8 Fatia 3.8 — máquinas de estados (concluída; ver D-042)
**Servidor.** Módulo `app/dynamic/states` (migrations 19–20): `state_machines` (revisões DRAFT → PUBLISHED → RETIRED, estados e transições em JSON validado, imutável depois de publicada, **uma em vigor por entidade**), `record_states` (o estado
de cada registo e a sua `version`, à parte dos registos), `state_history` (só de acrescentar) e `outbox_events` (módulo `core/outbox`). Estados: `code`, `label`, `category` (INITIAL/ACTIVE/FINAL/CANCELLED), `editable`, `color`. Transições: `from[]`, `to`, `permission?` (do catálogo),
`guard?` (condição das políticas de acesso sobre `resource.<campo não sensível>`/`subject.*`/`env.now`), `reasonRequired`. Publicar verifica: um só estado inicial, estados alcançáveis, nenhuma saída de um estado final/cancelado, guardas contra a entidade, permissões conhecidas e que nenhum
estado em uso por registos desapareça (`STATE_IN_USE`). Os registos criados com a máquina em vigor nascem no estado inicial (na mesma transacção); um estado `editable: false` recusa alterações de valores (409 `RECORD_STATE_LOCKED`); as respostas dos registos trazem `state`.
API: `/state-machines` (+ `preview`, `publish`, `retire`, `revisions`; `state.read|design|publish`) e, por registo, `GET …/available-actions`, `POST …/transitions/{code}` (`dynamic.transition`) e `GET …/state-history`. A transição bloqueia o estado (`FOR UPDATE`), verifica `expectedVersion`, `dynamic.transition` com os
atributos do registo **incluindo `resource.state`** (políticas ABAC por estado), a permissão da transição e a guarda sobre os dados actuais (falha fechada), e escreve estado, histórico e evento de outbox **na mesma transacção**.
**Frontend.** O gateway lê o estado e as acções do servidor; o detalhe do registo mostra o estado, só as acções que o servidor devolve, pede confirmação (e o motivo, quando exigido), envia a versão do estado e mostra conflitos; «Editar» some em estados fechados.
**Verificado:** backend lint, typecheck, format, build e `npm test` (422 testes; matriz de isolamento estendida, incluindo 404 para registos alheios e a concorrência de dois comandos); frontend lint, format, `check:generic`, `ng test` (780) e build; E2E em browser real sobre a API real: estado e acções,
transição, guarda que esconde «Concluir», motivo obrigatório, estado final sem acções nem «Editar», recusa do servidor a editar, histórico com o motivo e conflito de versão.
**Não verificado / limites:** o E2E correu por script local (as máquinas criam-se por API); **sem worker nem consumidores do outbox** (os eventos ficam `PENDING`; sem inbox) — D-015; os registos criados **antes** da máquina ficam sem estado (409 `RECORD_WITHOUT_STATE`; a migração exige um mapeamento explícito, não feito); um só ramo de
guarda por transição, sem `action_code`; categorias semânticas fiscais/financeiras/de stock não aplicam efeitos (por desenho: nenhum estado emite documentos); a guarda lê os dados que a pessoa pode ver (campos escondidos/sensíveis não contam); a listagem de registos não mostra o estado.

### 2c.9 Fatia 3.9 — designer de máquinas de estados (concluída; ver D-043)
**Frontend** (`features/dynamic-core/states`; servidor inalterado). Página `/t/:slug/entities/:entityKey/estados` ligada ao detalhe da entidade; `state.read|design|publish` → `configuration.state-machines.*`. Lista as revisões (conteúdo, estado, «com problemas») e permite criar, editar o rascunho,
abrir nova revisão, publicar e retirar. O editor: nome, código e descrição; **estados** (rótulo, código que acompanha o rótulo enquanto for gerado, categoria, «aceita alterações de valores», cor, «tornar inicial» — há sempre um só inicial — e remover, que ajusta as transições e avisa);
**transições** (rótulo, código, origens por caixas, destino, permissão adicional do catálogo, «exige um motivo» e **guarda** construída com comparações de campos ligadas por «e»/«ou», a mesma gramática das regras; guardas mais ricas ficam descritas como «avançadas» e preservadas; só campos não sensíveis);
**mapa de estados** ao vivo (o que cada estado alcança, estados finais, «Só leitura» e «Inalcançável», pelo mesmo critério do servidor). «Verificar com o servidor» guarda o rascunho e mostra os problemas com o caminho (ou confirma que é publicável); publicar guarda, verifica e publica.
Refactor: o tipo de valor das condições (`ruleValueKind`) passou a ficar num só sítio, partilhado com o editor de regras.
**Verificado:** frontend lint, format, `check:generic`, `ng test` (795 testes) e build; E2E em browser real sobre a API real: criar a máquina de raiz, códigos gerados, estado final fechado por omissão, guarda sem campos sensíveis, mapa com o estado inalcançável, recusa do servidor (e qual estado), remover e aceitar,
publicar, registo novo no estado inicial desenhado, guarda a oferecer/esconder «Concluir» consoante o valor, e nova revisão a abrir com o conteúdo anterior; zero erros de página.
**Não verificado / limites:** o E2E correu por script local; o mapa é uma lista (sem diagrama gráfico); o código de um estado em uso por registos não se pode alterar numa revisão (o servidor recusa a publicação); a permissão adicional é texto livre validado pelo servidor (sem lista do catálogo); sem arrastar para reordenar estados.

### 2c.10 Fatia 3.10 — workflows de aprovação, tarefas e delegações (concluída; ver D-044)
**Servidor.** Módulo `app/dynamic/workflows` (migration 21): `workflow_definitions` (revisões DRAFT → PUBLISHED → RETIRED, `graph` em JSON validado, imutável depois de publicada por trigger, uma publicada por entidade e código), `workflow_instances` (registo, `resource_version`, `submitted_snapshot`, revisão usada, estado, motivo do fim; **um só processo em curso por registo**),
`workflow_tasks` (uma por responsável: pessoa ou papel; `OPEN → CLAIMED → APPROVED/REJECTED/RETURNED/CANCELLED`, `due_at`, quem decidiu e por que delegação) e `approval_delegations`; instâncias e tarefas terminadas são imutáveis por trigger. A definição é uma sequência de **etapas** com responsáveis, critério `ALL`/`ANY`/`QUORUM`, prazo em horas, condição AST de aplicação e `allowSelfApproval`
(+ `amountField`/`currencyField`). Publicar verifica condições, campos e responsáveis resolvíveis. API: `/workflows` (+ `preview`, `publish`, `retire`, `revisions`; `workflow.read|design|publish`), `GET /dynamic/{entity}/workflows` (o que se pode submeter), `POST /workflow-instances` (`workflow.submit`), `GET /workflow-instances[/{id}]`, `POST …/cancel`,
`GET /dynamic/{entity}/records/{id}/workflow-instances`, `GET /approval-tasks` (a minha caixa, `view=pending|decided`) e `POST /approval-tasks/{id}/claim|approve|reject|return` (`approval.decide`, com a entidade como atributo ABAC), `/approval-delegations` (+ `revoke`; `approval.delegate`). Alterar ou arquivar o registo cancela o processo (hook nas escritas, falha fechado);
a conclusão emite `workflow.instance.approved|rejected|returned|cancelled|failed` por outbox, na mesma transacção, sem escrever no recurso.
**Frontend** (`features/dynamic-core/workflows`). **Caixa de aprovações** `/t/:slug/approvals` (menu «Aprovações» para quem tem `approval.decide`): pedido (com ligação ao registo), solicitante, etapa e critério, valor, prazo (e «Em atraso»), versão submetida e «Por delegação»; só as acções que o servidor permite (reclamar, aprovar, rejeitar e devolver com motivo obrigatório); «Já tratadas»; as minhas delegações (criar com âmbito e montante máximo, revogar).
**Painel «Aprovação» no detalhe do registo:** o processo mais recente, as tarefas, o motivo do fim («cancelado porque o registo foi alterado…») e «Submeter para aprovação» (escolha do workflow com as etapas). **Designer** `/t/:slug/entities/:entityKey/fluxos` (`workflow.*` → `configuration.workflows.*`; ligação «Aprovações» no detalhe da entidade): etapas (nome, código gerado, critério, quórum, prazo, auto-aprovação, condição reutilizando o construtor das regras),
responsáveis por pessoa ou papel, montante/moeda, ordenar/remover, resumo do fluxo e problemas locais, «Verificar com o servidor», publicar, retirar e nova revisão.
**Verificado:** backend lint, format, typecheck, build e `npm test` (446 testes na última corrida completa; depois só se voltaram a correr os ficheiros afectados (workflows, matriz de isolamento, paridade do OpenAPI: 29 testes); incluem `workflows.spec.ts`: duas etapas com tarefa de grupo reclamada em concorrência, decisões simultâneas e idempotentes, rejeitar/devolver, QUORUM, auto-aprovação, condições, alteração do registo, delegações com âmbito/montante/revogação/ciclos, permissões e imutabilidade por SQL;
matriz de isolamento estendida a todas as rotas e tabelas; paridade do OpenAPI) com a migration subida e descida numa base limpa; frontend lint, format, `check:generic`, `ng test` (829) e build; E2E em browser real sobre a API real (27 verificações, zero erros de página): criar o workflow de raiz (código gerado, só campos decimais no montante, aviso de responsável em falta, verificação e publicação pelo servidor), submeter pelo painel (etapas no diálogo, versão submetida), caixa do aprovador (solicitante, etapa, valor, versão), aprovar, «Já tratadas», processo aprovado visto pelo solicitante, alterar o registo e ver o processo cancelado com a explicação, rejeitar com motivo obrigatório, criar e revogar uma delegação, e o menu «Aprovações» só para quem decide. O E2E encontrou e corrigiu um defeito anterior: o detalhe do registo rebentava a renderização para quem não tem `audit.read` (lia o histórico em erro); agora explica que o histórico não está disponível. O script `e2e310.mjs` existe só na pasta temporária da sessão.

**Não verificado / limites:** o E2E correu por script local; **sem escalonamento, notificações nem calendário de SLA** (o prazo vencido só se assinala; nunca aprova), **sem substituição de aprovadores inactivos** (o processo falha ao abrir a etapa), sem worker/inbox do outbox (D-015) nem módulos que consumam `workflow.instance.approved`; sem ramificações nem devolução a uma etapa anterior;
qualquer alteração do registo cancela o processo; o aprovador vê o `snapshot` sem precisar de `dynamic.read` (a confirmar); sem lista de «workflows» na listagem dos registos; o utilizador de um registo precisa de `entity.read` para a interface carregar a entidade (limitação anterior do registo de entidades no cliente).

### 2c.11 Fatia 3.11 — automações e «Viatura» de ponta a ponta (concluída; ver D-045)
**Servidor.** Módulo `app/dynamic/automations` (migration 22): `automations` (gatilho único: evento ou calendário com fuso; condição AST; acções; estado DRAFT/ACTIVE/PAUSED; versão a cada alteração; membro de execução; próxima execução), `automation_runs` (chave de deduplicação única, estado PENDING/RUNNING/SUCCEEDED/FAILED/DEAD, tentativas, progresso, profundidade e execução causadora, erro, quem reprocessou), `outbox_deliveries` (inbox) e, no outbox,
`causation_run_id`/`causation_depth`. Os módulos de estados e de workflows registam os seus eventos e acções no catálogo. O motor (`AutomationEngine`) despacha os eventos novos e os calendários vencidos e executa as execuções devidas (bloqueio `SKIP LOCKED`, recuperação de execuções presas), em nome de quem activou; `automation:work` percorre os tenants operacionais. API: `GET /automations/catalog`, `/automations`
(+ `activate`, `pause`, `simulate`; `automation.read|manage`), `/automation-runs` e `POST /automation-runs/{id}/retry`.
**Frontend** (`features/dynamic-core/automations`, rota `/t/:slug/automations`, menu «Automações»): lista com gatilho, estado e **próxima execução com o fuso**, editor (gatilho do catálogo, condição sobre os campos do evento reutilizando o construtor das regras, acções com parâmetros fixos ou campos do evento, limite por hora), **simulação** com um evento de exemplo, activar/pausar,
histórico de execuções (por automação ou todas) com a causa da falha e o **reprocessamento** das que o motor não fechou por regra.
**Viatura de ponta a ponta** (`tests/functional/viatura_end_to_end.spec.ts`; «Viatura» é só um tenant a definir tudo pela API, o núcleo não conhece o sector): entidade com campo único, pesquisável e sensível, formulário publicado, regra de quilometragem, máquina de estados, workflow de manutenção com montante, automação «aprovada → enviar para manutenção»; uso com validação, duplicados, campos sensíveis, pesquisa,
aprovação pela chefia, execução da automação em nome de quem a activou, cadeia de causalidade no outbox, auditoria sem valores sensíveis, versão 2 da entidade com o registo antigo legível e isolamento entre tenants.
**Verificado:** backend lint, format, typecheck, build e `npm test` (474 testes; `automations.spec.ts` cobre catálogo e validações, activação em nome de quem activa, condição, evento duplicado, ciclo A→B→A e auto-causalidade, limite por hora, pausa, falha→recuo→fila de falhas→reprocessamento auditado que retoma a seguir à última acção, tenant suspenso, membro suspenso, falta de permissões, calendário e simulação; `automation_domain.spec.ts` cobre o calendário, incluindo fusos e mudança de hora;
matriz de isolamento e paridade do OpenAPI estendidas) com a migration subida e descida numa base limpa; frontend lint, format, `check:generic`, `ng test` (844) e build; E2E em browser real sobre a API real (15 verificações, zero erros de página): menu, catálogo de eventos, condição e acção a partir do catálogo, simulação (executaria / não executaria), activar, o comando `automation:work --once` a processar um evento real,
registo concluído em nome de quem activou, histórico, pausa que bloqueia execuções e uma falha visível na fila com o erro e a próxima tentativa.
**Não verificado / limites:** o E2E correu por script local (`e2e311.mjs`, só na pasta temporária da sessão); a prova de «Viatura» é um teste de API — o registo, a pesquisa e a auditoria **na interface** já foram verificados em browser nas fatias anteriores mas não se repetiram aqui; o trabalhador é um processo à parte (não arranca com a API); sem acções de notificação ou de tarefas, sem retenção da inbox nem das execuções,
at-least-once sem idempotência própria das acções, e um calendário só dispara com o trabalhador a correr (D-045).

## 2d. Fase 4 — comércio e inventário (em curso; fatia 4.1 concluída)
A especificação (F4) pede M01 a M08 e S01 «em fatias: catálogo/clientes, propostas/encomendas, expedições, faturas/créditos, compras/recepções e inventário», com testes dos fluxos 9.3 e 9.4 (operações parciais e reversões) e sem confundir confirmação, reserva, expedição, emissão e recebimento. A decomposição abaixo é **proposta** (a especificação não a fixa; sujeita a confirmação):

| Fatia | Âmbito | Estado |
| --- | --- | --- |
| 4.1 | M03 catálogo: categorias, produtos, variantes (SKU), tabelas de preços e resolução de preço; primeiro módulo de negócio no registo (`catalog`) | **Concluída** (ver 2d.1 e D-046) |
| 4.2 | M01 clientes (sobre a Party), segmentos e interacções | **Concluída** (ver 2d.2 e D-047) |
| 4.3 | M04 propostas e encomendas (preço em snapshot, confirmação ≠ reserva) | **Concluída** (ver 2d.3 e D-048) |
| 4.4 | M07 armazéns, movimentos de stock rastreáveis, lotes e reservas | Por fazer |
| 4.5 | M04 expedições (baixa de stock) | Por fazer |
| 4.6 | M05 contratos, faturas e notas de crédito (S01: documentos emitidos) | Por fazer |
| 4.7 | M06 fornecedores, requisições e compras/recepções | Por fazer |
| 4.8 | M08 transferências, inventários físicos e devoluções | Por fazer |
| (a seguir) | M02 leads, oportunidades e campanhas | Por fazer |

### 2d.1 Fatia 4.1 — catálogo (M03; concluída, ver D-046)
**Mapa.** Backend `app/modules/catalog` (domain, application, infrastructure, presentation; migration 23): `product_categories` (árvore), `products` (GOODS/SERVICE, unidade base, rastreio NONE/LOT/SERIAL), `product_variants` (SKU único por tenant, código de barras único quando existe, atributos, uma variante por omissão),
`price_lists` (organização, moeda, validade, IVA incluído, prioridade) e `price_list_items` (escalão `min_quantity` > 0, `unit_price` money, `max_discount` 0..1; único por tabela+variante+escalão). Permissões `catalog.read|manage` e `price.read|manage`; rotas atrás de `middleware.feature` (`catalog.products`, `catalog.prices`) e do manifesto `catalog` no registo de módulos.
API: `/product-categories`, `/products`, `/products/{id}/variants`, `/variants`, `/price-lists`, `/price-lists/{id}/items` e `GET /prices/resolve`. Frontend: módulo «Catálogo e preços» com produtos e variantes, categorias, tabelas de preços e o simulador de preço.
**Aceitação (spec M03).** SKU duplicado falha; um serviço não rastreia nem reserva stock; a linha conserva o preço anterior depois de actualizar a tabela (a resolução devolve o valor e a origem para o documento o guardar em snapshot); tabela escolhida por prioridade e validade, sem empate ambíguo; mudar a unidade base ou o rastreio de um produto com movimentos exige migração.

**Verificação (fatia 4.1).** Backend: lint, format, typecheck, `npm test` (497 testes, incluindo 12 unitários do domínio, 11 funcionais do catálogo, a matriz de isolamento estendida a categorias, produtos, variantes, tabelas e itens — ids alheios → 404 e nada muda — e a paridade do OpenAPI) com a migration 23 subida e descida numa base limpa, e build. Frontend: lint, format, `check:generic`, `ng test` (857) e build. E2E em browser real sobre a API real (16 verificações, zero erros de página): menu, categoria, produto com variante por omissão, variante com atributos, SKU duplicado com a mensagem do catálogo, serviço sem controlo de stock, pesquisa, preço com 5 casas recusado, dois escalões e a resolução (12 unidades → escalão de 10 a 1 350,0000; 3 unidades → 1 500,0000, com a origem) e o tenant B sem ver nem aceder (404) ao produto do A. O E2E encontrou dois erros que os testes unitários não apanhavam (o frontend assumia um estado `active` nas categorias que a API não tem; e uma data indefinida enviada como texto na resolução) — ambos corrigidos e cobertos.
**Não verificado / limites:** o E2E correu por script local (`e2e41.mjs`, só na pasta temporária da sessão) e a base de desenvolvimento recebeu apenas a migration 23 e um plano de demonstração (`demo_catalog`) para os tenants `demo_a`/`demo_b`; **o bloqueio por movimentos de stock está provado só com uma guarda de teste** (não há inventário até à 4.4); nenhum documento usa ainda o preço em snapshot (4.3); sem desactivação de categorias, sem editar variantes nem itens de preço na interface, sem promoções, preços por cliente/segmento, importação nem imagens (D-046). A decomposição da Fase 4 continua uma **proposta** à espera de confirmação.

### 2d.2 Fatia 4.2 — clientes (M01; concluída, ver D-047)
**Mapa.** Backend `app/modules/customers` (migration 24): `customer_segments`, `customers` (Party + organização, condições comerciais, estado `ACTIVE|BLOCKED|INACTIVE`) e `interactions` (sobre a Party). Permissões `customer.read|create|update|block|credit_manage`; rotas `/customers`, `/customers/{id}/block|unblock`, `/customer-segments`, `/interactions` atrás de `middleware.feature` (`customers.accounts`, `customers.interactions`). Frontend: o módulo `crm.customers` (que passa a apontar ao módulo `customers` do servidor) ganha a página «Clientes» (lista com pesquisa e filtros, cadastro sobre Party existente ou criação guiada, crédito, bloqueio com motivo, contactos, interacções) e os segmentos.
**Aceitação (spec M01).** Um cliente partilha a Party (não a duplica; a mesma Party em duas organizações são dois clientes); o operador sem acesso financeiro não vê o limite de crédito; um cliente bloqueado continua a poder ser regularizado e só recusa novas confirmações de venda (`assertSaleAllowed`).
**Verificação (fatia 4.2).** Backend: lint, format, typecheck, `npm test` (516 testes: 8 unitários do domínio, 11 funcionais — Party partilhada e duplicada, ids/referências de outro tenant, pesquisa e filtros, crédito por permissão, bloqueio e `assertSaleAllowed`, interacções, permissões e módulo desligado, auditoria — e a matriz de isolamento e a paridade do OpenAPI estendidas) com a migration 24 subida e descida numa base limpa. Frontend: lint, format, `check:generic`, `ng test` (870) e build. E2E em browser real sobre a API real (12 verificações, zero erros de página): segmento, cliente com criação guiada da organização (e do NIF), crédito, recusa da mesma Party na mesma organização, pesquisa por NIF, bloqueio com motivo e desbloqueio, interacção na linha do tempo e isolamento (404 e lista vazia no outro tenant). O E2E apanhou que a criação guiada de uma organização com NIF falhava (a Party exige o país da identificação fiscal) e que a mensagem genérica «Verifique os campos» escondia a causa — corrigidos (país da organização vendedora; a interface mostra agora as mensagens por campo).
**Não verificado / limites:** o E2E correu por script local (`e2e42.mjs`, só na pasta temporária da sessão); a visão sem crédito está provada por testes de API e de componente, **não** em browser (exigiria outro utilizador); **não há verificação de crédito nem saldo** (4.6); a interface só regista interacções dentro de um cliente; a base de desenvolvimento recebeu a migration 24 e uma nova revisão do plano `demo_catalog` (módulo `customers`) para `demo_a`/`demo_b`; o desvio `customer.credit_manage` está por reconciliar com a especificação.

### 2d.3 Fatia 4.3 — propostas e encomendas (M04; concluída, ver D-048)
**Mapa.** Backend `app/modules/orders` (migration 25): `sales_quotes`, `sales_orders` e `sales_lines` (instantâneo de preço, imposto e totais; linhas imutáveis fora do rascunho por trigger). Permissões `quote.read|manage`, `order.read|manage`, `sales.confirm`; rotas `/quotes` (linhas, `send`, `reject`, `accept`) e `/sales-orders` (linhas, `confirm`, `cancel`) atrás de `middleware.feature` (`orders.quotes`, `orders.orders`). Eventos de outbox `sales.quote.accepted`, `sales.order.confirmed`, `sales.order.cancelled`. Frontend: o módulo `sales.orders` («Orçamentos e vendas») ganha a página «Propostas e encomendas».
**Aceitação (spec M04, o que esta fatia cobre).** Confirmar duas vezes (ou em concorrência) não duplica nada — um número, um evento; uma proposta aceite converte-se por comando idempotente; o preço da linha não muda quando o catálogo muda; confirmação ≠ reserva ≠ expedição ≠ factura; cliente bloqueado não recebe novas confirmações; uma verificação registada (stock) pode recusar a confirmação sem deixar a encomenda confirmada. **Fica para as fatias seguintes:** entrega parcial e saldo (4.5), stock insuficiente e reservas reais (4.4), crédito na confirmação (4.6) — as duas últimas ligam-se por `registerConfirmationCheck` e pelo evento `sales.order.confirmed`.
**Verificação (fatia 4.3).** Backend: lint, format, typecheck, build e `npm test` (541 testes: 10 unitários da aritmética e do domínio, 15 funcionais — preço/escalão/imposto vindos do servidor, instantâneo e imutabilidade por SQL, envio e numeração, aceitação idempotente, expiração, confirmação idempotente e concorrente, verificações que recusam, bloqueio de cliente, cancelamento, permissões, módulo desligado, auditoria e isolamento — e a matriz de isolamento e a paridade do OpenAPI estendidas) com a migration 25 subida e descida numa base limpa. Frontend: lint, format, `check:generic`, `ng test` (885) e build. E2E em browser real sobre a API real (17 verificações, zero erros de página): proposta com duas linhas (escalão de 10 e desconto) e totais exactos do servidor, desconto acima do máximo recusado, envio com número, aceitação, encomenda com os mesmos totais, morada, confirmação com o aviso de que não reserva nem expede, cancelamento com motivo, cliente bloqueado a recusar a confirmação (a encomenda continua rascunho, sem número) e isolamento (404 no outro tenant).
**Não verificado / limites:** o E2E correu por script local (`e2e43.mjs`, só na pasta temporária da sessão); o gancho das verificações de confirmação está provado com uma verificação de teste (não há inventário nem finanças); a expiração foi testada alterando a validade por SQL (não há relógio simulado); a base de desenvolvimento recebeu a migration 25 e uma nova revisão do plano `demo_catalog` (módulo `orders`) para `demo_a`/`demo_b`; ver os limites de D-048 (sem crédito, stock, filiais, preços manuais, PDF, edição de linhas na interface).

### 2e.1 Fatia 1.10 — interfaces em falta da Fase 1 (concluída; ver D-049)
**Mapa.** `features/tenant/permissions` (`roles-manager`, `policies-manager` + `policy-condition`, `access-simulator`; página com separadores), `users/member-access-panel` (atribuições e âmbitos), `organization/{cost-centers-panel,team-panel}`, `party/{parties-page,party-detail,party.api,party-model}`, `profile/{profile-page,profile.api,profile-model}`; rotas `parties` e `profile`, item de menu «Pessoas e entidades», «A minha conta» no menu do utilizador; `detailedErrorMessage`.
**Verificação.** `ng lint`, `format:check`, `check:generic`, `ng test` (946 testes) e `ng build` (produção e desenvolvimento) limpos. E2E em browser real (`e2e110.mjs`, script local na pasta temporária da sessão; 22/22): criar perfil e política (rascunho), simular, atribuir/revogar perfil e âmbito, centro de custo e equipa, Party (criar, contacto, morada, editar, duplicado por contacto), sessões (terminar outra), validação local e erro do servidor na palavra-passe.
**Não verificado / limites:** a alteração de palavra-passe com sucesso não foi exercida no E2E (alteraria a conta de demonstração; coberta só por testes unitários com API simulada); ocultação de campos sensíveis testada só com respostas simuladas; sem teste de ponta a ponta de activação de política; sem UI para a organização por omissão nem fusão de duplicados.

## 3. Regras para todas as fases
- Antes de codificar: mapa de ficheiros, entidades, contratos e testes de aceitação.
- Cada fase termina com lint, typecheck, testes, build e migrations numa base limpa; resultados registados aqui.
- Actualizar `docs/architecture.md` (estado real), `docs/decisions.md` e o OpenAPI.
- Registar o que ficou **por verificar** e porquê, sem o apresentar como concluído.
