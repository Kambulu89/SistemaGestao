# Relatório — Prompt 06 (contabilidade)

Estado: **6.1, 6.2 e 6.3 implementados e verificados** no branch `claude/pensive-clarke-5gm075`. Os blocos 6.4 a 6.10
dependem desta fundação e ficam para os blocos seguintes. Decisões D-014 e D-015.

Nada aqui alega conformidade com o PGC angolano, a AGT ou o SAF-T (AO): o plano é definido pela empresa e a
validação normativa (versão do PGC, SAF-T, critérios dos mapas) continua pendente antes de qualquer alegação fiscal.

## Matriz AS-IS / TO-BE

| Bloco                   | AS-IS (fim do Prompt 05)                        | TO-BE                                                                                                                                                                                                                                                         | Estado     |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 6.1 Plano de contas     | Só séries `JOURNAL`, câmbios e centros de custo | Planos por entidade legal (um activo), contas em árvore com prefixo, natureza, saldo normal, movimentável, exigências de centro de custo/terceiro, linha das demonstrações; exercícios e períodos OPEN/CLOSED; diários                                        | Feito      |
| 6.2 Lançamentos         | Nada                                            | Cabeçalho completo (entidade, exercício, período, diário, datas, referência, moeda/câmbio, origem, estado, anexos) e linhas; validação de partidas dobradas; fluxo com segregação; imutável; estorno; idempotência                                            | Feito      |
| 6.3 Posting engine      | —                                               | Regras por entidade, origem, evento e vigência (sem sobreposição), contas configuradas pela empresa, chaves de montante; `postAccountingEvent` na transacção de quem chama; idempotência; registo de eventos com mensagem de erro; reprocessamento; simulação | Feito      |
| 6.4 Abertura/razão      | —                                               | Importação equilibrada de saldos (período de abertura já existe), razão, balancete sem duplicar contas-pai                                                                                                                                                    | Próximo    |
| 6.5 Analítica           | Centros de custo por linha                      | Dimensões, imputações e repartições a 100%                                                                                                                                                                                                                    | Por fazer  |
| 6.6 Activos fixos       | —                                               | Ficha, depreciação, abate, contabilização                                                                                                                                                                                                                     | Por fazer  |
| 6.7 Regularizações      | Período de regularizações existe                | Provisões, acréscimos, diferimentos, recorrências, diferenças cambiais                                                                                                                                                                                        | Por fazer  |
| 6.8 Demonstrações       | `statementLine` por conta                       | Mapas versionados, PDF/Excel, conferência com o balancete                                                                                                                                                                                                     | Por fazer  |
| 6.9 Fiscalidade (SAF-T) | —                                               | Só com a especificação oficial verificada                                                                                                                                                                                                                     | Bloqueado* |
| 6.10 Fecho              | Fecho/reabertura de períodos auditados          | Checklist, encerramento do exercício, concorrência                                                                                                                                                                                                            | Parcial    |

\* Bloqueado pela validação normativa, não por código.

## Endpoints (todos com `auth`, `tenant`, `can()` e a funcionalidade `accounting`)

- 6.3: `GET|POST /accounting/posting-rules`, `GET|PATCH …/:id` (`accounting.read` / `accounting.settings`);
  `GET /accounting/posting-events`, `GET …/:id`, `POST …/simulate` (`accounting.read`); `POST /accounting/posting-events`,
  `POST …/:id/retry` (`accounting.post`). Contrato interno: `postAccountingEvent(scope, evento)` em
  `#modules/accounting/index`.

- `GET|POST /accounting/{charts,accounts,fiscal-years,journals}`, `GET|PATCH …/:id` (`accounting.read` / `accounting.settings`)
- `POST /accounting/periods/:id/close` (`accounting.close`), `…/reopen` (`accounting.reopen`, motivo obrigatório)
- `GET|POST /accounting/entries`, `GET|PATCH|DELETE /accounting/entries/:id`, `POST …/submit` (`accounting.create`)
- `POST …/approve`, `…/reject` (`accounting.approve`), `…/post` (`accounting.post`), `…/reverse` (`accounting.reverse`)

## Ecrãs

Contabilidade → Lançamentos (lista com filtros e exportação; editor com equilíbrio ao escrever, acções por estado e
permissão, anexos e histórico), Planos de contas (árvore e formulário de conta), Exercícios (períodos com fecho e
reabertura), Diários.

## Ecrãs do 6.3

Contabilidade → Regras de contabilização (lista; editor com linhas, simulação sem gravar e envio de um evento de
teste) e Eventos contabilísticos (estado, mensagem da falha, reprocessar, ligação ao lançamento).

## Testes executados

| Lado     | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend  | 94/94 (`npm test`); lint, formatação, tipos e build sem erros. Novos: `accounting_domain.spec.ts` (decimais, arredondamento, hierarquia, períodos, partidas dobradas, desequilíbrio só na moeda funcional) e `accounting.spec.ts` (fluxo completo, segregação, imutabilidade pela API e pela base, estorno único, período fechado, idempotência concorrente, câmbio, permissões); matriz de isolamento com planos, contas, exercícios, períodos, diários, lançamentos e anexos |
| Frontend | 49/49; lint (incl. acessibilidade dos templates), formatação e build sem erros                                                                                                                                                                                                                                                                                                                                                                                                 |
| Browser  | 9/9 passos, 0 erros na consola: série, plano e contas (regra de prefixo visível), exercício com 14 períodos, diário, lançamento com vírgula decimal e equilíbrio ao vivo, submissão, aprovação e contabilização por outro utilizador (DG 2026/000001), estorno (DG 2026/000002), fecho de período, tema escuro e telemóvel                                                                                                                                                     |

Defeitos encontrados pela verificação e corrigidos: restrição de exclusão (exercícios sobrepostos) devolvia 500 em
vez de 409; valores com vírgula decimal eram dados como inválidos no equilíbrio; respostas atrasadas da entidade
anterior sobrepunham diários/contas no editor; quem só tinha permissões de contabilidade (sem `organization.read`)
não conseguia abrir um lançamento.

### Bloco 6.3

| Lado     | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend  | 102/102; lint, formatação, tipos e build sem erros. Novos: `posting_domain.spec.ts` (linhas a partir dos montantes, zero omite, montante em falta é erro, modelos e chave) e `posting_engine.spec.ts` (regras e sobreposição, versão por vigência, regra usada imutável, contabilização automática numerada, idempotência em simultâneo, falha registada e reprocessada, rascunho quando a regra não contabiliza, rollback na transacção de quem chama, simulação sem gravar, permissões); matriz de isolamento com regras e eventos |
| Frontend | 50/50; lint, formatação e build sem erros                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Browser  | 6/6 passos, 0 erros na consola: regra criada na UI, simulação desequilibrada e equilibrada, envio contabilizado (MV/0001) e reenvio sem duplicar, evento sem regra registado como falhado com a mensagem e reprocessado depois de criada a regra, tema escuro e telemóvel                                                                                                                                                                                                                                                            |

## Pendências

- 6.4 a 6.10 (acima). Os módulos de negócio (Facturação, Compras, Inventário, RH, Finanças) ainda não existem neste
  repositório; quando existirem, chamam `postAccountingEvent` — nenhum evento é emitido hoje por outro módulo. 6.9 só com a especificação oficial do SAF-T (AO) verificada.
- Terceiros são uma referência textual (`thirdPartyRef`) até existir o módulo de terceiros/partes.
- Depois de implantar, `node ace catalog:sync` dá as permissões novas ao perfil `tenant_admin` das empresas existentes.
