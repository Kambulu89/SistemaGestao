# Painel de acompanhamento

Estado vivo do desenvolvimento. Actualizado no fim de cada módulo/fatia validada. Critérios de conclusão: `MODULE_COMPLETION.md` (129 critérios de aceitação da especificação, contados só quando há teste automático executado). Lacunas e matriz: `MODULE_AUDIT.md`.

## Estado actual

| Indicador | Valor | Como se mede |
| --- | ---: | --- |
| Critérios de aceitação verificados | 60 / 129 | `MODULE_COMPLETION.md` |
| Critérios parciais | 4 | idem |
| Módulos «Concluído e validado» | 0 | todos têm requisitos por cumprir |
| Testes backend (última corrida completa) | 647 | `npm test` |
| Testes frontend (última corrida completa) | 1024 | `npx ng test --watch=false` |
| Rotas / tabelas de tenant / migrations | 304 / 76 / 30 | `routes.ts`, `createTenantTable`, `database/migrations` |
| Lacunas abertas (registo A-xx) | 9 (1 bloqueada); 3 resolvidas | `MODULE_AUDIT.md` §4 |

## Fila de execução

| # | Item | Estado | Depende de | Evidência |
| ---: | --- | --- | --- | --- |
| 0 | Auditoria completa (matriz, critérios, lacunas) | **Concluído** | — | `MODULE_AUDIT.md`, `MODULE_COMPLETION.md` |
| 1 | A-01 capacidades → páginas reais · A-02 cancelar o restante · A-03 testes em falta | **Concluído e validado** | — | backend 647 testes, frontend 1024; `capability-redirect.spec`, `procurement.spec`, `invoicing.spec`, `rules.spec` |
| 2 | M09 Tesouraria, contas a receber e a pagar | Não iniciado | 1 | — |
| 3 | M08 Transferências, inventários físicos e devoluções | Não iniciado | 2 (devolução com nota de crédito) | — |
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
| 2026-10-29 | W1: capacidades → páginas reais (A-01); cancelar o restante (A-02); 7 critérios passam a verificados (A-03) | 60/129 critérios; backend 647, frontend 1024; lint/format/typecheck/build limpos | (este commit) |

## Como retomar

1. Ambiente: `pg_ctlcluster 16 main start`, `redis-server --daemonize yes`, Node 24 no `PATH`.
2. Backend: `cd backend && npm run migrate && npm test`. Frontend: `npm ci && npx ng test --watch=false`.
3. Seguir a «Fila de execução» pela ordem; cada item termina com lint, format, typecheck, testes, build, migrations up/down, E2E em browser quando há UI, actualização destes três documentos e um commit.
4. Decisões de desenho ficam em `docs/decisions.md` (próxima: D-054).
