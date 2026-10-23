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

## D-033 Administração da plataforma: concessões explícitas, rotas sem tenant e provisionamento idempotente (aceite — fatia 2.5)
**Identidade de plataforma.** Não existe um "super-utilizador": uma conta ganha `platform.tenant.manage` ou `platform.billing.manage` por
**concessão explícita** (`platform_grants`, tabela global: motivo obrigatório, prazo opcional, nunca se apaga — revogar preenche
`revoked_at`; um trigger só admite essa transição). As concessões criam-se e revogam-se por comando de operação
(`node ace platform:grant|platform:revoke|platform:list`), nunca por API, para que ninguém se promova a si próprio; cada alteração fica em
`security_events` (`PLATFORM_GRANT_CHANGED`, severidade HIGH). **Política própria.** As rotas `/api/v1/platform/*` usam sessão + CSRF
(`auth`) e o middleware `platform` — **sem** `tenant`, sem selector. Sem concessão em vigor (não revogada, não expirada) → `403
PLATFORM_PERMISSION_DENIED` e evento `PLATFORM_ACCESS_DENIED`; sem sessão → 401. Um papel de administrador de tenant não dá nenhuma
permissão de plataforma e uma concessão de plataforma **não dá acesso a dados de nenhum tenant** (sem membership o selector é recusado
como em qualquer utilizador). **Âmbito.** `platform.tenant.manage`: listar tenants, provisionar, ver o estado do provisionamento,
suspender e reactivar (com motivo). `platform.billing.manage`: planos (criar revisão, publicar, retirar) e assinaturas de um tenant
(ver, atribuir, mudar de plano com adequação, mudar de estado). As respostas de plataforma mostram estado, plano e contagens, nunca dados de
negócio. Cada mutação regista `PLATFORM_ACTION` (quem, acção, tenant, motivo). **Provisionamento.** `POST /platform/tenants` cria o tenant em
`PROVISIONING`, atribui o plano, garante o papel `tenant_admin` e a organização inicial, convida o administrador por email — o formulário não
pede palavra-passe; o convite leva o papel — e só então activa. Cada passo é idempotente (tenant por código, assinatura do mesmo plano,
papel, "já há organização", convite pendente ou já membro contam como feito): repetir o pedido ou retomar após uma falha não duplica a
organização nem o convite, e uma falha deixa `PROVISIONING`. `GET /platform/tenants/{id}` mostra os passos feitos e em falta. Um tenant que
já não está em `PROVISIONING`/`ACTIVE` não se provisiona de novo. **Fora desta fatia:** MFA/reautenticação para acções de plataforma (o MFA não
existe: D-019), suporte excepcional com acesso limitado no tempo a dados de um tenant (concessão própria, justificada e auditada — não
implementado, por isso o suporte **não** tem acesso), fecho de tenant com exportação/retenção, `ProvisioningStep` persistido (o estado deriva das
próprias entidades), domínio personalizado no provisionamento, e a UI de plataforma.

## D-034 Frontend da Fase 2 ligado à API: sem direitos provisórios, plataforma real e convenção de nomes (aceite)
**Fim dos direitos provisórios.** `provisional-entitlements.ts` foi removido. O contexto do tenant vem do servidor: `GET /context` devolve os
módulos do registo **activos e licenciados** e as funcionalidades efectivas (licença AND módulo activo AND funcionalidade ligada); quem tem
`subscription.read` vê também o plano e o consumo (`GET /tenant/subscription`). Sem módulos de negócio no registo, nenhum módulo de negócio
fica acessível no frontend: é o estado real (D-031), não um defeito. **Convenção de nomes (código ↔ registo).** O módulo do registo é o
primeiro segmento do código do manifesto do frontend (`crm.customers` pertence ao módulo `crm`) e a funcionalidade `import` desse manifesto
chama-se `crm.customers.import` no registo (que exige o prefixo do módulo). Um módulo novo do backend só precisa de seguir este nome. **Plataforma.**
`GET /platform/me` devolve as concessões `platform.*` da conta (a ligação do frontend não faz parte do `core` de autenticação, que não pode
depender da plataforma); o frontend traduz-as para as suas chaves (`mapPlatformPermissions`) só para navegação — o servidor volta a verificar
cada rota. Um falhanço de `platform/me` trata a conta como não sendo da plataforma. Os pedidos `/platform/*` nunca levam `X-Tenant-Id`. A área de
plataforma tem: painel (contagens reais e indicadores do catálogo do código), tenants (provisionar, ver passos, suspender/reactivar com
motivo), planos (criar revisão, publicar, retirar) e subscrições (ver plano/consumo/histórico, atribuir, mudar de plano com adequação, mudar estado).
A página «Configurações da plataforma» (sem backend) foi removida. **Tenant.** Novas páginas: Plano (versão contratada, consumo, bloqueios,
adequação, histórico) e Módulos (registo real: licença, dependências em falta, activar com dependências, desactivar sem apagar dados,
overrides de funcionalidades); «Configurações» passou a ter Preferências (valor efectivo e origem, preferência pessoal, repor herança),
Impostos, Unidades (com conversão) e Sequências (com pré-visualização sem consumir número). Preços, taxas e números atravessam o
frontend como **strings**. Um diálogo cujo estado de carga fecha o `<dialog>` nativo emite `closed`: o estado de carga não pode controlar `open`.
**Fora desta fatia:** configurações por filial/módulo na interface (a API suporta), ligação a `Party`/papéis/políticas (Fase 1, por fazer), UI de
auditoria, e activação de módulos de negócio reais (não existem).

## D-035 Metadados e entidades dinâmicas: versões imutáveis, JSONB validado e permissões `dynamic.*` com ABAC por entidade (aceite — fatia 3.1)
**Modelo.** Módulo `dynamic/metadata` (primeiro do grupo `dynamic`, alias `#dynamic/*`). Tabelas de tenant: `entity_definitions`,
`entity_schema_versions`, `field_definitions`, `dynamic_records` e `dynamic_unique_values`; nunca se criam tabelas ou colunas por cliente. Os
valores ficam em JSONB (`data`), validados no servidor contra a **versão exacta** do esquema com que o registo foi gravado; os valores de campos
**sensíveis** vivem à parte (`sensitive_data`), redigidos na auditoria, fora da pesquisa e sem unicidade. **Versões.** Cada entidade tem no máximo um
rascunho (índice parcial) e revisões publicadas **imutáveis**: um trigger recusa UPDATE/DELETE da versão publicada e dos seus campos a qualquer
conta (excepto a dona, com o interruptor de retenção da auditoria, usado só na limpeza de tenants de teste). Publicar nunca apaga: o campo
retirado e a opção retirada ficam **arquivados** (valores antigos legíveis, sem novas escritas, código nunca reutilizável). Sem mecanismo de
migração, uma alteração que invalidaria dados existentes **bloqueia a publicação** (409 `INCOMPATIBLE_SCHEMA` com um detalhe por campo): mudar o
tipo ou o destino de uma referência, mudar a sensibilidade, tornar obrigatório sem valor por omissão, tornar único um campo publicado, novo campo
obrigatório sem omissão, restringir limites (comprimento, mínimo/máximo, precisão/escala, padrão, selecções). A pré-visualização
(`publish-preview`) lista o mesmo e quantos registos ficam em versões anteriores. Um registo criado usa a revisão publicada; ao ser alterado passa
a ela (validação completa, valores de campos arquivados preservados). **Tipos de campo.** Implementados: TEXT, TEXTAREA, NUMBER, DECIMAL (string
na API, precisão/escala declaradas, canónico com a escala, BigInt — nunca float), BOOLEAN, DATE, DATETIME (ISO com fuso, normalizado a UTC),
EMAIL, PHONE, URL (só http/https, sem pedidos remotos), SELECT, RADIO, MULTISELECT, ENTITY_REFERENCE (mesmo tenant, entidade certa, não
arquivada) e USER_REFERENCE (membership activa). Os restantes da matriz (CURRENCY, CHECKBOX, FILE, IMAGE, FORMULA, LOOKUP, AUTONUMBER) são
recusados com `FIELD_TYPE_NOT_SUPPORTED` até terem a sua fatia. Padrões de texto: sem grupos repetidos sem limite, retrovisores nem asserções
(evita retrocesso exponencial) e com o comprimento do valor limitado. Chaves de `validation` desconhecidas são recusadas. **Unicidade.**
`validation.unique` mantém `dynamic_unique_values` na mesma transacção do registo, com índice único da base `(tenant, entidade, campo,
valor normalizado)`: dois pedidos concorrentes com o mesmo valor não passam (409 `UNIQUE_VALUE_TAKEN`); arquivar o registo liberta o valor; um
campo que deixa de ser único liberta os seus valores na publicação. **Permissões (divergência assinalada da especificação).** A especificação
indica `dynamic.{código}.read|create|update|archive`. O catálogo de permissões é global e `<recurso>.<acção>` (D-014), por isso permissões
com o código de entidades de cada tenant não cabem nele sem expor esses códigos entre tenants. Adoptou-se `dynamic.read|create|update|archive`
mais `dynamic.sensitive` (campos sensíveis) e `dynamic.all` (registos de todos os responsáveis), e `entity.read|design|publish` para a definição;
a restrição **por entidade** faz-se com políticas ABAC sobre o atributo `resource.entity` (o middleware `can` aceita `resource` mapeado a
parâmetros de rota, por isso a política vale já à porta). **A especificação deve ser corrigida** (ou, se se preferir, reabrir D-014).
**Propriedade.** `ownership_mode`: TENANT; UNIT (o registo tem unidade, validada e dentro do âmbito do actor; as listas só mostram as unidades do
âmbito); OWNER (o responsável é o autor; os outros só vêem com `dynamic.all`, senão 404). O modo não muda depois de publicada a entidade.
**Fora desta fatia:** formulários (C11), regras e fórmulas (C12), máquinas de estados (C13: o registo ainda não tem `state_code`), workflows
(C14), automações (C15), `EntityExtension` (precisa do `ResourceRegistry`, sem recursos ainda), anexos, migração de dados entre versões,
UI (Entity Designer e listagens continuam mock no frontend), pesquisa indexada (usa `LIKE` em texto não sensível; sem índice trigram),
exportações e outbox (inexistente), grants limitados a uma unidade sem âmbito de acesso (como nos restantes módulos, a porta usa `can`).

## D-036 Frontend de C10 ligado à API: tradução num só ponto, tipos do servidor e nada simulado (aceite — fatia 3.2)
**Gateways HTTP.** `EntityDefinitionGateway` e `EntityRecordsGateway` passam a falar com `/entity-definitions` e `/dynamic/{código}/records`
(`core/dynamic/http`, `provideDynamicBackend()`); os duplos em memória (`core/mock`) ficam só para os testes. O `CustomFieldGateway` deixou de
ter dados simulados: `UnavailableCustomFieldGateway` devolve lista vazia e recusa escritas (501) — os campos personalizados estendem entidades
nativas (`EntityExtension`), que dependem de módulos de negócio que não existem. **Tradução (`dynamic-mapper.ts`, o único ponto).** Entidades
`ordem-servico` ⇄ `ordem_servico`; campos `dataCompra` ⇄ `data_compra`; um código do servidor que não volta a si próprio (`a__b`, `a_1`) não tem chave
na interface e essa entidade fica de fora da lista (as outras carregam). Tipos: os 15 do servidor; **decimais** são texto na API e número na
interface, com precisão fixa de 15 dígitos e recusa explícita de qualquer valor que não caiba exactamente num número (nunca se corrompe em silêncio).
Estado, fluxos, formulários e regras entre campos não existem no servidor (C11–C13): vêm vazios. O que o servidor valida e a interface não edita
(limites de datas, precisão decimal, mínimo/máximo de selecções) viaja em `FieldBase.serverValidation` e volta ao gravar. O que o servidor não suporta
(tipos moeda/ficheiro/fórmula…, condições de visibilidade, regras condicionais, comparações entre campos, padrões sem distinção de maiúsculas) é
**recusado com a lista de problemas** (422 no formato do designer), nunca descartado. Opções inactivas saem do rascunho e o servidor arquiva-as ao
publicar. **Designer.** `DESIGNER_FIELD_TYPES` limita os tipos escolhíveis aos que o servidor guarda (`SERVER_FIELD_TYPES`); os restantes aparecem como
«em preparação». O código da entidade e o nome no plural/ícone, a descrição, a ajuda e os indicadores pesquisável/filtrável/ordenável do campo são
guardados no servidor (`presentation`, migration 14); `EntityDefinition.rowVersion` leva o controlo de concorrência da entidade. **Servidor.**
A listagem passou a devolver `meta.total` e a aceitar `sort` (`createdAt|updatedAt|<campo>:asc|desc`, números e decimais pelo valor) e `filter.<campo>`
(igualdade, até 10); campos sensíveis ou escondidos por regra de campo não ordenam, filtram nem se pesquisam (`q` fica indisponível para quem tenha um
campo pesquisável escondido); `DELETE /entity-definitions/{id}` remove uma entidade nunca publicada; a saída indica `referenceEntityCode`; o histórico
(`/audit-logs`) passa a incluir as tabelas de C10 (`entity.read` / `dynamic.read` + `audit.read`). **Acesso.** As páginas do Core Dinâmico
(`/t/:slug/entities`) já não dependem de um módulo contratável: usam `configuration.forms.read|manage|publish`, traduzidas de `entity.read|design|publish`;
os registos usam directamente `dynamic.*`. As operações sem equivalente no servidor (exportar, aprovar, transitar) apontam para permissões nunca
concedidas. **Fora desta fatia:** modo de propriedade UNIT/OWNER no formulário (o designer cria entidades TENANT; as UNIT exigem escolher a unidade),
transições de estado, campos personalizados de entidades nativas, histórico de versões anteriores à publicada, listas de referência paginadas, nomes
de autor do histórico sem `member.read`, e a UI de políticas por entidade (ABAC) — continua por API.

## D-037 Fórmulas e regras no servidor: gramática restrita, AST, gancho por registo (aceite — fatia 3.3)
**Fórmulas.** O campo `FORMULA` guarda em `validation` a expressão, a escala, a AST e as dependências. Gramática: números, campos, `+ - * /`, parênteses e `round/min/max/abs`;
limites de 500 caracteres, 100 nós e profundidade 20; nunca se executa SQL, JavaScript nem código do tenant. Cálculo em ponto fixo (BigInt, escala interna 12): campo nulo,
divisão por zero ou resultado com mais de 19 dígitos dão **vazio**, não erro. O resultado é texto decimal, só de leitura, não obrigatório e sem valor por omissão; calcula-se
no servidor em ordem topológica no fim da validação do registo, de modo que o cliente nunca é fonte do valor. Ciclos, referências a campos inexistentes, arquivados ou não numéricos
e fórmulas sobre campos sensíveis num campo não sensível são recusados ao gravar o rascunho e ao publicar. Filtra e ordena como DECIMAL.
**Regras.** Módulo `app/dynamic/rules` (rascunho → publicada → desactivada; um rascunho e uma publicada por (entidade, código); revisões; as publicadas são imutáveis por trigger, só
passam a desactivadas). Gatilho único `VALIDATE`, acção única `BLOCK` com mensagem de negócio (e campo opcional). A condição reutiliza a AST do motor de permissões; variáveis: campos do
registo, `subject.*` e `env.*`. Prioridade, vigência e simulação sem efeitos. Cada FAIL/ERROR fica em `rule_evaluations` (append-only, hash da entrada, transacção separada para
sobreviver à escrita recusada); PASS não se regista. Falha de avaliação **nega** a escrita (fail-closed).
**Ligação.** `metadata` não importa `rules`: expõe `registerRecordRules`, chamado pelo preload `start/dynamic.ts`; se ninguém registar, escrever registos falha em vez de saltar as regras.
**Limites:** uma regra que referencia um campo entretanto arquivado deixa de corresponder (a publicação verifica as referências, o arquivamento posterior não); sem BEFORE/AFTER_COMMIT nem
outras acções; LOOKUP e AUTONUMBER por fazer; ler regras e avaliações no histórico exige `rule.read` e `audit.read`; a UI de regras é a fatia 3.4.

## D-038 Editor de regras: construtor limitado, o resto preservado (aceite — fatia 3.4)
A página de regras de uma entidade (`/regras`) usa só a API de D-037; não há regras locais nem simuladas. O **construtor** representa o caso comum — comparações (`=, ≠, >, ≥, <, ≤`, preenchido, vazio)
sobre campos do registo, ligadas por «e» ou «ou», sem aninhamento — e converte-o para a AST do servidor (`rule-condition.ts`, num só ponto, com testes de ida e volta). Valores: decimais e fórmulas
como **texto**, números como número, booleanos `true/false`; campos sensíveis, arquivados e multi-selecção não se oferecem (o servidor também os recusa). Uma condição fora desse subconjunto (aninhada,
`subject.*`, `env.*`, `in`) **não se perde**: mostra-se como JSON e grava-se igual a não ser que a pessoa a refaça. Só se edita um rascunho; uma publicada ou desactivada muda por **nova revisão**
(a que está em vigor mantém-se até a nova ser publicada). A simulação pede só os campos que a condição lê. As avaliações listam apenas FAIL/ERROR (as últimas 50), como regista o servidor.
Permissões: `rule.read` → `configuration.rules.read`; `rule.manage` → também `configuration.rules.manage` (conveniência de navegação; o servidor decide). **Fora desta fatia:** condições aninhadas e sobre o
utilizador/tempo, eliminar rascunhos, comparar revisões, filtros por estado, e o tipo LOOKUP (fatia 3.5).

## D-039 Valores relacionados (LOOKUP): leitura em tempo real, nada copiado (aceite — fatia 3.5)
A spec pede declarar «live ou snapshot». Escolheu-se **live**: o valor relacionado **não se guarda** no registo; lê-se do registo de origem em cada resposta. Assim a autorização do destino (RBAC + modo OWNER + ABAC +
regras de campo + `dynamic.sensitive`) aplica-se **a cada leitura** e o valor nunca sobrevive a uma mudança de permissões nem fica desactualizado; a contrapartida é não se poder pesquisar, filtrar, ordenar nem usar em regras
ou fórmulas (o servidor recusa-o). Definição: `{relationField, sourceField, onMissing}` em `validation`; o servidor deriva `sourceType`/`scale` (a interface precisa deles para formatar). Segue a versão **em vigor** da entidade,
pelo que os registos de versões anteriores também mostram o valor. Sem cadeias (origem não pode ser outro lookup), tipos escalares apenas, e uma origem sensível exige um valor relacionado sensível. Quem não pode ler o destino vê `null`:
nem a existência nem o conteúdo se revelam (como o 404 de IDs alheios). `onMissing: error` valida apenas a presença da relação ao escrever (a existência já era validada pela referência). **Limites:** leitura N+1 por registo de origem
distinto (sem cache entre pedidos); retirar a origem do destino deixa o valor vazio sem avisar quem a usa; `snapshot` por fazer; a aplicação da permissão faz-se com os mesmos `AccessControl` e ports de D-035.

## D-040 Formulários: layout em JSON validado, ligações por código, nada duplicado (aceite — fatia 3.6)
`form_definitions` guarda o layout como JSON validado pelo servidor (secções e ligações a campos **por código**) em vez de tabelas `FormSection`/`FormFieldBinding` separadas: o formulário nunca duplica a definição de um campo
e é versionado e imutável como um todo (a spec pede um layout json e a imutabilidade da revisão publicada). Condições: as da interface (`eq/neq/gt/gte/lt/lte`, `in/nin`, `empty/notEmpty`, `and/or/not`) com códigos de campo,
só sobre campos activos **não sensíveis**; nunca código. **Desvios assinalados à especificação:** largura da ligação `span` 1–3 e secção `columns` 1–3 (a spec indica `width` 1–12); `FormSubmission` não existe (o CRUD escreve directamente na
entidade, como a spec prevê); a política «preservar ou limpar» de valores escondidos não existe (o cliente não envia o que está escondido); `FormFieldBinding.widget` e itens em grupo ficam por fazer; os formulários não ligam a uma versão
específica da entidade mas à publicada em vigor, e a publicação regista a revisão verificada. **Regras:** publicar volta a verificar contra os campos em vigor; escrever num formulário exige `form.design`, publicar/retirar `form.publish`, ler `form.read`;
quem lê os registos vê os publicados (`/dynamic/{entity}/forms`) com `issues` — o cliente ignora os que têm problemas (entidade mudou) e usa o formulário gerado. Um formulário **só restringe**: o servidor valida e autoriza os registos como sempre
(campo escondido no pedido continua sujeito a `dynamic.sensitive`, validação e regras). O renderer passou a aplicar a configuração do formulário (`applyFormConfiguration`), que existia mas não era usada. **Limites:** um formulário só de criação pode
não incluir campos opcionais (ficam por preencher); o Form Builder visual e a vista móvel/papéis simulados são a fatia 3.7.

## D-041 Form Builder: o estado do editor é o layout do servidor (aceite — fatia 3.7)
O builder edita directamente as secções que o servidor guarda (códigos de campo, condições declarativas), com operações puras e imutáveis (`form-layout.ts`) testadas à parte: nada se converte de e para um modelo paralelo, pelo que o que se vê é o que se grava.
**Condições:** o construtor representa comparações ligadas por «e»/«ou» (números como número, booleanos, texto); `in/nin`, `not` e aninhamento mostram-se descritos e **preservam-se** até serem refeitos. Só campos não sensíveis (como no servidor).
**Arrastar e largar** usa a API nativa do navegador (sem `@angular/cdk`, que exigiria uma dependência nova e ADR); subir/descer por botões garante o uso por teclado. **Pré-visualização:** o mesmo renderer dos registos, alimentado pelo layout em edição
(`formFromDto`), por modo; a «largura de telemóvel» limita o contentor mas não reproduz os pontos de quebra. **Fluxo:** guardar rascunho ≠ verificar ≠ publicar; «verificar» e «publicar» guardam primeiro (um servidor que recusa mostra os problemas
com o caminho completo). **Permissões:** `form.read|design|publish` → `configuration.form-layouts.*` (navegação; o servidor decide). **Limites:** sem teste com papéis simulados (spec C11), sem grupos, valores por omissão por formulário nem política de
valores escondidos; um formulário publicado nunca se edita (nova revisão).

## D-042 Máquinas de estados: estado à parte, transição atómica, outbox sem worker (aceite — fatia 3.8)
**Estado fora do registo.** O estado vive em `record_states` (com a sua `version`) e não em `dynamic_records`: o módulo de estados não escreve nas tabelas dos registos (regra de módulos) e o PATCH genérico **não consegue** alterar o estado (não existe campo `status`). O módulo de metadados
chama uma porta (`RecordStates`, registada em `start/dynamic.ts`, falha fechada) para dar o estado inicial na transacção da criação, recusar alterações em estados fechados (`editable: false`) e juntar `state` às respostas. **Uma máquina em vigor por entidade**; estados e transições em JSON validado
(como D-040). **Transição:** bloqueia a linha do estado, valida `expectedVersion`, lê os dados **actuais** pelo módulo de metadados (só o que a pessoa vê; uma guarda sobre campos escondidos falha fechada), exige `dynamic.transition` (ABAC com `resource.state`) mais a permissão da transição (só códigos do catálogo: o tenant não inventa permissões),
avalia a guarda (condição declarativa, nunca código) e escreve estado + histórico + evento na mesma transacção; transição inexistente a partir do estado → 409 `TRANSITION_NOT_AVAILABLE`, dois comandos concorrentes → só um executa. Registo inexistente ou alheio → 404 antes de qualquer consulta de estado.
**Revisões:** um registo segue a máquina em vigor se o seu estado existir nela; publicar uma revisão que remova um estado **em uso** é recusado (a migração de registos em curso exige mapeamento explícito — não existe). Registos anteriores à máquina ficam sem estado.
**Outbox:** nasce `outbox_events` (core) e o evento `dynamic.record.state_changed` escreve-se com a alteração; **não há worker nem inbox**: ficam `PENDING` até haver o primeiro consumidor real (D-015) — a garantia entregue é a atomicidade, não a publicação.
**Categorias:** `INITIAL/ACTIVE/FINAL/CANCELLED` definem a edição por omissão; nomes de estado nunca produzem efeitos de negócio (faturar, movimentar stock…), que são comandos próprios. **Limites:** sem designer visual (fatia 3.9), sem `action_code`, a listagem não mostra o estado.

## D-043 Designer de máquinas de estados: o modelo do servidor, o mapa como verificação (aceite — fatia 3.9)
O designer edita directamente os estados e as transições que o servidor guarda, com operações puras e imutáveis (`state-machine-model.ts`): remover um estado ajusta as transições dependentes (e avisa), mudar um código acompanha as referências, e «tornar inicial» garante um só estado inicial. Os códigos gerados acompanham o rótulo
enquanto forem gerados (`estado*`/`transicao*` ou iguais ao `slug` do rótulo); um código escolhido à mão nunca se mexe. **Guardas:** o construtor reutiliza a gramática e o módulo das regras (D-038), com preservação das condições avançadas; só campos não sensíveis (o servidor também recusa). **Mapa:** mostra as saídas de cada estado
e calcula a alcançabilidade com o mesmo critério do servidor (feedback imediato), mas a autoridade é a verificação do servidor antes de publicar. O que o servidor impede continua impedido: publicar uma revisão que retire um estado em uso por registos (`STATE_IN_USE`) e qualquer alteração a uma máquina publicada (nova revisão). **Limites:** sem diagrama gráfico (o mapa é textual), sem reordenação por arrastar, permissão adicional em texto livre.

## D-015 Filas e workers (adiada)
Redis está presente (cache, limites de taxa). A biblioteca de filas e o processo worker serão escolhidos quando houver
o primeiro job real (outbox, Fase 2). Não se acrescenta um worker vazio.

## Decisões de produto pendentes (spec §11.2 — não bloquear o core)
Preços reais dos planos e quotas; primeiro vertical comercial; países/regimes fiscais; fornecedores de
email/SMS/WhatsApp/pagamento; calendário de férias; alçadas e segregação; política de retenção; RPO/RTO; limites de
integração. Até decisão: parâmetros de demonstração identificados e conectores fiscais/financeiros desactivados.
