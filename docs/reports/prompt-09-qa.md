# QA do Prompt 09 (compras) — bloco 9.12

Branch `claude/pensive-clarke-5gm075`. Base verificada: blocos 9.1 a 9.11. Este documento regista o que foi executado e
os resultados reais; o que não foi executado está em "Limites".

## 1. Rastreabilidade dos testes exigidos

| Exigido no 9.12        | Onde está coberto                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aprovações             | `procurement_suppliers` (homologação segregada), `procurement_requisitions` (etapas por valor, quem pede não aprova, a mesma pessoa não decide duas etapas), `procurement_awards`, `procurement_orders` (rondas), `procurement_contracts` (adendas), `procurement_invoices` (excepções); **lifecycle** (cada aprovação do ciclo segregada e não repetível) |
| Pedidos duplicados     | `procurement_rfqs` (versões de proposta), `procurement_orders` (`AWARD_ALREADY_ORDERED`), `procurement_contracts` (consumo idempotente), `procurement_requisitions` (afectações idempotentes); **lifecycle** (aprovação repetida em paralelo, ordens da adjudicação em paralelo, emissão em paralelo); corridas de notas de crédito e verbas               |
| Preço/quantidade       | `procurement_requisitions` (imposto exacto), `procurement_orders` (totais, etapas), `procurement_contracts` (`PRICE_ABOVE_CONTRACT`), `procurement_invoices` (tolerâncias de preço e quantidade); **lifecycle** (a ordem não encomenda mais do que a requisição tem em aberto: `OVER_OPEN`)                                                                |
| Recepção repetida      | `procurement_receipts` (repetir a confirmação não duplica; duas recepções concorrentes); **lifecycle** (dois rascunhos de 6 com 10 em falta confirmados em paralelo: entra um, o outro `OVER_RECEIPT`; um só lançamento de stock)                                                                                                                          |
| Facturas duplicadas    | `procurement_invoices` (número externo por fornecedor, com outra grafia e sem o resto preenchido); **lifecycle** (duas facturas com o mesmo número em paralelo: 201 + 409 `DUPLICATE_INVOICE`; validações em paralelo validam uma vez)                                                                                                                     |
| Conferência (matching) | `procurement_invoices` (conferência a três, excepção autorizada por outra pessoa, `DIVERGENCES_CHANGED`), `procurement_returns` (notas de crédito abatem o facturado); **lifecycle** (acima do recebido → `QTY_OVER_RECEIVED`)                                                                                                                             |
| Pagamentos             | `procurement_finance` (obrigação única, nunca acima do saldo, contabilização falhada e repetida, saldos do razão); **lifecycle** (dois pagamentos de 4 000 em paralelo com 6 840 em dívida: passa um)                                                                                                                                                      |
| Multiempresa           | `isolation_matrix` (todas as rotas de compras contra outra empresa), `routes_protection`; testes de âmbito por entidade legal em cada ficheiro; **lifecycle** (outra empresa: 404 em cada registo do ciclo, listas vazias, `X-Tenant-Id` forjado recusado)                                                                                                 |
| Regressão              | todo o backend (364 testes) e todo o frontend (194 testes); os 10 scripts de browser do Prompt 09                                                                                                                                                                                                                                                          |

Contagem por ficheiro (compras):

- funcionais (24): suppliers 3, requisitions 2, rfqs 2, awards 2, orders 2, contracts 2, receipts 2, invoices 2,
  returns 2, finance 2, evaluations 1, lifecycle 2;
- unitários (48): suppliers 2, requisitions 3, rfqs 5, awards 7, orders 4, contracts 5, receipts 3, invoices 6,
  returns 5, finance 5, evaluations 3.

## 2. Ciclo completo (novo)

`backend/tests/functional/procurement_lifecycle.spec.ts` verifica o critério do Prompt 09 sobre os mesmos documentos,
numa só empresa: **Requisição → Aprovação → Cotação → Adjudicação → OC → Recepção única → Factura validada → Obrigação
financeira única, tudo rastreável**.

1. **Fornecedores**: quem regista não homologa (`SELF_APPROVAL`).
2. **Requisição** de 10 bombas com centro de custo e verba:
   - quem pede não aprova;
   - duas aprovações em paralelo dão 200 + 409;
   - a verba fica comprometida em 10 000.
3. **Cotação** a dois fornecedores; a proposta repetida do fornecedor 2 substitui a anterior (uma activa).
4. **Adjudicação** ao mais barato:
   - quem submete não aprova;
   - as ordens geradas em paralelo saem uma vez (201 + 409).
5. **Ordem**:
   - pedir mais do que a requisição tem em aberto é recusado (`OVER_OPEN`);
   - o comprador não aprova;
   - duas emissões em paralelo dão 200 + 409;
   - a requisição fica encomendada e a verba passa da requisição para a ordem (0 + 10 000, sem contar duas vezes).
6. **Recepção única**:
   - dois rascunhos de 6 confirmados em paralelo: entra um, o outro `OVER_RECEIPT`;
   - repetir a confirmação dá `INVALID_STATE`;
   - na base há um só lançamento de stock (6).
7. **Facturas**:
   - a mesma factura em paralelo (com outra grafia) dá 201 + 409 `DUPLICATE_INVOICE`;
   - validações em paralelo dão 200 + 409;
   - facturar mais do que o recebido pede excepção (`QTY_OVER_RECEIVED`), e a factura é devolvida.
8. **Obrigação única** de 6 840:
   - dois pagamentos de 4 000 em paralelo: passa um;
   - o segundo pagamento salda.
9. **Rastreabilidade**: obrigação → factura → ordem → adjudicação → pedido de cotação → linha da requisição. Cada
   documento tem auditoria (requisição, cotação, adjudicação, ordem, recepção, factura, obrigação). A verba fica com
   6 000 realizados e 4 000 comprometidos.
10. **Multiempresa**: outra empresa recebe 404 em cada registo do ciclo e listas vazias; com o `X-Tenant-Id` forjado,
    a sessão dela continua sem acesso.

Executado sete vezes seguidas (por causa das corridas): passou sempre.

### Defeito encontrado e corrigido

Ao rever onde o código verifica a unicidade e depois insere, apareceram duas operações sem a conversão do erro do índice
único (as facturas já a tinham):

- **notas de crédito** (`purchase_credit_notes_external_unique`), ao registar e ao alterar o número;
- **verbas** (`procurement_budgets_unique`).

Com dois pedidos simultâneos, o segundo passava a verificação, era travado pelo índice e chegava ao cliente como **500**.
Agora devolve **409** (`DUPLICATE_CREDIT_NOTE` / `BUDGET_EXISTS`). O índice da base já garantia que não ficavam
duplicados; o defeito era só a resposta.

Novo teste (no mesmo ficheiro): cinco rondas de notas de crédito com o mesmo número e de verbas para o mesmo centro de
custo/ano, em paralelo — sempre 201 + 409, uma de cada na base. **Com as correcções retiradas, o teste falhou logo na
primeira ronda (`[201, 500]`)**; com elas, passou três vezes seguidas.

As restantes unicidades das compras já estavam protegidas, por bloqueio do documento ou por conversão do erro:

- fornecedor (código, NIF);
- IBAN do fornecedor;
- código das etapas;
- proposta activa e versões;
- adjudicação viva;
- adenda pendente;
- revisão pendente;
- obrigação por factura;
- avaliação em vigor.

## 3. Execuções

| Verificação                           | Resultado                                                            |
| ------------------------------------- | -------------------------------------------------------------------- |
| Backend lint / formatação / tipos     | sem erros                                                            |
| Backend testes (`npm test`)           | **364 passados** (cada execução aplica as 53 migrações e reverte-as) |
| Backend build                         | concluído                                                            |
| Frontend lint / formatação            | sem erros                                                            |
| Frontend testes (`npm test`)          | **194 passados**                                                     |
| Frontend build                        | concluído                                                            |
| E2E no browser, 10 scripts (9.2–9.11) | **63 passos OK**, sem erros na consola                               |

Regressão E2E (Playwright, servidores locais, dois utilizadores): p0902 7/7, p0903 8/8, p0904 6/6, p0905 6/6, p0906
6/6, p0907 5/5, p0908 6/6, p0909 6/6, p0910 7/7, p0911 6/6.

**Primeira passagem: 57 de 63.** Falharam 6 passos de 4 scripts (p0903, p0905, p0906, p0907), por desactualização dos
scripts e não do produto:

- esses scripts procuravam os números pelo prefixo da série que criavam (`OC…`, `PC…`, `RE…`);
- scripts posteriores criaram na base de demonstração séries cujo código vem antes por ordem alfabética (`OB…`, `RB…`);
- como, com várias séries activas, se usa a primeira por código (pendência conhecida desde o 9.2), os números passaram a
  sair com esse prefixo — a ordem foi emitida correctamente, com o número `OB12589/000017`.

Os scripts passaram a aceitar qualquer prefixo e voltaram a passar por inteiro.

## 4. Revisão de segurança e invariantes (módulo de compras)

- **SQL**: as interpolações em `rawQuery` do módulo são fragmentos internos — cláusulas de âmbito, colunas de mapas
  fechados, filtros de enumerações validadas. Os valores vão sempre como parâmetros.
- **Âmbito**: as rotas de compras sem `can()` têm justificação no `routes_protection` e verificação no serviço
  (entidade legal; empresa para fornecedores e publicação de avaliações). A matriz de isolamento cobre leituras e
  escritas de cada tipo de registo contra outra empresa.
- **Segregação de funções**, também com `CHECK` na base onde se aplica:
  - homologação e dados bancários do fornecedor;
  - etapas das requisições e das ordens;
  - adjudicação;
  - contratos e adendas;
  - excepções das facturas.
- **Imutabilidade na base**: documentos finalizados (requisição submetida, pedido emitido, adjudicação submetida, ordem
  emitida, contrato aprovado, recepção confirmada, factura validada, devolução confirmada, nota de crédito validada),
  livros só de acréscimo (afectações, consumos, compromissos, pagamentos, eventos) e avaliações publicadas. As correcções
  são rastreáveis: revisão, adenda, estorno, devolução, nota de crédito, substituição.
- **Idempotência e concorrência**:
  - bloqueio do documento-pai nas transições;
  - chaves idempotentes no Inventário e na contabilidade;
  - índices únicos parciais para os números externos, convertidos em 409.
- **Integrações sem duplicar**:
  - uma entrada no Inventário por recepção e uma saída por devolução;
  - a factura salda as recepções por facturar (o stock nunca é lançado duas vezes);
  - uma obrigação por factura;
  - a verba nunca fica comprometida duas vezes.
- **Valores**: dinheiro e quantidades em inteiros escalados no código e `numeric` na base; texto na API.

## 5. Limites e pendências

- Os scripts E2E vivem fora do repositório (scratchpad da sessão) porque usam contas e palavras-passe de
  desenvolvimento; integrá-los num runner versionado com credenciais por variável de ambiente fica por fazer (como nos
  Prompts 07 e 08).
- **Não houve teste de carga.** A concorrência é exercida com pedidos paralelos dentro de um processo, não com vários
  processos nem volumes reais. Corridas que dependem do tempo podem não se cruzar numa execução: o ciclo foi corrido
  sete vezes, e o defeito das notas de crédito foi confirmado por reversão.
- Com várias séries activas para o mesmo tipo de documento usa-se a primeira por código. Já documentado; afectou os
  scripts de browser, não o produto.
- Ficam como estavam, registadas nos blocos:
  - Tesouraria (Prompt 11) e estorno de pagamentos;
  - orçamento geral;
  - portal do fornecedor e envio de documentos por e-mail;
  - agendador de avisos (validade de documentos, renovações, avaliações periódicas);
  - nota de qualidade da adjudicação ligada à avaliação;
  - conformidade fiscal dos documentos do fornecedor (não verificada).
- O 6.9 (SAF-T) continua bloqueado pela especificação oficial.
