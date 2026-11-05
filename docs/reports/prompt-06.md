# Relatório — Prompt 06 (contabilidade)

Estado: **6.1 e 6.2 implementados e verificados** no branch `claude/pensive-clarke-5gm075`. Os blocos 6.3 a 6.10
dependem desta fundação e ficam para os blocos seguintes. Decisão D-014.

Nada aqui alega conformidade com o PGC angolano, a AGT ou o SAF-T (AO): o plano é definido pela empresa e a
validação normativa (versão do PGC, SAF-T, critérios dos mapas) continua pendente antes de qualquer alegação fiscal.

## Matriz AS-IS / TO-BE

| Bloco                   | AS-IS (fim do Prompt 05)                        | TO-BE                                                                                                                                                                                                                  | Estado     |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 6.1 Plano de contas     | Só séries `JOURNAL`, câmbios e centros de custo | Planos por entidade legal (um activo), contas em árvore com prefixo, natureza, saldo normal, movimentável, exigências de centro de custo/terceiro, linha das demonstrações; exercícios e períodos OPEN/CLOSED; diários | Feito      |
| 6.2 Lançamentos         | Nada                                            | Cabeçalho completo (entidade, exercício, período, diário, datas, referência, moeda/câmbio, origem, estado, anexos) e linhas; validação de partidas dobradas; fluxo com segregação; imutável; estorno; idempotência     | Feito      |
| 6.3 Posting engine      | —                                               | Regras por origem/evento/vigência sem códigos fixos, sobre `idempotencyKey` e `source`/`sourceRef` já existentes                                                                                                       | Próximo    |
| 6.4 Abertura/razão      | —                                               | Importação equilibrada de saldos (período de abertura já existe), razão, balancete sem duplicar contas-pai                                                                                                             | Por fazer  |
| 6.5 Analítica           | Centros de custo por linha                      | Dimensões, imputações e repartições a 100%                                                                                                                                                                             | Por fazer  |
| 6.6 Activos fixos       | —                                               | Ficha, depreciação, abate, contabilização                                                                                                                                                                              | Por fazer  |
| 6.7 Regularizações      | Período de regularizações existe                | Provisões, acréscimos, diferimentos, recorrências, diferenças cambiais                                                                                                                                                 | Por fazer  |
| 6.8 Demonstrações       | `statementLine` por conta                       | Mapas versionados, PDF/Excel, conferência com o balancete                                                                                                                                                              | Por fazer  |
| 6.9 Fiscalidade (SAF-T) | —                                               | Só com a especificação oficial verificada                                                                                                                                                                              | Bloqueado* |
| 6.10 Fecho              | Fecho/reabertura de períodos auditados          | Checklist, encerramento do exercício, concorrência                                                                                                                                                                     | Parcial    |

\* Bloqueado pela validação normativa, não por código.

## Endpoints (todos com `auth`, `tenant`, `can()` e a funcionalidade `accounting`)

- `GET|POST /accounting/{charts,accounts,fiscal-years,journals}`, `GET|PATCH …/:id` (`accounting.read` / `accounting.settings`)
- `POST /accounting/periods/:id/close` (`accounting.close`), `…/reopen` (`accounting.reopen`, motivo obrigatório)
- `GET|POST /accounting/entries`, `GET|PATCH|DELETE /accounting/entries/:id`, `POST …/submit` (`accounting.create`)
- `POST …/approve`, `…/reject` (`accounting.approve`), `…/post` (`accounting.post`), `…/reverse` (`accounting.reverse`)

## Ecrãs

Contabilidade → Lançamentos (lista com filtros e exportação; editor com equilíbrio ao escrever, acções por estado e
permissão, anexos e histórico), Planos de contas (árvore e formulário de conta), Exercícios (períodos com fecho e
reabertura), Diários.

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

## Pendências

- 6.3 a 6.10 (acima). 6.9 só com a especificação oficial do SAF-T (AO) verificada.
- Terceiros são uma referência textual (`thirdPartyRef`) até existir o módulo de terceiros/partes.
- Depois de implantar, `node ace catalog:sync` dá as permissões novas ao perfil `tenant_admin` das empresas existentes.
