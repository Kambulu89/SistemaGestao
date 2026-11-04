# Decisões

## D-001 Recomeço sobre AdonisJS 7, sem Redis (aceite)

O projecto anterior (AdonisJS 6, Redis) fica no histórico Git (`2ead09c` na `main`). Escolha do utilizador: construir sobre
a estrutura nova (AdonisJS 7.6, Angular 22, PostgreSQL 16), reutilizando desenhos do anterior quando poupam trabalho.

## D-002 Isolamento por RLS forçada com duas contas PostgreSQL (aceite)

Os filtros nos repositórios não bastam: um esquecimento expõe dados de outra empresa. Cada tabela de tenant tem RLS
`FORCE` e a aplicação usa uma conta sem `BYPASSRLS`; o tenant é definido por transacção. Testado em
`tenancy.spec.ts` (dois tenants, escrita cruzada recusada) e garantido para novas tabelas por `schema_conformance.spec.ts`.

## D-003 Sessão em cookie HttpOnly + CSRF em vez de tokens Bearer (aceite)

O kit API do AdonisJS usava tokens de acesso sem validade e um registo público. Um token em JavaScript fica exposto a XSS;
o cookie HttpOnly não. Sessões opacas em PostgreSQL permitem revogar e listar sessões. Removidos `@adonisjs/auth`,
`@adonisjs/session` e `@tuyau/core`.

## D-004 SQL parametrizado em vez de modelos Lucid (aceite)

O acesso a dados de tenant tem de correr dentro da transacção com `app.tenant_id`; repositórios com SQL explícito tornam
isso visível e evitam consultas fora do âmbito. A geração automática de esquema do Lucid foi desligada.
