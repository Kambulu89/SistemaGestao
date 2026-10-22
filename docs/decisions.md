# Decisões técnicas (ADR)

Formato: contexto → decisão → consequências. Estado: **aceite**, **proposta** (a confirmar) ou **aberta**.
Uma decisão aceite só se altera com um novo registo que a substitua.

## D-001 Monólito modular (aceite)
**Contexto.** Spec §1: implementação inicial API First, monólito modular. **Decisão.** Um único processo da API com
módulos `domain/application/infrastructure/presentation`; workers como processos do mesmo código quando houver jobs.
**Consequências.** Sem microserviços até haver métricas que o justifiquem (spec F9). Fronteiras impostas por regras
de importação (ver `docs/architecture.md` §2), não por rede.

## D-002 Backend em `backend/`, ao lado do frontend (aceite)
**Contexto.** O repositório já tinha o Angular na raiz, com Git, lockfile e CI inexistente. **Decisão.** Acrescentar
`backend/` com `package.json` e lockfile próprios; o frontend **não** é movido. **Alternativas rejeitadas.** Mover o
frontend para `apps/web` com workspaces: alteração larga e arriscada sem benefício imediato. **Consequências.** Dois
`npm ci` independentes; o CI tem dois jobs. Reavaliar workspaces quando existir código partilhado (contratos).

## D-003 AdonisJS 6.x fixado; v7 não adoptado (aceite)
**Contexto.** Spec pede AdonisJS v6. O npm já publica a v7.6 como `latest` (`@adonisjs/core`). **Decisão.** Fixar
`@adonisjs/core ^6.21`, `lucid ^21.8`, `redis ^9.2`, `assembler ^7.8`. **Consequências.** Migrar para a v7 exige ADR
próprio (alteração de versão principal). Ver D-012 sobre as vulnerabilidades da cadeia v6.

## D-004 Angular 22 mantido (aceite)
**Contexto.** A spec indica Angular 19 como "referência da fonte" e manda fixar versões compatíveis antes de iniciar.
O projecto já está em Angular 22.2 (standalone, signals, Vitest) com mais de 500 testes. **Decisão.** Manter 22; não
fazer downgrade. **Consequências.** Nenhuma funcionalidade da spec depende da versão 19.

## D-005 Node e gestor de pacotes (aceite)
**Decisão.** Gestor **npm** (lockfiles `package-lock.json`, `packageManager` do frontend `npm@10.9.4`). Frontend:
`engines` `^22.22.3 || ^24.15.0` (exigido pelo Angular CLI 22). Backend: `>=22.22.0`. Imagens Docker e CI usam
Node 22 (≥ 22.22.3). **Nota.** O ambiente de análise tinha Node 22.22.0: o Angular CLI recusa-se a correr aí; foi usado
um Node ≥ 22.22.3 só para o frontend (não altera os `engines`).

## D-006 Duas contas de base de dados e RLS desde a fundação (aceite)
**Contexto.** Spec §10.1: RLS com `ENABLE` + `FORCE`; conta de runtime sem superuser, sem owner privilegiado e sem
`BYPASSRLS`. **Decisão.** `sg_owner` (migrations/seeds) e `sg_runtime` (aplicação) criadas por
`docker/postgres/init/01-roles.sh`; Lucid com ligações `owner` e `runtime` (por omissão). Função
`app_current_tenant_id()` baseada em `set_config('app.tenant_id', …, true)` (apenas dentro de transacção).
**Consequências.** Todo o acesso a dados de tenant passa por uma transacção com contexto (Fase 1, `TenantContext`);
testes obrigam a conta de runtime. Migrations nunca correm com a conta de runtime.

## D-007 Variáveis de ambiente validadas no arranque (aceite)
**Decisão.** Esquema único (`start/env_schema.ts`); falta ou valor inválido impede o arranque, listando só os nomes.
Segredos: `APP_KEY` em `Secret`; palavras-passe nunca registadas (logger com redacção). `.env.example` sem valores.
**Consequências.** Não existe valor por omissão para segredos; CI e Docker passam-nos explicitamente.

## D-008 Envelope de API, erros e correlation id (aceite)
**Decisão.** Conforme spec §10.2: `{ data, meta:{correlationId} }` e `{ error:{ code, message, details, correlationId } }`.
O correlation id é decidido pelo servidor (aceita um externo só se válido). Erros desconhecidos → 500 genérico
(`INTERNAL_ERROR`), detalhe apenas em logs. **Consequências.** Todo o novo controller usa `envelope()` e lança
`ApiError`/erros VineJS; ver testes `errors.spec.ts`.

## D-009 Saúde e prontidão separadas (aceite)
**Decisão.** `GET /api/v1/health` (liveness, sem dependências) e `GET /api/v1/ready` (base de dados + Redis, limite
2 s por sonda, 503 `NOT_READY` sem mensagens internas). Não expõem dados de negócio nem de tenants.

## D-010 Convenções de migrations e seeds (aceite)
**Decisão.** Migrations versionadas pelo Lucid (`naturalSort`), executadas com a conta `owner`
(`npm run migrate`); **sem** `IF NOT EXISTS` indiscriminado (um conflito deve falhar); estratégia expand/contract;
seeds idempotentes só para permissões, módulos e referências; dados de demonstração só fora de produção e em dois
tenants. Os testes aplicam as migrations no arranque e desfazem-nas no fim (base `*_test` própria).
**Estado.** Não existem seeds ainda (não há dados de referência a semear).

## D-011 Qualidade automática (aceite)
**Decisão.** Backend: `eslint` (`@adonisjs/eslint-config`), `prettier`, `tsc --noEmit`, Japa (unit + functional),
`node ace build`. Frontend: `ng lint`, `prettier --check`, `check:generic`, `ng test`, `ng build`. CI executa-os e ainda
as migrations numa base limpa. **Não** há cobertura mínima imposta ainda.

## D-012 Vulnerabilidades da cadeia AdonisJS v6 (aceite temporariamente)
`npm audit --omit=dev` em `backend/` reporta 16 (4 moderate, 12 high), todas **transitivas** de
`@adonisjs/assembler`/`core`/`lucid` (ts-morph, fast-glob/micromatch/braces/globby/cpy, `@faker-js/faker`); a correcção
sugerida pelo npm é saltar para versões principais diferentes (v7) ou recuar. O frontend reporta 0.
**Decisão.** Não forçar `npm audit fix --force`. As bibliotecas afectadas são ferramentas de build/geração de código e
não processam pedidos HTTP. **Acção.** Reavaliar em cada fase e quando se decidir a migração para a v7; registar
aqui o resultado. **Risco aceite por:** equipa de desenvolvimento, até à primeira produção.

## D-013 Sessão e selector de tenant (aceite — fatias 1.2 e 1.3)
Sessão opaca em cookie `HttpOnly`/`Secure`/`SameSite` com protecção CSRF; sem credenciais em `localStorage`/
`sessionStorage`. O tenant viaja como **selector explícito** (domínio verificado ou cabeçalho) e é sempre validado
contra a sessão e a membership activa; o frontend pode manter `/t/:slug` na URL. Substitui o `sessionStorage` do mock.
A parte da sessão está em D-018 e o selector de tenant em D-023.

## D-014 Nomenclatura de permissões (aceite — fatia 1.4)
Backend: `<recurso>.<acção>` em minúsculas (`iam.manage`, `member.invite`, `invoice.approve`), com `code = resource || '.' ||
action` garantido por CHECK. O frontend usa `<módulo>.read|manage` e `entities.<chave>.<op>`: o mapeamento faz-se num único
ponto (adaptador do contexto, fatia 1.8); as chaves do mock mantêm-se só até serem substituídas.

## D-016 Transporte do contexto de tenant e acesso a dados (aceite — fatia 1.1)
**Decisão.** `TenantContext` imutável (campos da spec §10.1; validação de UUIDs e coerência actor/identidades) transportado
por `AsyncLocalStorage` (`TenantContextStore`) e entregue aos casos de uso como `TenantScope` por
`TenantUnitOfWork.run()`. A implementação Lucid abre uma transacção na conta de runtime e faz
`set_config('app.tenant_id', …, true)`; os repositórios derivam de `TenantRepository`. O `tenant_id` nunca é um valor
fornecido pelo chamador. **Alternativas rejeitadas.** Filtrar só na aplicação (sem RLS); `SET` de sessão (contamina o
pool); passar o `tenantId` solto por parâmetro. **Consequências.** Todo o acesso a dados de tenant é transaccional;
jobs e consumidores têm de construir o seu contexto (actor `SERVICE`) e usar o mesmo mecanismo.

## D-017 Fronteiras de módulo verificadas por teste (aceite — fatia 1.1)
**Decisão.** `tests/support/architecture.ts` analisa os imports de `app/**` (R1–R6, ver `architecture.md` §2) dentro de
`npm test`. Cada módulo expõe uma API pública (`index.ts`); o kernel HTTP (`core/http`) é partilhado.
**Limite.** Só analisa imports; escritas SQL cruzadas entre módulos não são detectáveis estaticamente.

## D-018 Sessão opaca, cookie e CSRF (aceite — fatia 1.2)
**Decisão.** O token de sessão tem 256 bits aleatórios; a base guarda só o SHA-256 (`auth_sessions.token_hash`). Cookie
`sg_session` (`__Host-sg_session` em produção), `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` em produção. Validade
absoluta de 12 h; `last_seen_at` actualiza-se no máximo de 60 em 60 s. Revogação por sessão ou em lote (alteração e
recuperação de palavra-passe). CSRF: nas escritas autenticadas exige-se `X-Csrf-Token` = HMAC(`APP_KEY`, id da sessão)
(obtido no login e em `GET /me`) e o `Origin` de browser, quando presente, tem de estar em `CORS_ORIGINS` (também nas
rotas públicas, contra *login CSRF*). **Nota.** O Adonis serializa o valor de `plainCookie` num envelope base64; não é
cifra, o segredo continua a ser o token. **Alternativas rejeitadas.** JWT (revogação difícil); token em `localStorage`.
**Parâmetros de demonstração** (validar com o produto): 12 h de validade absoluta, sem *remember me*, sem limite de
sessões em simultâneo.

## D-019 Palavras-passe e tokens de uso único (aceite — fatia 1.2)
**Decisão.** Hash `scrypt` do Adonis (custo 16384, r=8, p=1), com `needsReHash` no login. Política: 12–128 caracteres,
diferente do email e fora de uma lista mínima de valores triviais (sem regras de composição). Falha de login
indistinguível entre utilizador inexistente, palavra-passe errada e conta pendente/bloqueada (verifica-se contra um hash
fictício para igualar o tempo). Tokens de recuperação (1 h) e de verificação de email (24 h): 256 bits, só o hash na
base, uso único garantido por `UPDATE … WHERE consumed_at IS NULL AND expires_at > now()` dentro da mesma transacção que
altera a palavra-passe e revoga as sessões. Um pedido novo invalida os anteriores. A recuperação responde sempre `202`
com o mesmo corpo. **MFA e SSO ficam fora da Fase 1** (`auth_sessions.mfa_verified_at` já existe, não é usado).

## D-020 Limitação de taxa em Redis (aceite — fatia 1.2)
**Decisão.** Contador de janela fixa em Redis (`INCR` + `EXPIRE`, auto-reparável; sem Lua para respeitar R5). Login: 20
por IP e 5 por conta+IP em 15 min (as chaves usam HMAC do email, nunca o email). Recuperação: 10/h por IP (429) e 3/h
por conta (ignorado em silêncio). Alteração de palavra-passe: 5/15 min por utilizador. Resposta `429 RATE_LIMITED` com
`Retry-After`. **Limitação.** `request.ip()` é o IP do socket; atrás de um proxy é preciso configurar `trustProxy`
(por fazer, depende da infraestrutura de produção).

## D-021 Entrega de email (porta + driver de desenvolvimento; fornecedor em aberto)
**Decisão.** `TokenMailer` é uma porta. `MAIL_DRIVER=dev-redis` guarda a mensagem (incluindo o token) numa lista Redis
para desenvolvimento e testes e é **proibido em produção** (`assertEnvConsistency`); `none` regista um aviso sem token.
Escolher o fornecedor real (SMTP/API) é decisão de produto pendente; sem ela, recuperação e verificação de email não
chegam a utilizadores reais.

## D-022 Identidade e plano de controlo são tabelas globais (aceite — fatia 1.2)
**Decisão.** `tenants`, `tenant_domains`, `users`, `auth_sessions` e `one_time_tokens` são globais e constam de
`PLATFORM_TABLES` (nada se infere por ausência de filtro). Não têm RLS: a conta de runtime lê-as sem contexto de tenant,
por isso o acesso é feito só pelos repositórios do módulo e o dono de cada acesso é a camada de aplicação.
`tenant_domains.hostname` é único globalmente (409 em duplicado). Estados do tenant: PROVISIONING→ACTIVE→
SUSPENDED↔ACTIVE→CLOSING→CLOSED (domínio, com versão optimista). `ProvisioningStep` e a API HTTP de plataforma
(administrador SaaS) ficam para depois; por agora a gestão faz-se por comandos `node ace` (`tenant:*`, `user:create`).

## D-023 Resolução do tenant, membership e leitura por utilizador (aceite — fatia 1.3)
**Decisão.** Não há "tenant actual" guardado na sessão: cada pedido de tenant traz um **selector** (`X-Tenant-Id`,
`X-Tenant-Code` ou domínio verificado no `Host`; vários têm de coincidir, senão 400). O middleware `tenant` (depois de
`auth`) segue a spec §10.1: tenant candidato → membership **ACTIVE** do utilizador → tenant **ACTIVE** → constrói o
`TenantContext` (com `permissionsVersion` = `authorization_version` da membership) → corre o pedido dentro do
`TenantContextStore`. Tenant inexistente e tenant sem membership dão o mesmo `403 TENANT_ACCESS_DENIED`; só depois de
confirmada a membership se distingue `403 TENANT_NOT_ACTIVE`. Trocar de tenant é mudar o selector e recarregar
`GET /context`; como o contexto é reconstruído por pedido, nada do tenant anterior é reutilizado.
`tenant_memberships` é tabela de tenant (RLS forçada). Para ler *as próprias* memberships antes de haver contexto
existe a política `tenant_memberships_self_read` (`FOR SELECT USING (user_id = app_current_user_id())`), com
`app.user_id` definido pelo servidor numa transacção a partir da sessão autenticada; escritas continuam a exigir o
contexto de tenant. **Alternativas rejeitadas.** Função `SECURITY DEFINER` (a RLS é forçada também para o dono, exigiria
`BYPASSRLS`); tabela global de memberships (quebra o princípio de tenant); guardar o tenant na sessão (estado partilhado
entre separadores). **Limitações.** Sem `MembershipScope`/unidades (1.5): `unitScope` fica `UNITS []` (nega por omissão).
`GET /context` devolve só o que existe (tenant, membership, utilizador, locale, `authorizationVersion`, âmbito);
módulos, funcionalidades, permissões e configurações entram com C03/C06/C09. Não há API HTTP de membros: a gestão faz-se
por `node ace membership:add|status` até aos convites (1.6).

## D-024 Modelo de autorização RBAC + ABAC (aceite — fatia 1.4)
**Decisão.** Catálogo `permissions` **global**, declarado no código (`PERMISSION_CATALOG`) e semeado por `iam:sync`
(idempotente; também faz crescer o papel `tenant_admin`). Papéis, `role_permissions`, `role_assignments` (com janela de
validade e unidade opcional) e `access_policies` são de tenant (RLS + FKs compostas). A decisão é uma função pura
(`decide`): (1) RBAC — tem de haver atribuição válida cujo papel concede a permissão, senão nega; (2) qualquer política
**DENY** activa aplicável cuja condição seja verdadeira — ou não avaliável — nega (falha fechada); (3) havendo políticas
**ALLOW** aplicáveis, pelo menos uma tem de se verificar. As regras de campo (`HIDDEN` prevalece sobre `READ_ONLY`) vêm das
políticas ALLOW que se aplicaram; `redactFields`/`forbiddenChanges` aplicam-nas. As condições são uma **AST declarativa**
(and/or/not/eq/neq/gt/gte/lt/lte/in/exists; variáveis só `subject.`, `resource.`, `env.`; máx. 8 níveis e 50 nós; acesso
só a propriedades próprias; decimais em string comparados como números); nunca se executa código do tenant. O sujeito da
avaliação vem sempre do `TenantContext`. Atribuição limitada a uma unidade só vale para recursos dessa unidade (sem
hierarquia até à 1.5). Rotas protegidas por `middleware.can({ permission })` depois de `auth` e `tenant`; a razão da
recusa não vai para o cliente (`403 PERMISSION_DENIED`). Alterar papéis/atribuições/políticas incrementa a
`authorizationVersion` (das memberships afectadas, ou de todas no caso das políticas) na mesma transacção. Sem cache de
decisões por agora (cada pedido consulta a base), portanto a revogação é imediata. **Não incluído:** `MembershipScope`
(precisa de organizações — 1.5), filtro de linhas antes da paginação (não há listagens de domínio ainda; o contrato é
traduzir as condições para filtros SQL quando existirem), protecção do último administrador (1.6), auditoria (Fase 2).

## D-025 Organização, unidades e âmbitos de acesso (aceite — fatia 1.5)
**Decisão.** `organizations`, `organization_units`, `cost_centers`, `team_members` e `membership_scopes` são de tenant (RLS +
FKs compostas). "Pai da mesma organização" é imposto **pela base**: a FK do pai é
`(tenant_id, organization_id, parent_id) → (tenant_id, organization_id, id)`; "não ser pai de si" é um CHECK. Os **ciclos**
não se exprimem em FKs: a aplicação rejeita-os (`wouldCreateCycle`, 422 `INVALID_PARENT`) sob um lock consultivo por tenant
(`pg_advisory_xact_lock`) que serializa as alterações às árvores. O código e a organização de uma unidade/centro não mudam
(mudar de organização exigiria tratar documentos, que ainda não existem). Inactivar uma unidade preserva o histórico e
recusa novos registos (`UNIT_INACTIVE` nas equipas; os módulos futuros devem fazer o mesmo). Centros de custo são uma árvore
própria, independente da operacional. **Âmbitos (`MembershipScope`).** Sem unidade = todas as unidades da organização; com
unidade = essa unidade e, se `include_descendants`, a subárvore. O `TenantContext.unitScope` passa a ser a lista plana
expandida (`UNITS [...]`) calculada ao resolver o tenant; **sem âmbitos não há acesso a nenhuma unidade** (nega por omissão)
e `ALL` não é atribuído a utilizadores. A estrutura (organizações, unidades, centros) é governada só por RBAC
(`organization.read|manage`); o âmbito aplica-se aos **dados de domínio** com `unitId` (módulos futuros): `decide` recusa
(`UNIT_OUT_OF_SCOPE`) um recurso de uma unidade fora do âmbito, e as políticas podem usar `resource.unitId in
subject.unitIds`. Atribuições de papel por unidade passam a ter FK composta para `organization_units`; uma atribuição por
unidade continua a valer só para essa unidade (sem herança; a herança faz-se pelos âmbitos). Alterar âmbitos incrementa a
`authorizationVersion`. **Por fazer / limites.** Moeda base e país: a regra "não muda após lançamentos" só pode ser imposta
quando existirem lançamentos (módulos financeiros); por agora a alteração é permitida. Sem verificação de impacto na
reorganização nem "unidade com documentos".

## D-015 Filas e workers (adiada)
Redis está presente (cache, limites de taxa). A biblioteca de filas e o processo worker serão escolhidos quando houver
o primeiro job real (outbox, Fase 2). Não se acrescenta um worker vazio.

## Decisões de produto pendentes (spec §11.2 — não bloquear o core)
Preços reais dos planos e quotas; primeiro vertical comercial; países/regimes fiscais; fornecedores de
email/SMS/WhatsApp/pagamento; calendário de férias; alçadas e segregação; política de retenção; RPO/RTO; limites de
integração. Até decisão: parâmetros de demonstração identificados e conectores fiscais/financeiros desactivados.
