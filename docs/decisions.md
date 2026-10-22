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
A parte da sessão está em D-018 o selector de tenant em D-023 e a ligação do frontend em D-028.

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

## D-026 Convites, quota de membros e último administrador (aceite — fatia 1.6)
**Convites.** `invitations` guarda só o SHA-256 do token; o token é `<tenantId>.<segredo de 256 bits>` (o id do tenant serve
apenas para localizar a linha sob RLS; a prova é o segredo). Vai **só por email** (a resposta da API nunca o contém). Validade
7 dias por omissão (1–30; parâmetro de demonstração). Um convite pendente por email e tenant (índice parcial); um expirado é
marcado `EXPIRED` ao convidar de novo. A aceitação exige **sessão** (conta existente ou registada e verificada) cujo **email
coincide** com o do convite, e corre numa transacção com lock por tenant: uso único mesmo sob concorrência, tenant activo e
quota. Qualquer falha de token/email/estado/prazo responde igual (`400 INVALID_OR_EXPIRED_TOKEN`). Quem já é membro activo →
409; suspenso não se auto-reactiva; quem saiu (`LEFT`) volta com um convite novo e **a mesma membership** (única saída de
`LEFT`). Papéis e unidades do convite são revalidados ao aceitar (o que entretanto desapareceu é ignorado). A mesma conta
mantém a identidade única entre tenants.
**Quota.** Conta tudo o que não é `LEFT` e é verificada na aceitação sob o lock de membros. O limite vem do plano contratado
(D-030; substituiu a coluna provisória `tenants.max_members`, entretanto removida).
**Último administrador.** `AdminGuard` serializa (lock por tenant) as alterações que podem retirar administradores e recusa
(409 `LAST_ADMIN`, transacção anulada) a que deixe o tenant sem nenhum membro ACTIVE com atribuição sem limite de unidade de
um papel que concede `iam.manage`. Aplica-se a suspender/terminar um membro, revogar uma atribuição e alterar as permissões
de um papel. Só actua se havia administrador antes. **Não cobre** políticas DENY que bloqueiem todos nem apagar o utilizador.
**Preferências.** Lista **fechada** de chaves (`ui.theme|density|locale|timezone`, `notifications.email|digest`,
`table.pageSize`) com valores validados; impostos, moeda e limites de segurança não são preferências e são recusados
(`UNKNOWN_PREFERENCE`). **Módulos.** `core/members` (convites, membros, preferências) depende de `membership`, `permissions`,
`organization` e `auth` só pelos `index.ts`; a aceitação é exposta pela plataforma, que injecta o estado e a quota do tenant.

## D-027 Party, subtipos coerentes, duplicados e campos sensíveis (aceite — fatia 1.7)
**Modelo.** `parties` (PERSON | ORGANIZATION), `people`, `organization_parties`, `contacts`, `addresses`, `party_relationships`
(todas de tenant). "Exactamente um subtipo coerente com o `kind`" é imposto pela base: cada subtipo tem uma coluna `kind` fixa
(CHECK) e uma FK composta `(tenant_id, party_id, kind) → parties (tenant_id, id, kind)`, mais `unique(tenant, party_id)`. A
**existência** do subtipo garante-a a aplicação (cria party e subtipo na mesma transacção); não há restrição diferida que impeça
um party sem subtipo se alguém escrever SQL directo. Um contacto/morada principal por tipo e party (índice parcial único; o
primeiro de cada tipo é o principal e pedir principal demove o anterior, sob lock por party). Fornecedor empresarial não exige
Person. `tenant_memberships.person_id` passa a ter FK composta para `people` e é único por tenant (uma pessoa por membership);
a API liga pelo **id do party** (`PUT /memberships/:id/person`) e a membership expõe `personId` (= `people.id`).
**Duplicados.** Chaves normalizadas guardadas (`identity_key`, `tax_key`, `contacts.value_key`: documento sem pontuação,
email em minúsculas, telefone só dígitos, site sem esquema/www) servem o **aviso** `possibleDuplicates` (na criação/alteração e em
`GET /parties/:id/possible-duplicates`). Nunca bloqueia nem funde. **Fusão assistida (`party.merge`) não foi implementada:** exige
trilho de auditoria (Fase 2) e remapeamento de ligações de módulos que ainda não existem; a permissão não consta do catálogo.
**Campos sensíveis.** `birthDate`, `nationality`, `identityType` e `identityNumber` são alvo das regras de campo de C06: um
`HIDDEN` para `party.read` retira-os de todas as respostas (detalhe, criação, alteração) e um `READ_ONLY`/`HIDDEN` para
`party.update` recusa a alteração (`403 FIELD_FORBIDDEN`). A pesquisa (`q`) só olha para nome, referência e contactos, nunca
para identificação. Alterar o NIF/nome não reescreve documentos emitidos: os módulos de documentos guardarão o seu snapshot.
**Limites.** Contactos e moradas não têm regras de campo próprias; não há arquivamento em cascata; `organizations.address_id` (a
organização interna) continua sem FK para `addresses`.

## D-028 Frontend ligado ao backend: sessão em cookie, selector de tenant e permissões (aceite — fatia 1.8)
**Sessão.** O token é o cookie `HttpOnly` do servidor; o JavaScript nunca o vê. O frontend guarda **só em memória** o utilizador, o
token anti-CSRF e a expiração; nada em `sessionStorage`/`localStorage` (excepto o último tenant, conveniência sem segredo). Ao
arrancar, `provideAppInitializer` chama `GET /me` para restaurar a sessão do cookie antes da primeira navegação. O
`authInterceptor` envia `withCredentials`, `X-Csrf-Token` nas escritas e `X-Tenant-Id` (nunca em `/auth/*`, `/me/tenants` e
`/invitations/accept`; um selector explícito do chamador prevalece, como no pedido de contexto de um tenant ainda não activo).
Um 401 num pedido autenticado limpa o estado local (`expireLocally`, sem novo pedido) e leva ao login; um 401 do próprio login ou
do `GET /me` não conta como sessão expirada. **Erros.** O `errorInterceptor` converte o envelope de erro da API em `ApiError`
(`code`, `message`, `fieldErrors`, `correlationId`, `retryAfterSeconds`); `details` mantém o corpo para os adaptadores locais.
**Troca de tenant.** `TenantContextService.switched$` emite quando o tenant activo muda ou a sessão termina: o
`tenantScopeInterceptor` cancela (`takeUntil`) os pedidos em curso do tenant anterior e os serviços registados em
`TENANT_SCOPE_RESETTERS` limpam os seus dados; as listas das páginas dependem do id do tenant (`rxResource.params`), pelo que
pedem de novo. Um pedido cancelado completa sem valor. **Permissões (D-014).** `mapBackendPermissions` é o único ponto de
tradução: cada código do servidor (`member.invite`) mantém-se e ganha os aliases que as páginas esperam (`iam.users.manage`);
`manage` dá `read`, `read` nunca dá `manage`; nunca se produz `platform.*`. Só conveniência: o servidor decide. **Mocks.** Os
gateways mock de identidade e tenants passaram a duplos de teste (`core/testing`) e já não são fornecidos pela aplicação. Continuam
mock no caminho real: entidades dinâmicas, campos personalizados e registos (sem backend para C10–C15), a administração da
plataforma e, **provisoriamente, módulos/subscrição/feature flags do contexto** (`provisional-entitlements.ts`: todos os módulos do
catálogo contratados e activos; só as permissões do servidor limitam o acesso) até existirem C02/C03. O administrador global
(plataforma) não existe no backend: nenhuma conta tem `platform.*`.

## D-029 Auditoria mínima: triggers na base, `audit_logs` imutável e `security_events` (aceite — fatia 2.1)
**Onde se audita.** A alteração é registada por *triggers* `AFTER INSERT/UPDATE/DELETE` (`audit_row_change`, `SECURITY DEFINER`)
na **mesma transacção** da mudança: não há caminho de escrita que a esqueça, e uma falha ao auditar desfaz a operação. O actor
vem de GUCs definidos por `LucidTenantDatabase.run()` junto com o tenant (`app.actor_type/user_id/membership_id`,
`app.correlation_id`, `app.client_ip`; `app.audit_reason` opcional). A entrada guarda `before_data`/`after_data` (linha completa)
e a acção `<tabela>.<INSERT|UPDATE|DELETE>`. **Imutabilidade.** `audit_logs` tem um trigger que recusa `UPDATE/DELETE` e a
conta de runtime só tem `SELECT` (nem `INSERT`: só o trigger escreve); a retenção/expurgo é uma operação da conta `owner` com
`app.audit_purge`, e `app.audit_disabled` (migrations/fixtures) — ambos só valem numa sessão dona (`audit_is_owner_session()`),
por isso a aplicação não os consegue activar. **Redacção.** Colunas sensíveis por tabela são substituídas por `[REDACTED]` no
trigger (`invitations.token_hash`; em `people`: data de nascimento, nacionalidade, identificação); metadados montados pela
aplicação passam por `redactSecrets`. **Cobertura.** Um teste de conformidade exige trigger de auditoria em toda a tabela de
tenant ou isenção justificada em `AUDIT_EXEMPT_TABLES` (`audit_logs`, `user_preferences`). Tabelas escritas fora de contexto de
tenant (`tenant_domains`) também são auditadas: o trigger fixa o tenant da linha só durante o `INSERT`. **Leitura.** `GET
/audit-logs` exige `audit.read` e **além disso** só devolve recursos que o actor pode ler (`AUDIT_READ_PERMISSION`; recurso sem
mapeamento nega por omissão) e retira de antes/depois os campos escondidos pelas regras de campo. **Eventos de segurança.**
`security_events` é global (`tenant_id` nulo quando não há tenant fiável): a aplicação regista login (sucesso, falha, limite),
logout, recuperação, CSRF/origem rejeitados, tenant recusado e permissão negada — sem emails nem palavras-passe tentadas;
os triggers `audit_global_change` registam criação/alteração de estado de contas e tenants e mudança de palavra-passe (sem
valores). O utilizador vê os seus (`GET /me/security-events`); o tenant vê os do seu `tenant_id` com `audit.read`.
**Limites conhecidos.** Sem cadeia de hash/assinatura das entradas, sem exportação nem política de retenção automática (o
expurgo é manual pela conta dona), sem auditoria de leituras nem de MFA/SSO (não existem), `user_preferences` isenta, e o IP vem
de `request.ip()` sem proxy de confiança configurado.

## D-030 Planos, assinaturas e limites no plano de controlo (aceite — fatia 2.2)
**Modelo.** `plan_versions` (revisões de um `plan_code`; `limits` e `entitlements` em `jsonb` validados pela aplicação; preço
`numeric(19,4)`, string na API), `subscriptions` (no máximo uma não cancelada por tenant: índice parcial único) e
`subscription_changes` (histórico append-only: atribuição, upgrade, downgrade, estado). São tabelas **globais** (`PLATFORM_TABLES`):
não têm RLS, por isso toda a leitura filtra pelo `tenant_id` do contexto validado; `subscriptions` entra na auditoria do tenant
(`audit_logs`, lida com `subscription.read`). **Imutabilidade.** Um trigger só deixa editar/apagar uma versão em `DRAFT`; uma
`PUBLISHED` só pode passar a `RETIRED` sem tocar em mais nada, logo preços e limites nunca mudam retroactivamente e uma
assinatura mantém os termos que contratou mesmo depois de novas revisões. **Direitos.** `ACTIVE` concede; `TRIAL` até `trial_end`;
`PAST_DUE` até `grace_end`; `SUSPENDED`/`CANCELLED` não. O limite efectivo de uma métrica é o do plano, e **0** sem assinatura ou
sem direitos (nega por omissão; nunca "ilimitado" por falta de dados); `null` (ilimitado) só em métricas que o suportam (hoje
`members`, que conta memberships ocupadas, não pessoas). **Quota de membros.** A aceitação de convites lê o limite do plano e
continua a verificá-lo sob o lock de membros (duas aceitações concorrentes com uma vaga: só uma entra). **Mudança de plano.**
Serializada por lock consultivo do tenant. Upgrade aplica-se logo; se o consumo exceder os limites do novo plano, a mudança falha
com `409 PLAN_LIMITS_EXCEEDED` (métricas em `details`), excepto com um período de adequação (1–180 dias): o plano muda, nada é
eliminado e o excesso só bloqueia novos consumos (`usage[].blocked`). **Gestão.** Não existe ainda identidade de plataforma
(D-028: nenhuma conta tem `platform.*`), por isso os planos e assinaturas gerem-se por comandos `node ace` (`plan:*`,
`subscription:*`) até à API `/platform/*` (fatia 2.5, `platform.billing.manage`); o tenant só lê (`GET /tenant/subscription`).
**Fora desta fatia.** `UsageCounter` com reserva/libertação (não há consumidor: upload/armazenamento), `SaasBillingRecord` e webhooks
de pagamento (sem fornecedor, decisão de produto pendente), pedido de mudança de plano pelo administrador do tenant, validação dos
códigos de módulos/funcionalidades contra o registo (C03), renovação automática do período, e a ligação do frontend.

## D-031 Registo de módulos: catálogo entregue por código, activação por tenant e acesso efectivo (aceite — fatia 2.3)
**Catálogo.** `modules`, `module_dependencies` e `features` são tabelas globais alimentadas por **manifestos em código**
(`platform/modules/manifests.ts`, `node ace modules:sync`); o tenant nunca fornece manifestos, SQL ou código. A sincronização valida o
conjunto inteiro antes de gravar (códigos, versões, funcionalidades prefixadas pelo módulo, dependências existentes e satisfeitas
por `^ ~ >= > <= < *`, **sem ciclos** — incluindo ciclos por dependência opcional —, `minCoreVersion` ≤ núcleo e o núcleo
`FOUNDATION` sem depender de módulos) e é idempotente; o que sai do código passa a `DEPRECATED` e nunca se apaga. Hoje o código só
declara o módulo `core`: **não se regista um módulo que ainda não existe**; os testes usam um catálogo próprio com as dependências da
especificação (SALES→CORE+CRM+CATALOG, INVENTORY→CATALOG, FINANCE opcional). **Activação.** `tenant_modules` (estado, configuração, `enabled_at`,
último erro) e `tenant_features` (override com motivo e prazo) são tabelas de tenant, auditadas. O núcleo está sempre activo e não tem
linha. `POST /tenant/modules/{code}/enable` exige licença do plano e dependências obrigatórias activas (`409 DEPENDENCIES_MISSING`
com a lista; `withDependencies` activa-as pela ordem certa); passa por `ENABLING` e corre o activador do módulo (código, idempotente);
uma falha deixa `ERROR` (mensagem genérica ao tenant) e repetir retoma sem duplicar; tudo serializado por lock consultivo do tenant.
Desactivar recusa enquanto houver dependentes activos (`409 DEPENDENTS_ENABLED`), devolve as funcionalidades afectadas e **nunca
apaga** tabelas, dados nem histórico. **Acesso efectivo** = tenant operacional (middleware `tenant`) AND licença válida (assinatura que
concede direitos e inclui o módulo; uma funcionalidade vem com o módulo se for `default_enabled`, senão tem de constar do plano) AND
módulo activo AND funcionalidade ligada (`override` dentro do prazo, senão o valor por omissão) AND autorização. Um override a favor
**nunca** ultrapassa a licença (`409 FEATURE_NOT_LICENSED`; e deixa de valer se o plano mudar). A API bloqueia (`middleware.feature`,
`403 FEATURE_NOT_AVAILABLE`, funcionalidade desconhecida nega) — o menu é só conveniência (`GET /context/features`, `modules`/`features`
em `GET /context`). **Fora desta fatia:** validar as listas do plano contra o registo ao publicar (hoje o plano guarda códigos por
validar), configuração por módulo (`configuration` existe mas não tem API), tratamento de processos em curso na desactivação (não
existem processos), estado `DISABLING` (a desactivação é imediata), API de plataforma para o catálogo, e a ligação do frontend.

## D-032 Configurações com precedência declarada, impostos por período e sequências sob lock (aceite — fatia 2.4)
**Configurações.** As *definições* (chave, tipo, valor por omissão, **âmbitos permitidos**) são entregues por código
(`core/settings/domain/setting.ts`); o tenant só guarda *valores* (`setting_values`, um por âmbito: unicidade na base, combinação
filial+módulo = `BRANCH` com `module_code`). Valor efectivo, do menos ao mais específico: omissão < tenant < organização < filial <
módulo < filial+módulo < membership, restringido aos âmbitos que a chave admite — por isso as regras fiscais (`tax.*`) só admitem
tenant e organização e **nunca override pessoal** (`422 SCOPE_NOT_ALLOWED`); um valor guardado fora dos âmbitos permitidos é ignorado.
`GET /settings/effective` mostra valor e nível de origem; repor a herança é apagar o valor do âmbito (o histórico fica na auditoria).
Actualizar um valor existente exige `expectedVersion`. As referências (organização, filial do tipo `BRANCH`, membership) têm de existir
no tenant e a filial na organização indicada. Preferências pessoais: só via `/me/settings/{key}`, no próprio âmbito. Não existe
tabela de definições nem o campo `sensitive` (nenhuma chave actual é sensível; entra com a primeira que o seja).
**Impostos.** `tax_rates` por organização e código, com validade `[valid_from, valid_to]`; a sobreposição é rejeitada **na base**
(trigger com lock consultivo, `409 TAX_RATE_OVERLAP`, também sob concorrência). A taxa, o código e o início são imutáveis (a taxa é
copiada para as linhas emitidas): só nome, categoria, motivo e fim de validade mudam; taxa zero exige motivo de isenção.
**Unidades.** `units_of_measure` com unidades base e derivadas (factor > 0), sem cadeias, mesma dimensão; dimensão, base e factor
imutáveis; conversão com aritmética inteira exacta (6 casas), arredondamento meio-para-cima à precisão do destino, só entre
dimensões compatíveis. **Sequências.** Uma por organização, filial opcional, tipo de documento, série e período (`ALL`/`AAAA`/`AAAA-MM`);
modelo com tokens fechados (`{YYYY} {YY} {MM} {SERIES} {ORG} {BRANCH}`, nunca código do tenant). `SequenceIssuer.issue()` corre **na
transacção do chamador**: `UPDATE … RETURNING` bloqueia a linha, serializa as emissões e devolve números distintos e contíguos; confirmada a
transacção o número nunca se reutiliza (cancelar o documento não o devolve); se anular, volta. Escolhe-se a sequência da filial antes da da
organização e o período mais específico; sem sequência configurada falha (`409 SEQUENCE_NOT_CONFIGURED`) em vez de criar uma. O
próximo número só sobe; a pré-visualização é só renderização. **Auditoria:** as quatro tabelas têm trigger de auditoria; cada emissão
gera uma entrada em `audit_logs` (rasto da alocação, com custo de escrita por emissão que não foi medido).
**Fora desta fatia:** moedas e idiomas como catálogo de referência, criação automática de sequências para um período novo (hoje um
período sem sequência falha), preços com imposto incluído/arredondamento aplicados (só as chaves existem), UI, API de plataforma
e valores por omissão de plataforma geríveis (são o `defaultValue` do código).

## D-015 Filas e workers (adiada)
Redis está presente (cache, limites de taxa). A biblioteca de filas e o processo worker serão escolhidos quando houver
o primeiro job real (outbox, Fase 2). Não se acrescenta um worker vazio.

## Decisões de produto pendentes (spec §11.2 — não bloquear o core)
Preços reais dos planos e quotas; primeiro vertical comercial; países/regimes fiscais; fornecedores de
email/SMS/WhatsApp/pagamento; calendário de férias; alçadas e segregação; política de retenção; RPO/RTO; limites de
integração. Até decisão: parâmetros de demonstração identificados e conectores fiscais/financeiros desactivados.
