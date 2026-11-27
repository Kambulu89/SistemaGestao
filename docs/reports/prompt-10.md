# Relatório — Prompt 10 (vendas e facturação)

Estado: **Prompt 10 em curso** — 10.1 a 10.11 feitos, no branch `claude/pensive-clarke-5gm075`. Decisões D-059 a D-069. Antes de começar
foi feita a revisão dos Prompts 01–09 (`docs/reports/revisao-prompts-01-09.md`).

## Diagnóstico AS-IS → TO-BE e dependências

| Bloco                         | Antes (o que já existe e serve)                                                                                   | A fazer                                                                                        | Dependência / contrato                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 10.1 Clientes                 | Terceiro reutilizável (`partners`, 9.1) com NIF por país e contactos                                              | Papel de cliente, condições, crédito, moradas, versões imutáveis                               | `partners` (`createPartner`, `partnerByTaxId`, `partnerView`)                                                                   |
| 10.2 Preços e descontos       | Catálogo de produtos e unidades (8.1)                                                                             | Tabelas por produto/segmento/cliente, moeda, quantidade, período; descontos com aprovação      | `inventory.productExists`; segmentos do 10.1; aprovações (Prompt 03)                                                            |
| 10.3 Orçamentos               | Séries documentais (5), aprovações                                                                                | Versões, aprovação, envio, aceitação, conversão única                                          | `customerSnapshot`; preços do 10.2; impostos do 10.5                                                                            |
| 10.4 Encomendas               | Reservas e entregas de venda no Inventário (8.6, 8.10: `reserveForSale`, `releaseSaleReservation`, `deliverSale`) | Estados separados, quantidades por linha, limite de crédito                                    | Contratos do Inventário (idempotentes, por referência); serviços sem stock                                                      |
| 10.5 Motor fiscal e séries    | Séries documentais com prefixo (5); compras usam taxa por linha sem motor                                         | Impostos/isenções/retenções por país, entidade e vigência; séries fiscais com sequência segura | **Verificação nas fontes oficiais** (Decreto Presidencial n.º 71/25, regulamentos e versões da AGT) antes de configurar valores |
| 10.6 Factura                  | —                                                                                                                 | Três estados distintos (negócio, fiscal, cobrança); emitida imutável                           | 10.5; Posting Engine (6.3)                                                                                                      |
| 10.7 Factura-recibo e recibos | Pagamentos de compras ficam em Compras (dívida registada na revisão)                                              | Recebido só após confirmação financeira; afectações; adiantamentos                             | Tesouraria (Prompt 11) ausente → contrato e estado pendente de confirmação                                                      |
| 10.8 Notas de crédito/débito  | Devoluções do Inventário (`returnFromSale`)                                                                       | Referência ao original, motivo, elegibilidade                                                  | 10.6; Inventário para a devolução física                                                                                        |
| 10.9 Electrónica              | —                                                                                                                 | `FiscalIntegrationProvider` com simulador local marcado                                        | Sem comunicação com a AGT nem alegação de certificação                                                                          |
| 10.10 Cobranças               | —                                                                                                                 | Contas a receber                                                                               | Finanças (Prompt 11) ausente → só contrato                                                                                      |
| 10.11–10.14                   | —                                                                                                                 | Recorrência, integração, relatórios/PDF, QA                                                    | Agendador ausente (sem Redis): execução a pedido com idempotência                                                               |

## 10.1 Clientes

### Modelo

Migração `0054_create_customers`:

- `customer_segments` — código único, nome, descrição, estado.
- `customers` — um por terceiro (`customers_partner_unique`); moeda `char(3)`, prazo 0–365, limite `numeric(20,2)` (vazio = sem
  limite), segmento, estado `ACTIVE|BLOCKED|INACTIVE` com motivo obrigatório fora de activo (`CHECK`), notas. Gatilho:
  não se apaga nem muda de terceiro.
- `customer_addresses` — facturação ou entrega, designação, morada, município, cidade, província, código postal, país;
  uma por omissão por tipo (índice único parcial); inactiva não pode ser por omissão (`CHECK`).
- `customer_versions` — número sequencial, dados (`jsonb`) e impressão digital; só de acréscimo (gatilho).
- `customer_events` — cronologia só de acréscimo.

### Backend e API (`/api/v1/sales`, funcionalidade `sales`)

- `GET|POST /customers`, `GET /customers/lookup?countryCode=&taxId=`, `GET|PATCH /customers/:id`,
  `POST /customers/:id/{credit|status|addresses|contacts}`, `PATCH /customers/:id/addresses/:addressId`,
  `PATCH /customers/:id/contacts/:contactId`, `GET /customers/:id/current-version`.
- `GET|POST /segments`, `PATCH /segments/:id` (`sales.settings` para escrever).
- Contrato para os documentos de venda: `customerSnapshot(scope, customerId)` → versão em vigor (id, número, dados),
  estado, moeda, prazo, limite e segmento.
- Regras: identidade no terceiro (partilhada com o fornecedor); versão nova só quando a impressão digital muda (advisory
  lock por cliente); limite de crédito só por `sales.customers.credit` com motivo, nunca pela edição geral
  (`NOT_ALLOWED`); bloquear/inactivar com motivo; concorrência optimista com `expectedVersion`.
- Permissões `sales.customers.read|manage|credit`, `sales.settings`. Anexos com o assunto `customer`. Auditoria
  `customer.*` e `customer_segment.*` na mesma transacção.
- Erros: `ALREADY_CUSTOMER`, `TAX_ID_TAKEN` (com o terceiro), `CODE_TAKEN`, `NOT_ALLOWED`, `VERSION_CONFLICT`, 404 para
  referências de outra empresa.

### Ecrãs (`/vendas`)

- **Clientes** — lista com pesquisa e filtro de estado; novo cliente com verificação do NIF ao sair do campo: se o
  terceiro existe, oferece torná-lo cliente (sem ficha duplicada).
- **Cliente** — estado e condições, limite de crédito (modal com motivo, só para quem gere o crédito), bloquear /
  inactivar / reactivar, moradas (nova, editar, por omissão, inactivar), contactos, versões dos dados fiscais,
  anexos, cronologia e auditoria.
- **Segmentos de clientes** — tabela e modal (edição só com `sales.settings`).
- Navegação: secção "Vendas" em Operações Empresariais.

### Testes e evidências

- Backend: `tests/functional/sales_customers.spec.ts` (ciclo, versões, crédito, estados, moradas, reutilização do
  terceiro, permissões e conflitos), `tests/unit/sales_customers_domain.spec.ts`, `isolation_matrix` (segmento, cliente e
  morada de outra empresa: 10 tentativas recusadas), `routes_protection`.
- Frontend: `customer-model.spec.ts`.
- Browser (`p1001`, 10 passos, 4 execuções seguidas sem falhas nem erros de consola): segmento; cliente pela navegação;
  limite de crédito com motivo obrigatório; mudança de nome → versão 2 com a versão 1 intacta; morada de entrega e
  contacto; bloqueio com motivo na ficha, cronologia e lista; NIF de fornecedor reutiliza o terceiro; utilizador sem
  permissão recebe 403 e não vê o menu; telemóvel sem deslocamento horizontal.

### Pendências

- A regra "bloqueado não recebe documentos" e o controlo do limite de crédito são aplicados pelos documentos (10.3–10.7).
- Listas oficiais de províncias/municípios continuam texto livre (pendência do Prompt 05).

## 10.2 Preços e descontos

### Modelo

Migração `0055_create_sales_pricing`:

- `price_lists` — código único, nome, moeda, destino (`GENERAL|SEGMENT|CUSTOMER`, `CHECK` de coerência), entidade
  legal opcional, período, prioridade 0–1000, estado `DRAFT|PENDING|ACTIVE|INACTIVE`, quem submeteu e quem aprovou
  (diferentes, `CHECK`), motivo de inactivação, origem da cópia.
- `price_list_lines` — produto, variante opcional, quantidade mínima, preço `numeric(20,4)`, desconto manual máximo
  opcional. O escalão é único por produto/variante (índice único).
- `discount_rules` — destino (`ALL|SEGMENT|CUSTOMER`), produto **ou** categoria (ou nenhum), quantidade mínima,
  percentagem, período, prioridade e o mesmo ciclo de aprovação.
- `discount_limits` — desconto manual máximo, um por destino (índice único).
- `pricing_events` — cronologia, só de acréscimo.

Gatilhos na base:

- fora do rascunho, o conteúdo de tabelas e regras não muda;
- uma tabela ou regra inactiva não volta a activa;
- nada se apaga;
- as linhas só mudam enquanto a tabela está em rascunho.

### Backend e API (`/api/v1/sales`)

- `GET|POST /price-lists`, `GET|PATCH /price-lists/:id`, `POST /price-lists/:id/lines`,
  `PATCH|DELETE /price-lists/:id/lines/:lineId`, `POST /price-lists/:id/{submit|approve|reject|deactivate|copy}`.
- `GET|POST /discount-rules`, `GET|PATCH /discount-rules/:id`, `POST /discount-rules/:id/{submit|approve|reject|deactivate}`.
- `GET|PUT /discount-limits`, `DELETE /discount-limits/:id`.
- `POST /pricing/resolve` (snapshot sem gravar), `GET /pricing/options`, `GET /pricing/search/{customers|products}`
  (só identificação, para os formulários de quem não tem permissões de clientes ou de inventário).
- Contrato para 10.3+: `resolvePrices(scope, {customerId, currency, date, legalEntityId?, lines[]})`.
- Regras: resolução e limites como em D-060; aprovação segregada (`SELF_APPROVAL`); sobreposição na aprovação
  (`OVERLAP`, sob advisory lock); concorrência optimista com `expectedVersion`; códigos e escalões únicos convertidos de
  `23505` em 409 (D-058).
- Permissões `sales.prices.read|manage|approve`. Auditoria `price_list.*`, `discount_rule.*` e `discount_limit.*` na mesma
  transacção.
- Erros: `CODE_TAKEN`, `TIER_EXISTS`, `NO_LINES`, `INVALID_STATE`, `SELF_APPROVAL`, `OVERLAP`, `VERSION_CONFLICT`,
  `OUT_OF_SCOPE`.

### Ecrãs (`/vendas`)

- **Tabelas de preços** — lista com filtros de estado e destino; cabeçalho com destino, moeda, entidade, prioridade e
  período.
- **Ficha da tabela** — preços com produto por pesquisa, variante, escalão e desconto máximo; submeter, aprovar (só
  outra pessoa, com confirmação), devolver e inactivar com motivo, copiar para nova tabela; cronologia e auditoria.
- **Regras de desconto** — lista, formulário (clientes, produtos ou categoria, quantidade, período, prioridade) e ficha
  com o mesmo ciclo de aprovação.
- **Limites de desconto** — tabela e modal; só quem aprova preços os altera.
- **Consulta de preços** — o motor real sem gravar. Por linha mostra a origem, o preço base, a regra, o desconto manual,
  o limite e de onde vem, o preço líquido, o valor e se precisa de aprovação, mais a impressão digital do snapshot.

### Testes e evidências

**Backend**

`tests/unit/sales_pricing_domain.spec.ts` (6 testes):

- decimais e arredondamento;
- validação;
- escolha da tabela e do escalão;
- escolha da regra;
- preço líquido, limites e aprovação;
- catálogo, preço manual e linha sem preço.

`tests/functional/sales_pricing.spec.ts` (3 testes):

- **Ciclo da tabela:** escalões; devolução com motivo; aprovação por quem submete recusada; imutabilidade pela API e na
  base.
- **Resolução:** cliente, segmento e geral; período, moeda e catálogo; cópia com novo preço; `OVERLAP` até inactivar a
  antiga.
- **Regras e limites:** regra por categoria-mãe e por prioridade; limites cliente, segmento, geral e linha; preço manual;
  hash estável; pesquisas; erros por linha; permissões.
- **Concorrência:** três aprovações simultâneas de tabelas sobrepostas, das quais só uma fica activa.

Também cobertos:

- `isolation_matrix`: 11 tentativas sobre tabela, linha, regra e limite de outra empresa, todas com 404; resolve e
  referências cruzadas recusados sem revelar dados.
- `routes_protection`.

**Frontend:** `pricing-model.spec.ts`.

**Browser (`p1002`):** 8 passos, 4 execuções seguidas sem falhas nem erros de consola.

- tabela do segmento com dois escalões pela navegação;
- quem submete não vê "Aprovar" e outra pessoa aprova;
- a tabela activa deixa de ser editável;
- regra de 10 % aprovada por outra pessoa;
- limite do segmento de 5 %;
- na consulta, escalão 10 → 90 − 10 % − 6 % = 76,14 (913,68 para 12), com "Desconto acima do limite"; com 5 % → 76,95
  sem aprovação;
- cópia para rascunho com os preços e inactivação da antiga com motivo;
- telemóvel sem deslocamento horizontal.

**Regressão:** `p1001` voltou a passar.

### Pendências

- A aprovação de um desconto acima do limite e a guarda do snapshot acontecem nos documentos (10.3 em diante).
- Ficam para depois:
  - limites por vendedor ou perfil;
  - preços noutra unidade;
  - promoções acumuláveis.

## 10.3 Orçamentos e propostas

### Modelo

Migração `0056_create_sales_quotes`:

- `sales_quotes` — guarda:
  - entidade legal, cliente, comercial (membro);
  - data, validade, moeda e prazo (por omissão os do cliente);
  - referência e notas;
  - totais `numeric` (`CHECK` total = líquido + imposto);
  - estado, versão em curso, série e número;
  - submissão, aprovação, envio e decisão do cliente;
  - encomenda de conversão (índice único).
- `sales_quote_lines` — produto/variante, descrição, quantidade, desconto ou preço manual (nunca os dois), taxa de
  imposto e motivo de isenção a 0 %, origem e valores do preço, snapshot do motor (`jsonb`), indicação de aprovação.
- `sales_quote_versions` — fotografia de cada versão enviada: dados, versão do cliente, impressão digital, canal e
  destinatário. Só de acréscimo.
- `sales_quote_events` — cronologia, só de acréscimo.

Gatilhos na base:

- conteúdo do cabeçalho e linhas só mudam em rascunho;
- número e série fixos depois de atribuídos;
- anulado e convertido são finais;
- aceite só passa a convertido;
- nada se apaga.

### Backend e API (`/api/v1/sales/quotes`)

- `GET /quotes`, com os filtros estado (incluindo `EXPIRED`), cliente, entidade e pesquisa.
- `GET /quotes/options`, `GET /quotes/search/{customers|products}`.
- `POST /quotes`, `GET|PATCH /quotes/:id`.
- `POST /quotes/:id/{submit|approve|reject|send|accept|decline|revise|cancel}`.
- Contratos para o 10.4: `acceptedQuote(scope, id)` e `markQuoteConverted(scope, id, orderId)`.
- Permissões `sales.quotes.read|manage|approve` com âmbito de empresa, entidade legal ou OWN. Anexos com o assunto
  `sales_quote`. Auditoria `sales_quote.*` na mesma transacção.
- Erros:
  - `INVALID_STATE`, `NO_LINES`, `NO_PRICE`;
  - `CUSTOMER_BLOCKED`, `SELF_APPROVAL`;
  - `NO_SERIES`, `SERIES_REQUIRED`;
  - `EXPIRED`, `VERSION_MISMATCH`, `ALREADY_CONVERTED`, `NOT_ACCEPTED`;
  - `VERSION_CONFLICT`, `OUT_OF_SCOPE`.

### Ecrãs (`/vendas/orcamentos`)

- **Lista** — número e versão, cliente, entidade, datas, total e estado (com "Expirado").
- **Formulário** — entidade, cliente por pesquisa, comercial, datas, moeda e prazo; linhas com produto, descrição,
  quantidade, desconto ou preço manual, imposto e motivo de isenção a 0 %.
- **Ficha** — linhas com a origem do preço (tabela/catálogo/manual, regra, desconto e limite) e motivos de aprovação,
  e os totais. Acções: submeter, aprovar (outra pessoa, com confirmação), devolver, enviar (série, canal,
  destinatário), aceitação e recusa do cliente, rever, anular. Também versões enviadas com impressão digital, anexos,
  cronologia e auditoria.

### Testes e evidências

**Backend**

`tests/unit/sales_quotes_domain.spec.ts` (4 testes):

- cabeçalho;
- linhas e isenção;
- imposto por linha e totais exactos;
- envio, decisão, transições e expiração.

`tests/functional/sales_quotes.spec.ts` (2 testes):

- **Preços e aprovação:** preços do catálogo com desconto e preço manual; isenção obrigatória a 0 %; aprovação
  pendente, devolução com motivo e aprovação automática sem excepções.
- **Envio:** `NO_SERIES`, `SERIES_REQUIRED` e e-mail obrigatório; número da série.
- **Imutabilidade na base:** linhas, totais e versões.
- **Revisão e decisão:** versão 2 com o mesmo número e a versão 1 fotografada intacta; `VERSION_MISMATCH`; recusa com
  motivo; aceite sem revisão nem anulação.
- **Conversão:** duas conversões simultâneas pelo contrato, das quais só uma passa.
- **Âmbitos:** por entidade (404 fora do âmbito), OWN (só os próprios; sem atribuir a outro comercial) e
  `SELF_APPROVAL`.
- **Cliente e validade:** cliente bloqueado impede criar, submeter e enviar; expirado listado e aceitação recusada.

Também cobertos:

- `isolation_matrix`: 5 tentativas sobre o orçamento de outra empresa, todas com 404; criação com entidade e cliente
  alheios recusada; a lista não mostra o orçamento alheio.
- `routes_protection`.

**Frontend:** `quote-model.spec.ts`.

**Browser (`p1003`):** 7 passos.

- orçamento pela navegação: 1 000 −10 % × 2 + 14 % = 2 052,00, assinalado "Desconto acima do limite";
- quem submeteu não vê "Aprovar" e outra pessoa aprova;
- envio por e-mail com destinatário obrigatório, número da série e versão 1;
- revisão para versão 2 com o mesmo número: 3 × 970 + 14 % = 3 317,40, aprovado logo (3 % ≤ limite), versão 2
  enviada;
- aceitação sobre a versão 2, sem rever, anular nem editar;
- a lista mostra "Aceite";
- telemóvel sem deslocamento horizontal.

### Pendências

- Converter em encomenda chega com o 10.4: o contrato está feito e testado, e não há botão nem encomenda provisória.
- O imposto por linha é provisório até ao motor fiscal (10.5), que traz códigos, isenções e vigência verificados nas
  fontes oficiais.
- O PDF e o envio por e-mail ficam para o 10.13.
- A expiração é calculada na leitura (sem agendador).

## 10.4 Encomendas de venda

### Modelo

Migração `0057_create_sales_orders`:

- `sales_orders` — guarda:
  - entidade, cliente e versão dos dados do cliente na confirmação;
  - comercial, armazém, morada de entrega e orçamento de origem (único);
  - série e número, datas, moeda, prazo e referência;
  - os cinco estados separados, os motivos de aprovação e a verificação de crédito (`jsonb`);
  - os totais.

  A FK `sales_quotes.converted_order_id → sales_orders` passa a existir.

- `sales_order_lines` — quantidades encomendada, reservada, entregue, facturada e fechada (`CHECK` de coerência);
  indicação de stock ou serviço; preço e imposto como no orçamento; linha do orçamento de origem.
- `sales_order_deliveries` e linhas — expedições com chave e impressão digital do pedido, referência `número/En` e
  evento do Inventário. Só de acréscimo.
- `sales_order_events` — cronologia, só de acréscimo.

Gatilhos na base:

- conteúdo do cabeçalho e preços das linhas só mudam em rascunho; depois só as quantidades do cumprimento;
- número fixo depois de atribuído;
- fechada e anulada são finais;
- confirmada não volta a rascunho;
- nada se apaga.

### Backend e API (`/api/v1/sales/orders`)

- `GET /orders`, com os filtros estado, aprovação, entrega, cliente e pesquisa.
- `GET /orders/options`, `GET /orders/addresses/:customerId`, `GET /orders/search/{customers|products}`.
- `POST /orders`, `POST /orders/from-quote`, `GET|PATCH /orders/:id`.
- `POST /orders/:id/{submit|approve|reject|reserve|release|deliver|close|cancel}`.
- Permissões `sales.orders.read|manage|approve|fulfil`, com âmbito de empresa, entidade legal ou OWN. Anexos com o
  assunto `sales_order`. Auditoria `sales_order.*` na mesma transacção.
- Integração com o Inventário só pelos contratos `reserveForSale`, `releaseSaleReservation` e `deliverSale`
  (idempotentes, com a encomenda como referência).
- Erros:
  - `NO_LINES`, `NO_PRICE`, `NO_SERIES`, `SERIES_REQUIRED`;
  - `CUSTOMER_BLOCKED`, `SELF_APPROVAL`;
  - `NOTHING_TO_RESERVE`, `OVER_RESERVE`, `OVER_RESERVED` (do Inventário);
  - `OVER_DELIVERY`, `OVER_RELEASE`, `NOTHING_RESERVED`, `NOTHING_DELIVERED`, `IDEMPOTENCY_MISMATCH`;
  - `LINES_FROM_QUOTE`, `ALREADY_CONVERTED`, `NOT_ACCEPTED`, `KIT_NOT_SUPPORTED`;
  - `INVALID_STATE`, `VERSION_CONFLICT`, `OUT_OF_SCOPE`.

### Ecrãs (`/vendas/encomendas`)

- **Lista** — número, cliente, data, total, estado, aprovação, entrega e facturação.
- **Formulário** — entidade, cliente, armazém da entidade, morada de entrega do cliente (a por omissão é proposta),
  datas e comercial. As linhas só aparecem quando não há orçamento; numa encomenda vinda de orçamento, cliente,
  condições e linhas ficam bloqueados.
- **Ficha** — os cinco estados em distintivos; os motivos de aprovação e a verificação de crédito; linhas com as
  quantidades; expedições; anexos, cronologia e auditoria. Acções:
  - submeter (com série se houver várias), aprovar (outra pessoa, com confirmação) e devolver;
  - reservar e libertar (com confirmação);
  - expedir (quantidades por linha, propostas com o que falta);
  - fechar o resto e anular com motivo.
- **Orçamento aceite** — "Converter em encomenda" com escolha do armazém; depois, a ligação "Ver a encomenda".

### Testes e evidências

**Backend**

`tests/unit/sales_orders_domain.spec.ts` (4 testes):

- cabeçalho;
- estados derivados;
- limite de crédito;
- pedidos de expedição e reserva.

`tests/functional/sales_orders.spec.ts` (2 testes):

- **Crédito e aprovação:** stock e serviço; armazém obrigatório; limite de crédito (1 070 > 1 000) pendente; aprovação
  só por outra pessoa e confirmação numerada.
- **Reserva e expedição:** reserva no Inventário (saldo reservado = 5); expedição parcial idempotente (repetição e
  `IDEMPOTENCY_MISMATCH`); excesso recusado; saldo livre = 5.
- **Libertação e fecho:** libertação parcial; fecho do resto que liberta tudo (reservado = 0).
- **Imutabilidade na base.**
- **Conversão:** duas conversões simultâneas do mesmo orçamento (201 e 409); linhas bloqueadas; confirmação sem
  excepções.
- **Stock e expedições simultâneas:** `OVER_RESERVED` acima do livre; reserva parcial; anulação que liberta; duas
  expedições simultâneas sobre o mesmo resto, das quais só uma passa.
- **Cliente:** exposição com encomendas em aberto (456 + 456 = 912 > 500); devolução volta a editável; cliente
  bloqueado não expede.

Também cobertos:

- O teste do 10.3 passou a criar encomendas reais para a conversão (a FK existe).
- `isolation_matrix`: 8 tentativas sobre a encomenda, linha, orçamento e moradas de outra empresa, todas com 404;
  criação com entidade e cliente alheios recusada; a lista não mostra a encomenda alheia.
- `routes_protection`.

**Frontend:** `order-model.spec.ts`.

**Browser (`p1004`):** 7 passos.

- encomenda pela navegação com produto e serviço: 798,00;
- limite de 500 ultrapassado: aprovação pendente com o motivo e a exposição; quem submeteu não vê "Aprovar"; outra
  pessoa aprova e a encomenda fica numerada;
- reserva no Inventário: "Reservada";
- expedição de 3 de 4 mais o serviço: entrega parcial e referência `/E1`;
- fecho do resto com motivo;
- conversão do orçamento aceite (228,00), com a ligação ao orçamento; o orçamento fica "Convertido" e o botão
  desaparece;
- telemóvel sem deslocamento horizontal.

### Pendências

- Facturação a partir da encomenda (10.6): actualiza as quantidades facturadas e o estado de facturação.
- Contas a receber na exposição de crédito (10.10).
- Kits, lotes e séries escolhidos na expedição: o motor do Inventário escolhe por FEFO; as séries passam quando
  indicadas.
- Devoluções de clientes (10.8, com `returnFromSale`).
- Guia de transporte fiscal (10.5 e 10.6).

## 10.5 Motor fiscal e séries

### Verificação das fontes

A verificação está registada em D-063.

| Item                                                                      | Verificado                                           | Fonte                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Decreto Presidencial n.º 71/25 (20/03/2025), regime jurídico das facturas | Existência, âmbito e e-factura por software validado | Secundárias: EY, PwC, Cegid, Afriwise, Abreu Advogados  |
| Decreto Executivo n.º 683/25 (estrutura de dados / modelo)                | Existência                                           | Secundária                                              |
| Datas de entrada em vigor                                                 | **Não**: as fontes divergem                          | —                                                       |
| Especificação técnica da AGT (assinatura, hash, QR, séries, códigos)      | **Não obtida**                                       | —                                                       |
| Taxas e códigos de isenção                                                | **Não configurados**                                 | A empresa introduz e confirma a partir da fonte oficial |

Fontes consultadas: [EY — Novo Regime Jurídico das Facturas](https://www.ey.com/pt_ao/technical/tax-alerts/novo-regime-juridico-das-facturas),
[EY — Facturação Electrónica a partir de 1 de Janeiro de 2026](https://www.ey.com/pt_ao/technical/tax-alerts/facturacao-electronica-a-partir-de-1-de-janeiro-de-2026),
[PwC — Implementação de facturas electrónicas](https://www.pwc.com/ao/pt/servicos/advisory/consulting/facturacao-electronica.html),
[Cegid — Facturação electrónica](https://www.cegid.com/ao/blog/obrigatoriedade-faturacao-eletronica-angola/),
[Afriwise — Angola: New Invoicing Rules](https://www.afriwise.com/blog/angola-new-invoicing-rules),
[Abreu Advogados — Novidades Fiscais 2026](https://abreuadvogados.com/wp-content/uploads/2026/02/NL-Novidades-Fiscais-e-Legais-para-o-ano-de-2026-PT.pdf).

### Modelo

Migração `0058_create_fiscal_engine`:

- `tax_codes` — país, código, nome, natureza (imposto ou retenção), tipo, estado.
- `tax_rates` — taxa (4 casas), do país ou de uma entidade, vigência, base mínima (retenções) e fonte legal obrigatória.
  Rascunho → confirmada → retirada. A base exige que quem confirma não seja quem preparou.
- `tax_exemptions` — código e descrição como na fonte, fonte legal; mesma confirmação.
- `tax_settings` — nível de arredondamento por entidade.
- `fiscal_series` — entidade, tipo de documento, código fiscal, série, ano, prefixo, dígitos, próximo número, última
  data de emissão, referência manual à autoridade. `mode = 'SIMULATION'` obrigatório (`CHECK`).
- `fiscal_numbers` — número atribuído (único por série e por documento), só de acréscimo.

Gatilhos na base:

- valores confirmados ou retirados não mudam nem se apagam;
- retirado é final;
- a série só avança de um em um, fixa a configuração ao activar e, fechada, é final.

### Backend e API (`/api/v1/sales/fiscal`)

- Impostos e taxas:
  - `GET|POST /tax-codes`, `GET|PATCH /tax-codes/:id`, `POST /tax-codes/:id/rates`;
  - `PATCH|DELETE /tax-rates/:id`, `POST /tax-rates/:id/{confirm|retire}`.
- Isenções: `GET|POST /exemptions`, `PATCH /exemptions/:id`, `POST /exemptions/:id/{confirm|retire}`.
- Arredondamento: `GET /settings`, `PUT /settings/:legalEntityId`.
- Séries:
  - `GET|POST /series`, `PATCH /series/:id`, `POST /series/:id/{activate|close}`;
  - `GET /series/:id/numbers`.
- Simulação: `POST /simulate`.
- Contratos para 10.6+: `resolveTaxes(scope, {legalEntityId, date, lines})` e
  `allocateFiscalNumber(scope, {seriesId, legalEntityId, documentKind, issueDate, documentType, documentId})`.
- Permissões `sales.fiscal.read|manage|confirm`. Auditoria `tax_code.*`, `tax_rate.*`, `tax_exemption.*`,
  `tax_settings.updated` e `fiscal_series.*`.
- Erros:
  - `SELF_CONFIRMATION`, `OVERLAP`, `NO_RATE`, `EXEMPTION_REQUIRED`, `NOT_APPLICABLE`, `COUNTRY_MISMATCH`;
  - `SERIES_NOT_ACTIVE`, `SERIES_MISMATCH`, `ISSUE_DATE`, `ALREADY_NUMBERED`, `NOT_AVAILABLE` (modo de produção);
  - `CODE_TAKEN`, `INVALID_STATE`, `VERSION_CONFLICT`.

### Ecrãs (`/vendas/fiscal`)

- **Impostos e retenções** — lista e criação; arredondamento por entidade.
- **Ficha do imposto** — taxas por vigência com fonte legal, quem preparou e quem confirmou. Editar e apagar só em
  rascunho. Confirmar pede outra pessoa e lembra a fonte; retirar exige motivo. Auditoria.
- **Motivos de isenção** — preparar, confirmar por outra pessoa, retirar.
- **Séries fiscais** — aviso de simulação, criar, editar (rascunho), activar com confirmação, fechar com motivo e ver
  os números atribuídos.
- **Simulação fiscal** — linhas com base, impostos e motivo de isenção. Mostra o resumo por imposto, os totais (com
  retenção e a pagar) e as taxas usadas com a fonte.

### Testes e evidências

**Backend**

`tests/unit/sales_fiscal_domain.spec.ts` (5 testes), com valores ilustrativos e não legais:

- validação;
- sequência cronológica;
- linha e documento iguais sem meios cêntimos;
- meios cêntimos: 0,03 por linha contra 0,02 por documento;
- vários impostos por linha;
- retenção com base mínima.

`tests/functional/sales_fiscal.spec.ts` (2 testes):

- **Taxas:** fonte obrigatória; rascunho não conta; quem prepara não confirma (`SELF_CONFIRMATION`); outra pessoa
  confirma; confirmada não muda pela API nem na base; `OVERLAP`; a taxa escolhe-se pela vigência na data.
- **Isenção e retenção:** 0 % sem isenção confirmada recusado; retenção acima e abaixo da base mínima.
- **Arredondamento e retirada:** arredondamento por documento contra por linha; retirada que deixa de valer.
- **Séries:** só simulação; configuração fixa ao activar; 20 atribuições simultâneas em duas séries dão 1..10 em cada,
  sem saltos nem repetições.
- **Números:** uma emissão falhada não gasta o número; recusa de data anterior, ano errado, tipo errado e documento
  repetido.
- **Protecção na base:** recuar, saltar, alterar o registo ou passar a produção é recusado; fechar com motivo.

Também cobertos:

- `isolation_matrix`: 11 tentativas sobre o imposto, taxa, isenção, série e arredondamento de outra empresa, todas
  com 404; simulação e série com a entidade alheia recusadas; a lista de séries não mostra as alheias.
- `routes_protection`.

**Frontend:** `fiscal-model.spec.ts`.

**Browser (`p1005`):** 7 passos.

- imposto pela navegação e taxa com fonte obrigatória;
- quem preparou não vê "Confirmar"; outra pessoa confirma;
- isenção confirmada por outra pessoa;
- simulação com o aviso visível: a linha a 0 % sem isenção é recusada, e com a isenção dá 150,00 de líquido e 160,00
  de total, com a fonte mostrada;
- série criada em simulação e activada, ainda sem números;
- telemóvel sem deslocamento horizontal.

### Pendências e bloqueios

- **Bloqueio:** a operação real exige o texto oficial (Diário da República), a especificação técnica da AGT e
  software certificado. Até lá, só simulação.
- Os documentos fiscais (10.6–10.8) vão usar `resolveTaxes` e `allocateFiscalNumber`. O imposto por linha de
  orçamentos e encomendas passará a vir do motor no 10.6.
- Contingência e comunicação com a AGT ficam para o 10.9, com adaptador e simulador identificado.

## 10.6 Factura

### Modelo

Migração `0059_create_sales_invoices`:

- `sales_invoices` — guarda:
  - entidade emitente e estabelecimento;
  - série fiscal, número sequencial e formatado (únicos);
  - cliente, versão dos dados e fotografia (nome, NIF, morada);
  - encomenda de origem;
  - data, vencimento, moeda, moeda funcional e câmbio;
  - prazo, referência e notas;
  - os três estados e o nível de arredondamento;
  - totais (líquido, imposto, bruto, retenção, a pagar, pago) e resumo dos impostos (`jsonb`);
  - impressão digital, emissão e motivo do descarte.

  `CHECK`s de coerência: bruto = líquido + imposto, a pagar = bruto − retenção, pago ≤ a pagar, e todos os campos da
  emissão presentes numa emitida.

- `sales_invoice_lines` — produto/variante, descrição, quantidade, unidade, desconto ou preço manual, origem e preço,
  desconto efectivo, valor líquido, códigos de imposto (`uuid[]`), isenção, imposto, impostos por linha (`jsonb`),
  fotografia do preço e linha da encomenda.
- `sales_invoice_events` — cronologia, só de acréscimo.

Gatilhos na base: a emitida não muda nem se apaga (só o estado fiscal, a cobrança e a passagem a corrigida); as linhas
só mudam em rascunho; a descartada é final.

### Backend e API (`/api/v1/sales/invoices`)

- `GET /invoices`, com os filtros estado, fiscal, cobrança (incluindo `OVERDUE`), cliente, encomenda e pesquisa.
- `GET /invoices/options`, `GET /invoices/search/{customers|products}`, `GET /invoices/order-draft/:orderId`.
- `POST /invoices` (com `orderId` para facturar a encomenda), `GET|PATCH /invoices/:id`.
- `POST /invoices/:id/{issue|discard}`.
- Contratos da encomenda: `invoiceableOrder` e `recordInvoiced` (no módulo, chamados na emissão).
- Permissões `sales.invoices.read|manage|issue` por entidade legal. Anexos com o assunto `sales_invoice`. Auditoria
  `sales_invoice.*` na mesma transacção.
- Erros:
  - `STOCK_NEEDS_ORDER`, `OVER_INVOICED`, `PRICING_APPROVAL_REQUIRED`, `NO_PRICE`, `NO_LINES`;
  - `NO_RATE` (câmbio), `NO_RATE` e `EXEMPTION_REQUIRED` (fiscais), `FUTURE`;
  - `NO_SERIES`, `SERIES_REQUIRED`, `ALREADY_ISSUED`, `CUSTOMER_BLOCKED`;
  - `INVALID_STATE`, `VERSION_CONFLICT`, `OUT_OF_SCOPE`.

### Ecrãs (`/vendas/facturas`)

- **Lista** — número, cliente, datas, a pagar, estado e cobrança (com "Vencida"); filtro fiscal.
- **Formulário** — factura de serviços: entidade, estabelecimento, cliente, data, moeda e prazo; linhas com serviço,
  quantidade, desconto, impostos do país da entidade e motivo de isenção. Numa factura de encomenda, ajusta-se só a
  quantidade e os impostos.
- **Ficha** — aviso de simulação; os três estados; emitente e série; cliente fotografado; data e vencimento, moeda e
  câmbio, origem; linhas com unidade, preço, desconto e impostos; resumo dos impostos; totais; impressão digital
  interna. Acções: emitir (com série se houver várias) e descartar com motivo. Anexos, cronologia e auditoria.
- **Encomenda** — "Facturar o entregue": quantidades por facturar e impostos por linha (com sugestão) → rascunho da
  factura.

### Testes e evidências

**Backend**

`tests/unit/sales_invoices_domain.spec.ts` (4 testes):

- validação e origem;
- valores exactos: linha, desconto efectivo, vencimento;
- vencida calculada;
- impressão digital canónica.

`tests/functional/sales_invoices.spec.ts` (2 testes):

- **Factura de serviços:**
  - produto de stock sem encomenda e 0 % sem isenção recusados;
  - impostos do motor: 2 × 400 + 10 %, mais 500 isento, dá 1 380,00;
  - desconto sem limite não se emite; emissão por quem não tem `issue` recusada;
  - emitida com `FT A/1`, fiscal pendente, por pagar, vencimento a 30 dias, câmbio 1, cliente fotografado e impressão
    digital;
  - segunda emissão `ALREADY_ISSUED`; editar ou descartar recusados; base recusa alterar, voltar a rascunho e apagar;
  - cliente renomeado depois mantém a fotografia;
  - 5 emissões simultâneas dão `FT A/2..6`;
  - descarte com motivo, data futura e sem linhas recusados.
- **Factura da encomenda:**
  - o rascunho da encomenda propõe o imposto;
  - facturar acima do entregue é recusado; 3 + serviço emitida, e a encomenda fica com facturação parcial;
  - depois de nova entrega, dois rascunhos sobre as mesmas 2 unidades emitidos em simultâneo: um passa, o outro é
    recusado e não gasta número (série 1, 2);
  - a encomenda fica toda facturada e fechada.

Também cobertos:

- `isolation_matrix`: 6 tentativas sobre a factura e a encomenda de outra empresa, todas com 404; criação com entidade
  e cliente alheios recusada; a lista não mostra a factura alheia.
- `routes_protection`.

**Frontend:** `invoice-model.spec.ts`.

**Browser (`p1006`):** 6 passos.

- "Facturar o entregue" na encomenda: rascunho com 3 + serviço = 880,00 e aviso de simulação;
- emissão: número da série em simulação, "Fiscal: pendente", "Por pagar", NIF do cliente com "Dados fiscais como na
  emissão", imposto no resumo, sem editar, emitir ou descartar;
- a encomenda mostra "Facturação parcial" e "Facturada" na cronologia, sem mais nada por facturar;
- factura de serviços pela navegação (1 100,00) descartada com motivo;
- telemóvel sem deslocamento horizontal.

### Pendências

- Recibos e cobrança (10.7); notas de crédito e débito e o estado "corrigida" (10.8); estado fiscal real e
  contingência (10.9); eventos contabilísticos (10.12); PDF (10.13).
- O imposto por linha de orçamentos e encomendas continua a ser uma taxa; a factura liga-a aos códigos do motor fiscal.

## 10.7 Factura-recibo e recibos

### Modelo

Migração `0060_create_sales_receipts`:

- `sales_invoices.document_kind`: `INVOICE` ou `INVOICE_RECEIPT`, fixo depois do rascunho. Um gatilho também impede
  que o valor pago desça.
- `sales_receipts` — guarda:
  - entidade, cliente, finalidade (recibo ou factura-recibo) e a factura-recibo;
  - moeda, valor, meio (numerário, transferência, cartão, cheque, outro), conta bancária, referência e data;
  - chave e impressão digital do pedido;
  - estado `PENDING → CONFIRMED | REJECTED | CANCELLED`;
  - série, número fiscal e formatado;
  - afectado, adiantamento e adiantamento usado;
  - quem confirmou (≠ quem registou), quando e motivo.

  `CHECK`s de coerência, chave única por entidade, número único por série e um único recebimento activo por FR.

- `sales_receipt_allocations` — afectações às facturas; só se inserem com o recibo pendente e são só de acréscimo.
- `sales_advance_applications` — usos do adiantamento, só de acréscimo.

### Backend e API (`/api/v1/sales/receipts`)

- `GET /receipts` (filtros estado, cliente, com adiantamento, pesquisa), `GET /receipts/options`,
  `GET /receipts/search/customers`, `GET /receipts/open-items/:legalEntityId/:customerId`.
- `POST /receipts`, `GET /receipts/:id`, `POST /receipts/:id/{confirm|reject|cancel|apply-advance}`.
- Contratos na factura: `issueDraft` (emissão partilhada com a FR), `applyInvoicePayment` (bloqueio, `OVER_PAYMENT`,
  cobrança, evento `PAYMENT`). `POST /invoices` aceita `documentKind`; a ficha da factura devolve `payments`.
- Permissões `sales.receipts.read|manage|confirm` por entidade legal; anexos `sales_receipt`; auditoria
  `sales_receipt.*` na mesma transacção.
- Erros:
  - `SELF_CONFIRMATION`, `OVER_ALLOCATED`, `OVER_PAYMENT`, `OVER_ADVANCE`;
  - `AMOUNT_MISMATCH`, `FR_NEEDS_PAYMENT`, `FR_PENDING`;
  - `IDEMPOTENCY_MISMATCH`, `SERIES_REQUIRED`, `NO_SERIES`;
  - `INVALID_STATE`, `VERSION_CONFLICT`, `OUT_OF_SCOPE`.

### Ecrãs (`/vendas/recebimentos`)

- **Lista** — número, cliente, data, valor, meio e estado.
- **Registar** — entidade, cliente, tipo, valor, data, meio, conta e referência. As facturas por receber do cliente
  aparecem com "Tudo", e o ecrã mostra o afectado e o que fica como adiantamento. Para uma factura-recibo, escolhe-se
  o rascunho e o valor fica fixado.
- **Ficha** — estado, valores, meio, conta e referência, quem registou e quem confirmou. Acções:
  - confirmar (só outra pessoa; série se houver várias; aviso de simulação);
  - recusar ou anular com motivo;
  - usar o adiantamento numa factura.

  A ficha mostra as afectações, as aplicações e o saldo do adiantamento, mais anexos e auditoria.

- **Factura** — o tipo (Factura / Factura-recibo) escolhe-se na criação. A FR em rascunho não tem "Emitir" e liga a
  "Registar o recebimento". A ficha lista os recebimentos e o valor pago.

### Testes e evidências

**Backend:** `tests/functional/sales_receipts.spec.ts` (2 testes).

- **Recibo:**
  - validações de meio, conta e referência; afectação acima do valor por receber, acima do valor recebido ou a uma
    factura não emitida recusada;
  - idempotência: o mesmo pedido devolve o mesmo registo, e um corpo diferente dá `IDEMPOTENCY_MISMATCH`;
  - antes da confirmação nada é abatido; quem registou não confirma (`SELF_CONFIRMATION`);
  - confirmado `RC A/1`: A paga, B parcial, 600 de adiantamento;
  - uso do adiantamento acima do saldo recusado; duas aplicações simultâneas — uma passa;
  - a base recusa alterar o confirmado e as afectações;
  - recusa com motivo sem efeito nas facturas.
- **Factura-recibo:**
  - emissão directa `FR_NEEDS_PAYMENT`; valor diferente `AMOUNT_MISMATCH`; segundo registo `FR_PENDING`;
  - confirmada: `FR A/1` paga;
  - uma confirmação falhada não gasta número; a seguinte é `FR A/2`.

Também cobertos:

- `isolation_matrix`: 6 tentativas sobre o recebimento de outra empresa, todas com 404; registo com entidade alheia
  recusado.
- `routes_protection`.

**Frontend:** `receipt-model.spec.ts` (somas exactas em bigint).

**Browser (`p1007`):** 7 passos.

- preparação: imposto confirmado, séries FT/RC/FR em simulação e três facturas;
- registo de 3 000,00: A toda, B 1 500,00, 400,00 de adiantamento, "Por confirmar", sem confirmar para quem registou,
  facturas por abater;
- a tesouraria confirma: número `RC`, A "Paga" com o recibo na ficha, B "Paga em parte" com 1 500,00, 400,00
  disponíveis;
- adiantamento usado na factura D: disponível 0,00, sem mais acção, D parcial com 400,00;
- factura-recibo: sem "Emitir"; "Registar o recebimento" com o valor fixado; continua rascunho até à confirmação;
  depois número `FR` e "Paga";
- recusa com motivo, sem efeito na factura;
- telemóvel sem deslocamento horizontal.

### Pendências

- A regra "conforme regime" (que documento cada regime exige) por verificar no texto oficial e na especificação da AGT;
  as séries continuam em simulação (D-063, D-065).
- A confirmação é manual até à Tesouraria/conciliação bancária (Prompt 11). Estornos de recebimentos confirmados e
  devolução de adiantamentos ficam para as notas de crédito (10.8) e a Tesouraria. A contabilização é do 10.12 e o PDF
  do 10.13.

## 10.8 Notas de crédito e débito, devolução física e reembolso

São três documentos distintos (D-066):

- **Devolução física**: na encomenda, entra no stock.
- **Correcção fiscal**: a nota, sobre a factura.
- **Reembolso financeiro**: confirmado por outra pessoa.

### Modelo

Migração `0061_create_sales_notes`:

- `sales_invoices` ganha `credited_total` e `debited_total`. Um gatilho impede que desçam. O `CHECK` passa a ser
  `pago + creditado ≤ a pagar + debitado`.
- `sales_order_lines` ganha `returned_qty` e `return_credited_qty`, ambas com `CHECK`: nunca acima do expedido nem do
  facturado.
- `sales_returns` e `sales_return_lines`:
  - referência `<encomenda>/D<n>`, data, armazém e motivo;
  - evento de stock do Inventário;
  - chave e impressão digital do pedido;
  - só de acréscimo.
- `sales_notes` — guarda:
  - tipo (crédito ou débito), a factura original, a entidade e o cliente;
  - a devolução ligada;
  - código e descrição do motivo, e a data;
  - moeda, moeda funcional e câmbio, como na factura;
  - a versão e a fotografia do cliente, e o nível de arredondamento;
  - estado (rascunho, emitida, descartada) e estado fiscal;
  - série e número;
  - totais e resumo dos impostos;
  - crédito aplicado e reembolsado;
  - impressão digital, emissão e motivo do descarte.

  `CHECK`s de coerência. A base impede que a nota de crédito seja emitida por quem a criou. Emitida, é imutável.

- `sales_note_lines` — a linha da factura, o modo (quantidade ou valor), a quantidade, o valor líquido, o imposto e os
  impostos usados. Só mudam em rascunho.
- `sales_note_applications` — crédito abatido em facturas. Só de acréscimo.
- `sales_refunds` — reembolso:
  - valor, meio, conta, referência e data;
  - chave e impressão digital do pedido;
  - estado: pendente, confirmado, recusado ou anulado;
  - quem confirma tem de ser diferente de quem registou.

  Depois de decidido, não muda.

### Backend e API

- `POST /sales/orders/:id/returns` (permissão `sales.orders.fulfil`): devolução idempotente pelo contrato
  `returnFromSale`. O devolvido deixa de ser facturável; o devolvido que uma nota ligada creditou volta a contar.
- `/sales/notes`:
  - `GET` lista, `GET options`, `GET search/invoices`;
  - `GET eligible/:invoiceId`: o que resta por linha e as devoluções da encomenda;
  - `POST` cria, `GET|PATCH :id`;
  - `POST :id/{issue|discard|apply-credit|refunds}`.
- `/sales/refunds/:id/{confirm|reject|cancel}`.
- Contratos na factura e na encomenda:
  - `invoiceForNote` e `adjustInvoice`: a factura passa a corrigida, o crédito abate até ao que está em dívida e o
    débito aumenta-a;
  - `returnForNote` e `recordReturnCredit`.
- Recibos e adiantamentos do 10.7 passam a usar o valor em dívida, que inclui créditos e débitos.
- Permissões novas `sales.notes.read|manage|issue`. O reembolso usa `sales.receipts.manage|confirm`.
- Anexos com o assunto `sales_note`. Auditoria `sales_note.*`, `sales_refund.*` e `sales_order.returned`.
- Erros:
  - `OVER_CREDIT`, `OVER_RETURNED`, `OVER_RETURN`, `NOTHING_TO_CREDIT`, `NOT_STOCK`;
  - `SELF_ISSUE`, `SELF_CONFIRMATION`, `OVER_REFUND`;
  - `INVOICE_NOT_ISSUED`, `BEFORE_INVOICE`, `FUTURE`;
  - `IDEMPOTENCY_MISMATCH`, `SERIES_REQUIRED`, `NO_SERIES`.

### Ecrãs

- **Encomenda** — "Devolução de mercadoria": quantidades por linha de stock, data e motivo. Mostra a coluna
  "Devolvida" e a lista de devoluções.
- **Factura** — botões "Nota de crédito" e "Nota de débito". Secção "Correcções". Balanço: a pagar, débitos,
  créditos, recebido e em dívida.
- **Notas** (`/vendas/notas`) — lista com filtros por tipo, estado e crédito disponível.
- **Formulário da nota** — a factura original (fixa quando vem da factura), o motivo do tipo, a descrição, a data e a
  devolução ligada. Por linha: o que resta e a correcção por quantidade ou valor. O débito é só por valor.
- **Ficha da nota**:
  - aviso de simulação, a factura e a devolução, o motivo, o cliente como na factura, a moeda e o câmbio;
  - linhas com os impostos originais e os totais;
  - acções: emitir (outra pessoa, para crédito; série se houver várias) e descartar;
  - crédito: abatido, reembolsado, pendente e disponível; usar o crédito noutra factura; registar reembolso;
  - por reembolso: confirmar, recusar ou anular;
  - anexos e auditoria.

### Testes e evidências

**Backend**

`tests/unit/sales_notes_domain.spec.ts` (3 testes):

- cabeçalho e linhas;
- elegível exacto: o resto todo credita o valor que falta; nunca acima;
- impostos originais e retenção aplicada;
- estado de cobrança com créditos e débitos.

`tests/functional/sales_notes.spec.ts` (2 testes):

- **Notas e reembolso:**
  - motivo do outro tipo, quantidade acima do facturado e valor acima do líquido recusados; factura em rascunho
    `INVOICE_NOT_ISSUED`;
  - crédito de 1 unidade a 550,00 com a taxa da linha original e a fotografia do cliente;
  - quem preparou não emite (`SELF_ISSUE`); emitida `NC A/1`; a factura fica corrigida com 550,00 em dívida e o
    conteúdo intacto;
  - elegível 1 unidade e 500,00;
  - duas emissões simultâneas do mesmo resto: uma passa, a outra é recusada sem gastar número (`NC A/2`);
  - nota de débito por valor (`ND A/1`, 110,00); débito por quantidade recusado; dívida 660,00;
  - factura paga por recibo e depois creditada em 220,00: tudo fica como crédito;
  - 100,00 usados noutra factura;
  - reembolso acima do disponível `OVER_REFUND`; transferência sem referência recusada; idempotente; o pendente
    reserva o crédito; confirmado por outra pessoa;
  - a base recusa alterar ou apagar a nota emitida, as linhas, as aplicações, a descida dos totais e a alteração do
    reembolso.
- **Devolução física:**
  - serviço `NOT_STOCK`; acima do expedido recusado;
  - devolução 1: stock de 7 para 8; idempotente; outra chave com outro corpo recusada; a factura não muda;
  - nota ligada à devolução: 2 recusadas, 1 aceite (110,00); a factura fica com 770,00 em dívida;
  - nova expedição e nova devolução antes de facturar: 1 facturável;
  - facturada, a encomenda fica toda facturada e fechada;
  - a base recusa apagar ou alterar devoluções e passar o devolvido.

Também cobertos:

- `isolation_matrix`: 8 tentativas sobre a nota, a factura e a encomenda de outra empresa (consultar, alterar,
  emitir, descartar, crédito, reembolso, elegível, devolução), todas com 404; criação recusada; a lista não mostra a
  nota alheia.
- `routes_protection`.

**Frontend:** `note-model.spec.ts`.

**Browser (`p1008`):** 7 passos.

- preparação: imposto, séries FT/NC/ND/RC, encomenda expedida e facturada (880,00);
- devolução de 1 unidade pela encomenda; a factura não muda;
- nota de crédito a partir da factura, ligada à devolução: 2 recusadas na linha, 1 aceite; rascunho de 110,00; quem
  preparou não vê "Emitir";
- outra pessoa emite: número NC, aviso de simulação; a factura fica "Corrigida" com 770,00 em dívida e a nota listada;
- nota de débito na linha do serviço, só por valor (50 + 10 %): ND, dívida 825,00;
- factura paga; nova nota de crédito de 110,00 fica disponível; reembolso registado (disponível 0,00; quem registou
  não confirma); outra pessoa confirma: "Pago";
- lista das notas e telemóvel sem deslocamento horizontal.

### Pendências

- O tratamento das notas na especificação da AGT continua por verificar (D-063, D-066); as séries ficam em simulação.
- Contabilização das notas, devoluções e reembolsos (10.12).
- Conciliação bancária dos reembolsos (Prompt 11).
- PDF das notas (10.13).
- Devolução para quarentena ou bloqueado: o contrato do Inventário hoje devolve para livre.

## 10.9 Integração fiscal electrónica (simulação)

Só simulação: nada é enviado à AGT. O portal técnico da AGT não é acessível a partir deste ambiente, por isso a
especificação oficial não foi lida (D-067). O adaptador oficial está registado e bloqueado.

### Modelo

Migração `0062_create_fiscal_integration`:

- `fiscal_integration_settings` — por entidade:
  - o fornecedor: só o simulador; o oficial é recusado;
  - o cenário do simulador e o máximo de tentativas;
  - a contingência, com motivo e data.
- `fiscal_submissions` — uma por documento:
  - o payload `SG-SIM-1` fotografado e a sua impressão digital;
  - a chave de idempotência;
  - o estado: `QUEUED`, `SENDING`, `AWAITING`, `ACCEPTED`, `REJECTED`, `FAILED`, `INVALID` ou `CONTINGENCY`;
  - as tentativas e as falhas seguidas, e a próxima tentativa;
  - o identificador do pedido e a resposta;
  - os erros da validação local e a marca de contingência.

  Gatilhos: o payload, a chave e o fornecedor não mudam; a decisão final não volta atrás; não se apaga.

- `fiscal_submission_attempts` — validação, envio, consulta, reposição e contingência, com o código, a mensagem e a
  duração. Só de acréscimo.
- `fiscal_simulator_requests` — o "servidor" do simulador, por chave de idempotência.

### Backend e API (`/api/v1/sales/fiscal`)

- `GET integration`: fornecedores com a disponibilidade, cenários e definições por entidade, com contagens.
- `PUT integration/:legalEntityId`; `POST integration/:legalEntityId/contingency`.
- `GET submissions` (filtros estado, tipo, número); `GET submissions/:id`;
  `GET submissions/document/:type/:documentId`.
- `POST submissions/process` (a fila vencida das entidades que gere); `POST submissions/:id/process`;
  `POST submissions/:id/requeue`.
- `enqueueFiscalDocument` é chamado na emissão da factura, da factura-recibo e da nota.
- `processFiscalQueue` serve o comando `node ace fiscal:process` (agendador, todos os tenants).
- Permissões `sales.fiscal.read|manage` no âmbito da entidade. Auditoria `fiscal_integration.*` (definições e
  contingência) e `fiscal_submission.*` (aceite, rejeitada, repetida).
- Erros: `PROVIDER_UNAVAILABLE`, `INVALID_STATE`, `VERSION_CONFLICT`, `OUT_OF_SCOPE`, `VALIDATION_ERROR`.

### Ecrãs

- **Integração fiscal** (`/vendas/fiscal/integracao`):
  - aviso de simulação;
  - por entidade: o fornecedor (o oficial aparece desactivado, com o motivo), o cenário, as tentativas, a
    contingência com motivo e as contagens;
  - a fila com filtros e "Processar a fila".
- **Comunicação** (`/vendas/fiscal/submissoes/:id`):
  - estado, documento, ambiente e formato ("interno, não oficial");
  - tentativas, pedido, resposta, chave e erros de validação;
  - "Processar agora" e "Repetir" com motivo;
  - histórico das tentativas e o payload fotografado.
- **Factura e nota** — ligação "Comunicação: <estado>".

### Testes e evidências

**Backend**

`tests/unit/sales_fiscal_integration_domain.spec.ts` (2 testes):

- validação local: totais, NIF, data, isenção, referência da nota e retenção;
- espera crescente com tecto;
- adaptador oficial indisponível.

`tests/functional/sales_fiscal_integration.spec.ts` (2 testes):

- **Fila e simulador:**
  - o oficial é recusado; quem só consulta não configura nem processa;
  - emissão → `QUEUED` com o payload interno (FT, número, NIF, 550,00);
  - processar: envio e consulta, `ACCEPTED` `SIM-000`, factura "aceite";
  - cenário rejeitar: `REJECTED` `SIM-422`, sem repetição;
  - indisponível com 2 tentativas: `QUEUED` com espera (o periódico não lhe toca), depois `FAILED`; a repetição exige
    motivo; repetida → `ACCEPTED`;
  - atraso: `AWAITING` e depois `ACCEPTED`;
  - resposta perdida: o reenvio com a mesma chave devolve o mesmo pedido (1 registo no simulador);
  - envio interrompido retomado depois do prazo;
  - dois processamentos em paralelo: um só envio por documento;
  - a base recusa alterar o payload, voltar atrás na decisão e apagar submissões ou tentativas.
- **Contingência e notas:**
  - activar sem motivo é recusado;
  - factura retida em `CONTINGENCY`; o processamento não a envia;
  - terminar liberta 1; a factura é aceite com a marca de contingência e o histórico
    contingência → reposição → envio → consulta;
  - nota de crédito na fila (NC com referência e 110,00), aceite;
  - lista filtrada; auditoria.

Também cobertos:

- `isolation_matrix`: 6 tentativas sobre a submissão e a entidade de outra empresa (consultar, por documento,
  processar, repetir, configurar, contingência), todas com 404; a lista não mostra a submissão alheia; a fila de B não
  processa a de A.
- `routes_protection`.
- O comando `node ace fiscal:process` foi corrido na base de desenvolvimento.

**Frontend:** `fiscal-integration-model.spec.ts`.

**Browser (`p1009`):** 5 passos.

- preparação;
- página com o aviso de simulação e o adaptador oficial desactivado; cenário "indisponível" com 2 tentativas;
- factura → "Comunicação: Na fila" → payload `SG-SIM-1`; processar: `SIM-503` e depois "Falhou"; com o cenário
  "aceitar", repetir com motivo (sem motivo é recusado), "A aguardar" e depois "Aceite (simulação)"; a factura fica
  "Fiscal: aceite";
- contingência activada com motivo → factura "contingência" e "Retida em contingência" → terminada (de volta à fila)
  → processada → aceite com "Emitido em contingência";
- telemóvel sem deslocamento horizontal.

### Pendências

- Ler e verificar a especificação oficial da AGT (o portal não é acessível a partir deste ambiente), certificar o
  software e implementar o adaptador oficial com credenciais e assinatura guardadas com segurança. Até lá nada é
  enviado.
- Agendar `fiscal:process` na infra-estrutura (cron) quando houver ambiente de produção.
- QR e impressão (10.13). Contabilização (10.12).

## 10.10 Cobranças

Não há módulo Finanças (Prompt 11). As contas a receber são um contrato calculado dos documentos de venda, sem livro
provisório (D-068).

### Modelo

Migração `0063_create_collections`:

- `collection_promises` — entidade, cliente, moeda, valor, data prometida, facturas (`uuid[]`), quem prometeu e
  notas; anulação com motivo. Um gatilho só deixa anular; o resto é fixo e nada se apaga.
- `collection_activities` — tipo, pessoa, resultado, notas, próxima acção e promessa ligada. Só de acréscimo.

### Backend e API

- Contratos:
  - `customerReceivables`: facturas em dívida com vencimento, atraso e antiguidade; adiantamentos e crédito de notas
    por usar; resumo por entidade e moeda;
  - `creditExposure`: exposição na moeda do cliente.
- O limite de crédito da encomenda passa a somar as contas a receber líquidas (`creditCheck.receivables`).
- Rotas:
  - `GET /sales/collections` — lista de cobrança, com filtros (só vencidos, entidade, cliente);
  - `GET /sales/collections/:customerId` — extracto: limite e exposição, contactos do terceiro, contas a receber,
    promessas com o estado calculado, contactos de cobrança;
  - `POST /sales/collections/:customerId/promises`;
  - `POST /sales/collections/:customerId/activities`;
  - `POST /sales/collection-promises/:id/cancel`.
- Permissões novas `sales.collections.read|manage`. Auditoria `collection.*`.
- Erros: `OVER_PROMISE`, `NOTHING_OWED`, `INVALID_STATE`, `VALIDATION_ERROR`, `OUT_OF_SCOPE`.

### Ecrãs

- **Cobranças** (`/vendas/cobrancas`) — lista: cliente, entidade, em dívida, vencido, maior atraso, último contacto,
  próxima acção, promessas. Filtro "só com vencido".
- **Ficha do cliente:**
  - limite, a receber líquido, encomendas por facturar, exposição, disponível e contactos;
  - por entidade e moeda: em dívida, vencido, antiguidade, adiantamentos, crédito e líquido;
  - facturas em dívida com a antiguidade;
  - adiantamentos e notas com crédito;
  - promessas, com o estado e a anulação com motivo;
  - contactos;
  - acções "Registar promessa" (facturas opcionais) e "Registar contacto".

### Testes e evidências

**Backend**

`tests/unit/sales_collections_domain.spec.ts` (3 testes):

- atraso e antiguidade nos limites dos intervalos;
- estados da promessa;
- validação de promessas e contactos.

`tests/functional/sales_collections.spec.ts` (2 testes):

- **Contas a receber e limite:**
  - sem permissão, 403;
  - 3 facturas de 550 (há 100 e 40 dias, e hoje): em dívida 1 650, vencido 1 100, antiguidade 550/550/550, limite
    2 000;
  - recibo de 700 confirmado: em dívida 1 100, vencido 550, adiantamento 150, líquido 950;
  - facturas com antiguidade e 10 dias de atraso;
  - exposição 950 e disponível 1 050;
  - encomenda de 1 100: aprovação por exceder (a receber 950, exposição 2 050);
  - filtro "só com vencido".
- **Promessas e contactos:**
  - leitor 403; data passada e valor acima do devido recusados;
  - promessa em aberto, sem mudar saldos nem o pago da factura;
  - recebimento confirmado → cumprida (550);
  - promessa com a data passada → falhada; não se anula; contada na lista;
  - anulação exige motivo → anulada;
  - contacto com próxima acção e promessa; data passada recusada; reflectido na lista e no extracto;
  - a base recusa alterar ou apagar promessas e contactos;
  - auditoria.

Também cobertos:

- `isolation_matrix`: 4 tentativas sobre o cliente e a promessa de outra empresa, todas com 404.
- `routes_protection`.
- `sales_orders.spec.ts` continua a passar com o novo cálculo da exposição.

**Frontend:** `collections-model.spec.ts`.

**Browser (`p1010`):** 6 passos.

- preparação: cliente com limite 2 000 e facturas de 550 (vencida há 10 dias e por vencer);
- lista → ficha: em dívida 1 100,00, vencido 550,00, "1–30 dias (10 d)", exposição 1 100,00, disponível 900,00;
- promessa na factura vencida: "Em aberto", a dívida mantém-se; contacto "Prometeu pagar" com próxima acção;
- recebimento confirmado: promessa "Cumprida", dívida 550,00, vencido 0,00;
- promessa anulada com motivo;
- telemóvel sem deslocamento horizontal.

### Pendências

- O módulo Finanças (Prompt 11) passa a servir o contrato: razão de clientes e conciliação.
- Juros de mora, cartas de cobrança e bloqueio automático por atraso, se pedidos.

## 10.11 Facturação recorrente

Os contratos têm versões de preço aprovadas por outra pessoa. A geração é segura e cria **só rascunhos**: nada é
emitido sem uma pessoa autorizada (D-069).

### Modelo

Migração `0064_create_recurring_billing`:

- `sales_recurring_contracts` — referência única e descrição; entidade, cliente e moeda; periodicidade e momento da
  facturação; início, fim e prazo; índice do próximo período; estado com motivo; membro dono.
  Gatilho: o índice só avança; activo, o essencial não muda; terminado é final.
- `sales_recurring_versions` — número, vigência, estado (por aprovar, aprovada, descartada), aprovador (≠ criador) e
  motivo. Índice único das aprovadas por vigência. Aprovada é imutável.
- `sales_recurring_version_lines` — serviço (único por versão), descrição, quantidade, preço fixo opcional, impostos e
  isenção. Só mudam em rascunho.
- `sales_recurring_runs` — período (índice, início, fim, data da factura), versão, factura, estado (gerado ou falhado,
  com motivo). Um só gerado por índice. Só de acréscimo.
- `sales_invoices.recurring_version_id`. A origem de preço `CONTRACT` entra no `CHECK` das linhas.

### Backend e API (`/api/v1/sales`)

- `GET recurring` (filtros estado e pesquisa), `GET recurring/options`, `GET recurring/search/{customers|products}`.
- `POST recurring`, `GET|PATCH recurring/:id`.
- `POST recurring/:id/{versions|activate|suspend|resume|end|generate}`; `POST recurring/generate` (todos os vencidos
  das entidades que gere).
- `PATCH recurring-versions/:id`; `POST recurring-versions/:id/{approve|discard}`.
- Contratos:
  - `createRecurringDraft` (factura): rascunho com origem `CONTRACT`;
  - `generateContract` e `generateDueContracts`;
  - o comando `node ace sales:recurring`.
- A ficha da factura mostra o contrato e o período. A factura gerada não muda de cliente nem de moeda.
- Permissões novas `sales.recurring.read|manage|approve`. Anexos `sales_recurring_contract`. Auditoria
  `sales_recurring.*`.
- Erros: `NO_VERSION`, `CUSTOMER_BLOCKED`, `SELF_APPROVAL`, `INVALID_DATE`, `VERSION_OVERLAP`, `REFERENCE_TAKEN`,
  `NOT_SERVICE`, `INVALID_STATE`, `VERSION_CONFLICT`, `OUT_OF_SCOPE`.

### Ecrãs (`/vendas/recorrentes`)

- **Lista** — contrato, cliente, periodicidade, próxima factura e estado; "Gerar rascunhos vencidos".
- **Formulário** — referência, descrição, entidade, cliente, periodicidade, momento da facturação, início, fim e prazo.
  O essencial fica bloqueado depois de activo.
- **Ficha:**
  - aviso de que só se geram rascunhos;
  - dados do contrato e acções: editar, nova versão, activar, gerar, suspender, retomar e terminar com motivo;
  - versões com as linhas (preço fixo ou "da tabela à data"), aprovação por outra pessoa e descarte;
  - os próximos 6 períodos, com a versão aplicável e "por gerar";
  - períodos gerados, com a ligação ao rascunho, o valor, "por emitir/emitida" e as falhas com motivo;
  - anexos e auditoria.
- **Factura** — ligação "Contrato REF · período".

### Testes e evidências

**Backend**

`tests/unit/sales_recurring_domain.spec.ts` (3 testes):

- meses sem deriva (31/1 → 28/2 → 31/3, ano bissexto);
- períodos mensal, trimestral e anual, no início e no fim;
- dentro do contrato;
- versão aplicável;
- validação das versões.

`tests/functional/sales_recurring.spec.ts` (2 testes):

- **Versões e geração:**
  - primeira versão fora do início e produto de stock recusados;
  - activar sem versão aprovada: `NO_VERSION`;
  - quem preparou não aprova (`SELF_APPROVAL`); o leitor também não (403);
  - aprovada é imutável; activo;
  - versão 2 a partir deste mês; calendário com 3 períodos por gerar (v1, v1, v2);
  - duas gerações em paralelo somam 3 rascunhos; a seguinte gera 0; índice 3;
  - todos em rascunho e nada na fila fiscal;
  - preço `CONTRACT` 1 000 mais tabela 2×500 = 2 200,00; v2 = 2 420,00; contrato e período na factura;
  - emissão manual por quem tem a permissão (aceita o preço do contrato);
  - versão antes do próximo período recusada;
  - a base recusa apagar períodos, recuar o índice, mudar o início do contrato activo e alterar linhas aprovadas.
- **Falhas, suspensão e fim:**
  - cliente bloqueado: período falhado com `CUSTOMER_BLOCKED`, sem rascunho; repetir não duplica a falha;
  - desbloqueado: 2 gerados;
  - suspender exige motivo; suspenso não gera; retomar; terminar com motivo é final e não se edita;
  - facturação no fim do período: só o período do mês passado, com data do último dia; preço da tabela 1 980,00;
  - lista por estado; auditoria.

Também cobertos:

- `isolation_matrix`: 7 tentativas sobre o contrato e a versão de outra empresa, todas com 404.
- `routes_protection`.
- `sales_invoices.spec.ts` continua a passar.

**Frontend:** `recurring-model.spec.ts`.

**Browser (`p1011`):** 7 passos.

- preparação;
- contrato mensal pelo formulário; primeira versão (vigência proposta no início, serviço, preço fixo 1 000, imposto);
  quem preparou não vê "Aprovar" nem "Activar";
- outra pessoa aprova; activar; 2 períodos por gerar;
- gerar: "2 rascunho(s)… Nada foi emitido", dois rascunhos "por emitir", sem mais nada para gerar;
- o rascunho mostra "Contrato REC-…", estado rascunho e 1 100,00; emitido à mão;
- suspender com motivo; o período aparece como emitido;
- telemóvel sem deslocamento horizontal.

### Pendências

- Emissão em lote por quem tem autorização, se for pedida.
- Rateio de períodos parciais e indexação automática de preços.
- Agendar `sales:recurring` (cron) quando houver ambiente de produção.
