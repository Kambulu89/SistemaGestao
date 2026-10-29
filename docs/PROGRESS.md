# Painel de acompanhamento

Estado vivo do desenvolvimento. Actualizado no fim de cada módulo/fatia validada. Critérios de conclusão: `MODULE_COMPLETION.md` (129 critérios de aceitação da especificação, contados só quando há teste automático executado). Lacunas e matriz: `MODULE_AUDIT.md`.

## Estado actual

| Indicador | Valor | Como se mede |
| --- | ---: | --- |
| Critérios de aceitação verificados | 68 / 129 | `MODULE_COMPLETION.md` |
| Critérios parciais | 4 | idem |
| Módulos «Concluído e validado» | 0 | todos têm requisitos por cumprir |
| Testes backend (última corrida completa) | 723 | `npm test` |
| Testes frontend (última corrida completa) | 1073 | `npx ng test --watch=false` |
| Rotas / tabelas de tenant / migrations | 371 / 97 / 33 | `routes.ts`, `createTenantTable`, `database/migrations` |
| Lacunas abertas (registo A-xx) | 6 (1 bloqueada); 1 parcial; 5 resolvidas | `MODULE_AUDIT.md` §4 |

## Fila de execução

| # | Item | Estado | Depende de | Evidência |
| ---: | --- | --- | --- | --- |
| 0 | Auditoria completa (matriz, critérios, lacunas) | **Concluído** | — | `MODULE_AUDIT.md`, `MODULE_COMPLETION.md` |
| 1 | A-01 capacidades → páginas reais · A-02 cancelar o restante · A-03 testes em falta | **Concluído e validado** | — | backend 647 testes, frontend 1024; `capability-redirect.spec`, `procurement.spec`, `invoicing.spec`, `rules.spec` |
| 2 | M09 Tesouraria, contas a receber e a pagar — **fatia 5.1** (obrigações, pagamentos, facturas de fornecedor, crédito) | **Concluída e validada** (módulo: Parcialmente implementado) | 1 | `finance.spec` (15), `finance_domain.spec` (14), `treasury-page.spec`, E2E `e2e49.mjs` (24 verificações); D-054 |
| 2b | M09 fatia 5.2 — conciliação bancária (extractos, correspondências) | **Concluída e validada** (módulo: Parcialmente implementado) | 2 | `reconciliation.spec` (13), `reconciliation_domain.spec` (8), FE `reconciliation.spec` (16), E2E `e2e51` (22 verificações); D-056 |
| 3 | M08 Transferências, inventários físicos e devoluções — **fatia 4.8** | **Concluída e validada** (módulo: Parcialmente implementado) | 2 | `stock_logistics.spec` (16), `logistics_domain.spec`, `logistics-tabs.spec` (15), E2E `e2e50` (33 verificações); D-055 |
| 4 | M02 CRM comercial | Não iniciado | — | — |
| 5 | S02 Notificações | Não iniciado | — | — |
| 6 | S01 Documentos e templates (PDF) | Não iniciado | 5 | — |
| 7 | S04 Relatórios, dashboards, exportação, pesquisa | Não iniciado | 2 | — |
| 8 | S03 Calendário e reservas · S05 Integrações · S06 UI/recuperação | Não iniciado | — | — |
| 9 | M10 · M11 · M12 · M13 · M14 | Não iniciado | 2, 5 | — |
| 10 | Verticais V01–V06 | Não iniciado | núcleo | — |

Estados: Não iniciado · Parcialmente implementado · Implementado sem validação · Em testes · Concluído e validado · Bloqueado.

## Registo de execução

| Data | O quê | Resultado | Commit |
| --- | --- | --- | --- |
| 2026-10-29 | Auditoria: leitura da especificação, manifestos, rotas, migrations e testes; varredura da UI | Matriz de 40 linhas, 12 lacunas, 129 critérios classificados | `87ef271` |
| 2026-10-29 | W1: capacidades → páginas reais (A-01); cancelar o restante (A-02); 7 critérios passam a verificados (A-03) | 60/129 critérios; backend 647, frontend 1024; lint/format/typecheck/build limpos | `4f1a2b0` |
| 2026-10-29 | M09 fatia 5.1: núcleo `core/decimal`, hook `registerInvoiceEffects`, módulo `finance` (migration 30, 10 tabelas), API de 28 rotas, página «Tesouraria»; corrige 500 em contratos e fornecedores com organização inexistente | 65/129 critérios; backend 680, frontend 1042; lint/format/typecheck/build limpos; E2E 24/24 | (este commit) |
| 2026-10-29 | M08 fatia 4.8: migration 31 (8 tabelas), armazéns técnicos, transferências com trânsito, contagens com congelamento, devoluções derivadas do livro, 30 rotas, separadores no inventário; E2E apanhou um erro de página ao apagar o rascunho aberto (corrigido e coberto) | 68/129 critérios; backend 702, frontend 1057; lint/format/typecheck/build limpos; migrations 32 subidas e descidas | `669b1dd` |
| 2026-10-29 | M09 fatia 5.2: migration 32 (3 tabelas), extractos importados de forma idempotente, estado derivado das correspondências, sugestões, confirmar/desfazer com bloqueios, 10 rotas, separador «Conciliação»; corrige 500 em `isIsoDate` com meses fora de limites; E2E mostrou colunas de data vazias (corrigido) | 68/129 critérios (sem critério novo: o M09.2 continua parcial); backend 723, frontend 1073; lint/format/typecheck/build limpos; migrations 33 subidas e descidas | _a preencher no commit_ |

## Como retomar

1. Ambiente: `pg_ctlcluster 16 main start`, `redis-server --daemonize yes`, Node 24 no `PATH`.
2. Backend: `cd backend && npm run migrate && npm test`. Frontend: `npm ci && npx ng test --watch=false`.
3. Seguir a «Fila de execução» pela ordem; cada item termina com lint, format, typecheck, testes, build, migrations up/down, E2E em browser quando há UI, actualização destes três documentos e um commit.
4. Decisões de desenho ficam em `docs/decisions.md` (próxima: D-057).
