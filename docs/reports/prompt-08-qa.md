# QA do Prompt 08 (inventário) — bloco 8.12

Branch `claude/pensive-clarke-5gm075`. Base verificada: blocos 8.1 a 8.11. Este documento regista o que foi executado e
os resultados reais; o que não foi executado está em "Limites".

## 1. Rastreabilidade dos testes exigidos

| Exigido no Prompt 08       | Onde está coberto                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entradas                   | `inventory_documents.spec.ts` (rascunho → conferência → confirmação, número por série, quarentena), `inventory_integrations.spec.ts` (recepção de compra), **`inventory_lifecycle.spec.ts`** |
| Saídas                     | `inventory_documents.spec.ts` (saída acima do disponível não lança nada), `inventory_requisitions.spec.ts`, `inventory_integrations.spec.ts` (reserva, entrega, devolução), **lifecycle** |
| Parcial                    | `inventory_documents.spec.ts` (confirmações parciais, estorno de uma, fecho do saldo), `inventory_transfers.spec.ts` (recepção parcial), `inventory_requisitions.spec.ts` (entregas parciais), **lifecycle** |
| Concorrência               | `inventory_stock.spec.ts`, `inventory_documents.spec.ts` (duas confirmações em paralelo: 200 + 409), `inventory_integrations.spec.ts` (mesma chave em paralelo: um lançamento), **lifecycle** (duas entregas de 45 com 70 livres: passa uma, a outra `INSUFFICIENT_STOCK`) |
| Duplicação                 | `inventory_stock.spec.ts` (chave de idempotência e hash do pedido), `inventory_documents.spec.ts`, `inventory_transfers.spec.ts`, `inventory_valuation.spec.ts` (ajuste idempotente), `inventory_integrations.spec.ts` (`IDEMPOTENCY_MISMATCH`), **lifecycle** |
| Transferência e trânsito   | `inventory_transfers.spec.ts` (reserva na aprovação, trânsito no destino, perda, intragrupo com aceitação, segregação), `inventory_valuation.spec.ts` (valor entre entidades), **lifecycle** |
| Contagem                   | `inventory_counts.spec.ts` (snapshot, contagem cega, recontagem, justificação, aprovação segregada, imutável depois), **lifecycle** |
| Reconciliação              | `inventory_stock.spec.ts` (movimentos = saldos), `inventory_valuation.spec.ts` (livro = saldos de custo = camadas = stock; inventário × razão), `inventory_integrations.spec.ts` (diferença 0,00 depois de contabilizar), **lifecycle** (as três de seguida) |
| Isolamento entre tenants   | `isolation_matrix.spec.ts` (todas as rotas de inventário contra outra empresa e com `X-Tenant-Id` forjado), `routes_protection.spec.ts`, **lifecycle** (outra empresa: 404 em cada registo do ciclo, listas vazias, cabeçalho forjado recusado) |

Contagem por ficheiro (inventário) — funcionais: catalog 4, warehouses 3, stock 4, documents 3, transfers 3,
requisitions 2, counts 3, lots 3, valuation 2, integrations 2, reports 2, lifecycle 1 (32); unitários: catalog 4,
warehouses 2, stock 2, documents 2, transfers 2, requisitions 2, counts 2, lots 3, valuation 3, integrations 2,
reports 3 (27).

## 2. Regressão do ciclo completo (novo)

`backend/tests/functional/inventory_lifecycle.spec.ts` encadeia os blocos sobre o mesmo stock, numa empresa com plano
de contas:

1. **Entrada parcial**: documento de 100 a 12,00; chegam 60 (conferir não mexe no stock; confirmar → `PARTIAL`).
   **Duplicação**: a mesma confirmação repetida não lança de novo (1 lançamento). **Concorrência**: os 40 restantes
   confirmados duas vezes em paralelo entram uma só vez (200 + 409; 2 lançamentos; documento `COMPLETED` e não anulável).
2. **Saídas**: reserva de venda de 30 (físico 100, disponível 70), entrega de 20 que consome a reserva, pedido repetido
   devolve o mesmo resultado; duas entregas de 45 em paralelo com 70 livres → passa uma (físico 35, reservado 10).
3. **Transferência** de 20: quem pede não aprova; a aprovação reserva; expedição (repetida sem efeito) põe 20 em
   trânsito no destino; recepção parcial de 15; fecho com perda de 5 por outra pessoa.
4. **Contagem**: o sistema tem 15, contam-se 14; quem contou não aprova; justificação e aprovação lançam −1.
5. **Reconciliações**: movimentos = saldos (sem diferenças); livro de custo = saldos de custo = stock (29 × 12,00 =
   348,00); relatórios do 8.11 coerentes (compras 1 200,00, vendas 780,00, perda em trânsito 60,00, falta de contagem
   12,00; perdas 72,00; valorizado 348,00; repor 81).
6. **Contabilidade**: sem regras, todos os eventos ficaram falhados sem bloquear nada; criadas as regras, a repetição
   lança-os todos (repetir outra vez não lança nada) e **o razão fica igual ao inventário: 348,00 = 348,00**.
7. **Imutabilidade**: a base recusa alterar movimentos, apagar lançamentos, mexer no livro de custo e escrever saldos.
8. **Isolamento**: outra empresa recebe 404 em cada registo do ciclo, listas vazias, e não entra com o cabeçalho forjado.

Executado quatro vezes seguidas (por causa das corridas): passou sempre.

### Defeitos

O ciclo não revelou defeitos no produto. Duas expectativas do próprio teste estavam erradas e foram corrigidas no teste
(stock insuficiente é 409 `INSUFFICIENT_STOCK`, não 422; quem conta e tenta aprovar recebe `SELF_APPROVAL`).

## 3. Execuções

| Verificação                           | Resultado                                                            |
| ------------------------------------- | -------------------------------------------------------------------- |
| Backend lint / formatação / tipos     | sem erros                                                            |
| Backend testes (`npm test`)           | **292 passados** (cada execução aplica as 42 migrações e reverte-as) |
| Backend build                         | concluído                                                            |
| Frontend lint / formatação            | sem erros                                                            |
| Frontend testes (`npm test`)          | **157 passados**                                                     |
| Frontend build                        | concluído                                                            |
| E2E no browser, 11 scripts (8.1–8.11) | **71 passos OK**, sem erros na consola                               |

Regressão E2E (Playwright, servidores locais, dois utilizadores): p081 6/6, p082 7/7, p083 7/7, p084 8/8, p085 6/6,
p086 5/5, p087 6/6, p088 7/7, p089 6/6, p090 6/6, p091 7/7.

Na primeira passagem o p089 falhou num passo (5/6), por desactualização dos scripts e não do produto:

- p083 (escrito no 8.3, antes de haver entradas) semeava o stock inicial por SQL directo na base, fora do `postStock`.
  Desde o 8.9 isso deixa stock sem livro de custo — e a reconciliação interna da entidade **detectou-o**
  ("quantidade valorizada ≠ stock" no produto semeado), que é exactamente o que deve fazer. O script passou a dar
  entrada por documento (API); só o "previsto", que ainda não tem API, continua lançado na base.
- p089 usava a primeira entidade legal da empresa de testes, partilhada com outros scripts; passou a criar a sua.

O produto semeado por SQL nessa passagem ficou na base de desenvolvimento (os lançamentos são só de acréscimo); não
afecta a base de testes nem o repositório.

## 4. Revisão de segurança e invariantes (módulo de inventário)

- SQL: todas as interpolações em `rawQuery` do módulo são fragmentos internos (selects fixos, cláusulas de âmbito,
  nomes de colunas de mapas fechados ou de objectos construídos no serviço, `order by` de campos validados, baldes de
  enumerações validadas); os valores vão sempre como parâmetros.
- Âmbito: as rotas de inventário sem `can()` têm justificação no `routes_protection` e verificação no serviço
  (armazéns consultáveis, acesso de operação, entidade legal); a matriz de isolamento cobre leituras e escritas de
  cada tipo de registo contra outra empresa.
- Um só caminho para o stock: todos os blocos lançam por `postStock` (advisory lock por armazém/produto/variante,
  verificação de saldos repetida na base, idempotência por chave e hash); os saldos, os saldos de custo e as camadas
  derivam por gatilho e recusam escritas directas.
- Imutabilidade na base: lançamentos e movimentos, livro de custo, ajustes de custo, eventos contabilísticos (conteúdo)
  e pedidos de integração — verificado nos testes funcionais e no ciclo.
- Segregação de funções: transferências (quem pede não aprova), contagens (quem conta não aprova), requisições.
- Dinheiro e quantidades em inteiros escalados no código e `numeric` na base; texto na API.

## 5. Limites e pendências

- Os scripts E2E vivem fora do repositório (scratchpad da sessão) porque usam contas e palavras-passe de
  desenvolvimento; integrá-los num runner versionado com credenciais por variável de ambiente fica por fazer (como no
  Prompt 07).
- Não houve teste de carga; a concorrência é exercida com pedidos paralelos dentro de um processo (advisory locks e
  versões optimistas), não com vários processos nem volumes reais.
- Uma escrita directa na base pela conta dona (fora da aplicação) pode criar movimentos sem livro de custo: a base não
  o impede, a reconciliação interna detecta-o (ver o caso do p083).
- Compras e Vendas ainda não existem: os contratos do 8.10 estão testados, mas sem um módulo que os chame.
- Alertas sem notificações automáticas (não há agendador); 6.9 SAF-T continua bloqueado pela especificação oficial.
