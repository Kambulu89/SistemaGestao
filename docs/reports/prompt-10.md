# Relatório — Prompt 10 (vendas e facturação)

Estado: **Prompt 10 em curso** — 10.1 a 10.4 feitos, no branch `claude/pensive-clarke-5gm075`. Decisões D-059 a D-062. Antes de começar
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
