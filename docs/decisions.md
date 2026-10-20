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

## D-013 Sessão e selector de tenant (proposta — implementar na Fase 1)
Sessão opaca em cookie `HttpOnly`/`Secure`/`SameSite` com protecção CSRF; sem credenciais em `localStorage`/
`sessionStorage`. O tenant viaja como **selector explícito** (domínio verificado ou cabeçalho) e é sempre validado
contra a sessão e a membership activa; o frontend pode manter `/t/:slug` na URL. Substitui o `sessionStorage` do mock.

## D-014 Nomenclatura de permissões (aberta — decidir antes da Fase 1.5)
O frontend usa `<módulo>.read|manage` e `entities.<chave>.<op>`; a spec usa `<recurso>.<acção>` (ex.:
`invoice.approve`, `dynamic.<code>.read`). **Proposta:** adoptar a nomenclatura da spec no backend e mapear no
frontend por um único ponto (adaptador do contexto), mantendo as chaves do mock só até serem substituídas.

## D-015 Filas e workers (adiada)
Redis está presente (cache, limites de taxa). A biblioteca de filas e o processo worker serão escolhidos quando houver
o primeiro job real (outbox, Fase 2). Não se acrescenta um worker vazio.

## Decisões de produto pendentes (spec §11.2 — não bloquear o core)
Preços reais dos planos e quotas; primeiro vertical comercial; países/regimes fiscais; fornecedores de
email/SMS/WhatsApp/pagamento; calendário de férias; alçadas e segregação; política de retenção; RPO/RTO; limites de
integração. Até decisão: parâmetros de demonstração identificados e conectores fiscais/financeiros desactivados.
