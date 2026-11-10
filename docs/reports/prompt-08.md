# Relatório — Prompt 08 (inventário)

Estado: **8.1 a 8.7 implementados e verificados** no branch `claude/pensive-clarke-5gm075`. Blocos 8.8 a 8.12 seguem, um de cada
vez. Decisões a partir de D-036.

## Inventário AS-IS → TO-BE

| Bloco                      | Antes                         | Agora                                                                                                                         | Estado |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| 8.1 Produtos e serviços    | Sem módulo de inventário      | Unidades, categorias (hierarquia, classe contabilística), marcas; produto armazenável/serviço/kit com SKU e EAN únicos, conversões por produto, rastreio por lote/série/validade, stock mín./máx., preço, variantes, componentes, imagens | Feito  |
| 8.2 Armazéns               | Sem armazéns                  | Armazém por entidade legal/filial com responsável, morada, tipo e estado; localizações zona → corredor → estante → posição com caminho fixo e séries; acesso por âmbito e lista nos restritos | Feito  |
| 8.3 Stock                  | Sem stock                     | Lançamentos e movimentos só de acréscimo, saldos derivados na base (livre, bloqueado, quarentena, reservado, trânsito, previsto; físico e disponível), idempotência, estornos, concorrência, reconciliação, mudança de estado | Feito  |
| 8.4 Entradas/saídas        | Sem documentos de stock       | Documentos com cabeçalho e linhas (unidade e conversão congelada, lote, séries, validade, localização, custo), rascunho → conferência → confirmação parcial/total, número por série, fecho de saldo, anulação, estornos; stock só na confirmação | Feito  |
| 8.5 Transferências         | Sem transferências           | Pedido → aprovação (reserva) → separação → expedição (trânsito no destino) → recepção parcial/total ou perda; segregação de funções; intragrupo com aceitação do destino e referência comercial | Feito  |
| 8.6 Reservas/requisições   | Sem requisições internas      | Pedido por departamento e centro de custo, aprovação que reserva (disponível baixa, físico não), separação, entrega por consumo, libertação e anulação; reservas activas por origem | Feito  |
| 8.7 Contagens/ajustes      | Sem contagens                 | Plano (zona, categoria, cega), snapshot no início, contagem por partes e artigos encontrados, recontagem com snapshot renovado, diferenças com motivo e justificação, aprovação segregada que lança o ajuste; tudo fixo depois | Feito  |

## 8.1 Produtos e serviços

### Modelo

Migração `0033_create_inventory_catalog`: `uoms`, `product_categories` (hierarquia, `accounting_class`), `brands`,
`products`, `product_variants`, `product_uom_conversions`, `product_kit_components`. `CHECK`s: serviços e kits sem
dados de stock, validade só com controlo de validade, mínimo ≤ máximo, preço com moeda, atributos de variante não
vazios, conversão e quantidade de componente positivas, kit diferente do componente.

### API (`/api/v1/inventory`, funcionalidade `inventory`)

- `GET /products` (pesquisa por SKU, nome ou código de barras, também nas variantes; filtros por tipo, estado,
  categoria com subcategorias e marca; ordenação e paginação), `GET /products/lookup?code=` (SKU ou código de barras
  exacto, produto ou variante), `GET /products/:id`, `POST /products`, `PATCH /products/:id` (com `conversions` e
  `components` a substituir quando enviados), `POST /products/:id/variants`, `PATCH /product-variants/:id`.
- `GET|POST /settings/uoms|categories|brands`, `PATCH /settings/:kind/:id`.
- Permissões novas: `inventory.read`, `inventory.products.manage`, `inventory.settings` (nas rotas). Anexos: `product`.
- Erros: `SKU_TAKEN`, `BARCODE_TAKEN`, `INVALID_BARCODE`, `NOT_STOCKABLE`, `KIT_VARIANTS`, `SERIAL_DECIMALS`,
  `EXPIRY_REQUIRED`, `MIN_MAX`, `NO_CONVERSION`, `BASE_UOM`, `DECIMALS`, `NOT_KIT`, `VARIANT_EXISTS`, `UOM_IN_USE`,
  `CYCLE`, `INACTIVE`.

### Ecrãs

Novo domínio "Operações Empresariais" → Inventário:

- Produtos e serviços (lista com pesquisa, filtros na URL, colunas, exportação CSV).
- Produto (criar/editar): identificação com aviso imediato de dígito GTIN errado; classificação e classe contabilística
  (mostra a efectiva e de onde vem); unidades com conversões ("1 CX = 24 UN") e unidades de compra/venda só entre as
  convertíveis; stock e rastreabilidade só para armazenáveis (nota explícita nos serviços e kits); componentes do kit;
  preço; variantes (atributos "Cor=Azul; Tamanho=M"); imagens e fichas técnicas; histórico.
- Configuração do catálogo: separadores Unidades, Categorias (caminho completo e classe) e Marcas.

### Testes e evidências

- Unitário `inventory_catalog_domain.spec.ts` (4 testes): GTIN (EAN-13, EAN-8, UPC-A, interno), SKU, classe,
  decimais exactos e conversão para a base, atributos, coerência do produto.
- Funcional `inventory_catalog.spec.ts` (4 testes): configuração (código repetido, ciclo na hierarquia, classe
  inválida); produto armazenável (validações, classe herdada da categoria-mãe e sobreposta, conversões, SKU/EAN únicos,
  versão, retirar conversão usada, pesquisa por subcategoria, procura por código, unidade usada com casas fixas,
  auditoria); serviços e kits sem stock (também na base), série com unidade inteira, componentes, variantes únicas
  entre produtos e variantes; permissões separadas e unidade inactiva.
- `isolation_matrix` (produtos, procuras por código, variantes, unidades, categorias, marcas e anexos de outra
  empresa); `routes_protection`; frontend `inventory/inventory-model.spec.ts` (6 testes) e navegação.
- Totais: backend 241 testes, frontend 130 testes; lint, formatação, tipos e build sem erros.
- Browser (6 passos, sem erros na consola): funcionalidade activada pela plataforma; unidades, categoria com classe e
  marca pela interface; produto com aviso de GTIN, conversão 1 CX = 24 U, compra em caixas, lotes e validade, erro do
  servidor no GTIN e no máximo, criado com a classe "BEBIDAS (da categoria)"; variante com atributos e procura na
  lista pelo código da variante; serviço sem dados de stock; 390 px sem deslocamento.

## 8.2 Armazéns

### Modelo

Migração `0034_create_inventory_warehouses`: `warehouses` (código único, entidade legal, filial, responsável, tipo,
morada, modo de acesso aberto/restrito, estado), `warehouse_locations` (superior na mesma empresa, nível, código,
caminho único no armazém, nome, "guarda stock", estado; só zonas na raiz; gatilho que impede apagar ou mudar código,
superior, nível, caminho e armazém) e `warehouse_access` (membro e nível `VIEW`/`OPERATE`, único por armazém).

### API (`/api/v1/inventory`)

- `GET /warehouses` (pesquisa, tipo, estado, entidade; devolve `canCreate`), `GET /warehouses/candidates` (membros para
  responsável e lista), `GET /warehouses/:id` (com localizações e, para quem gere, a lista), `POST /warehouses`,
  `PATCH /warehouses/:id` (versão; código e entidade fixos), `POST /warehouses/:id/locations` (uma ou `series`),
  `PATCH /warehouse-locations/:id` (nome, guarda stock, estado), `PUT /warehouses/:id/access` (dar/mudar/retirar).
- Permissão nova `inventory.warehouses.manage`; o âmbito (entidade/filial) é verificado no serviço (justificado no
  `routes_protection`). Fora do âmbito: 404.
- Erros: `CODE_TAKEN`, `FIXED`, `OTHER_LEGAL_ENTITY`, `OUT_OF_SCOPE`, `INVALID_CODE`, `INVALID_COUNTRY`, `TOO_DEEP`,
  `LOCATION_EXISTS`, `ACTIVE_CHILDREN`, `INACTIVE_PARENT`, `INACTIVE`.

### Ecrãs

Inventário → Armazéns: lista (código, nome, tipo, entidade, filial, acesso, estado; pesquisa e filtros na URL) e ficha
do armazém (dados, morada, modo de acesso; árvore de localizações com "+ próximo nível", inactivar/reactivar e geração
em série com pré-visualização dos códigos; lista de acesso com Consultar/Operar; histórico).

### Testes e evidências

- Unitário `inventory_warehouses_domain.spec.ts` (2 testes): níveis, códigos e caminhos, séries (largura, limites,
  repetidos); regra de acesso (gestão, âmbito, lista dos restritos).
- Funcional `inventory_warehouses.spec.ts` (3 testes): validação, filial de outra entidade recusada, responsável,
  código repetido, código e entidade fixos, versão, auditoria; hierarquia e séries, caminho repetido, nível a mais,
  gatilho na base (UPDATE/DELETE recusados), inactivação com filhas activas recusada e reactivação com superior
  inactiva recusada; âmbito por entidade e filial, armazém restrito só com lista, gestão separada da consulta, 404 fora
  do âmbito.
- `isolation_matrix` (armazém e localização de outra empresa, lista vazia, URL forjada); `routes_protection`; frontend
  `warehouse-model.spec.ts` (3 testes: árvore ordenada por caminho, próximo nível, pré-visualização da série).
- Browser (7 passos, sem erros na consola): armazém criado com entidade e tipo; Z1 → Z1-C01 → Z1-C01-E1 e série
  P01–P05 (8 localizações); inactivar Z1 recusado com a mensagem do servidor, P05 inactivada; modo restrito e membro
  com "Operar"; armazém na lista; 390 px sem deslocamento horizontal.

## 8.3 Stock

### Modelo

Migração `0035_create_inventory_stock`: `stock_postings` (tipo, chave de idempotência única, origem, motivo, estorno
único), `stock_movements` (balde e quantidade com sinal, 6 casas; FK compostas: localização do mesmo armazém, variante
do mesmo produto) e `stock_balances` (um saldo por armazém/localização/produto/variante, `UNIQUE NULLS NOT DISTINCT`,
cada balde ≥ 0). Gatilhos: só acréscimo em lançamentos e movimentos; saldo actualizado por cada movimento (primeiro
`UPDATE`, depois `INSERT` — um `INSERT … ON CONFLICT` verificaria os `CHECK` na linha proposta, com a quantidade
negativa); escrita directa nos saldos recusada; reservado ≤ livre por armazém verificado no fim da transacção.

### Contrato e API

- Contrato (`inventory/index.ts`): `postStock(scope, { type, idempotencyKey, sourceType, sourceId?, sourceRef?, reason?,
  lines[] })` e `reverseStockPosting(scope, postingId, { idempotencyKey, reason })`.
- `GET /inventory/stock/balances` (armazém, produto, pesquisa; só saldos não nulos), `GET /inventory/stock/movements`
  (armazém, produto, variante, tipo), `GET /inventory/stock/postings/:id`, `GET /inventory/stock/reconciliation`,
  `POST /inventory/stock/status-changes` (livre ↔ bloqueado ↔ quarentena, com motivo e chave de idempotência).
- Permissão nova `inventory.stock.manage` (no âmbito do armazém); consulta pelo acesso aos armazéns.
- Erros: `INSUFFICIENT_STOCK`, `OVER_RESERVED`, `IDEMPOTENCY_MISMATCH`, `ALREADY_REVERSED`, `REVERSAL_OF_REVERSAL`,
  `BUCKET_NOT_ALLOWED`, `NOT_BALANCED`, `NO_LOCATION`, `NOT_STOCKABLE`, `REQUIRED` (variante), `DECIMALS`,
  `NOT_HOLDING`, `INACTIVE`, `NO_OPERATE`, `OUT_OF_SCOPE`.

### Ecrãs

Inventário → Stock (saldos por armazém/localização com físico, disponível e cada balde; filtro de armazém na URL;
exportação CSV; "Conferir saldos"; "Mudar estado" com validação da quantidade face ao estado de origem e às casas da
unidade) e Movimentos de stock (kardex com tipo, estado, quantidade com sinal, origem e autor; lançamento com as linhas,
estorno e lançamento estornado ligados).

### Testes e evidências

- Unitário `inventory_stock_domain.spec.ts` (2): quantidades exactas com sinal, físico/disponível, estorno, baldes e
  sinais por tipo, mudança de estado equilibrada.
- Funcional `inventory_stock.spec.ts` (4): regras do contrato (tipo, casas, serviço, variante, localização, armazém);
  previsto consumido pela entrada, quarentena, variante e quilos com 3 casas; reservado reduz o disponível e não o
  físico, reserva excessiva e saída que deixaria o reservado acima do livre recusadas, saída que consome a reserva com
  qualquer ordem de linhas; mudança de estado pela API; kardex, lançamento e auditoria; idempotência (repetição, chave
  com outro conteúdo); estorno único, estorno de estorno recusado, estorno de entrada já consumida recusado; a base
  recusa alterar/apagar movimentos e lançamentos e escrever saldos, e o reservado acima do livre inserido à mão falha
  (verificação imediata e no COMMIT, sem gravar nada); **10 saídas em paralelo sobre 5 unidades: 5 passam, 5
  `INSUFFICIENT_STOCK`, saldo 0**; 5 pedidos em paralelo com a mesma chave: um lançamento; acesso por âmbito, armazém
  restrito, lista só de consulta (`NO_OPERATE`) e permissão de gestão; reconciliação sempre sem diferenças.
- `isolation_matrix` (lançamento e mudança de estado noutra empresa → 404; saldos, movimentos e reconciliação vazios;
  URL forjada → 403); `routes_protection`; frontend `stock-model.spec.ts` (3).
- Browser (7 passos, sem erros na consola): stock inicial **lançado directamente na base** como preparação (as entradas
  chegam no 8.4) — os gatilhos derivaram os saldos; Stock com físico 100, disponível 100 e previsto 50; mudança de
  estado com validação no cliente ("Há só 100 neste estado.") e 10 para quarentena (disponível 90); conferência sem
  diferenças; kardex do produto (−10/+10, +100, +50) e lançamento com motivo e as duas linhas; 390 px sem deslocamento.

## 8.4 Entradas e saídas

### Modelo

Migração `0036_create_inventory_documents`: `stock_documents` (tipo, armazém, entidade legal, série e número, data,
origem, referência, contraparte, moeda, estado, conferência, fecho e anulação com motivo), `stock_document_lines`
(produto/variante, unidade e factor congelado, quantidade e quantidade base, localização do mesmo armazém por FK
composta, estado do stock, lote, séries, validade, custo, conferido e confirmado), `stock_document_confirmations` e
`stock_document_confirmation_lines` (cada confirmação aponta o lançamento de stock e, se estornada, o lançamento
inverso). Gatilhos: confirmações e as suas linhas só de acréscimo (o estorno preenche as suas marcas uma vez); linhas
com confirmações não se apagam nem mudam de produto, unidade, factor, quantidade, localização, lote, séries, validade
ou custo. `CHECK`s: confirmado ≤ quantidade, conferido + confirmado ≤ quantidade, número ⇔ série, anulação ⇔ motivo.

### API (`/api/v1/inventory`)

- `GET|POST /documents`, `GET|PUT /documents/:id` (rascunho), `POST /documents/:id/check|reopen|confirm|close|cancel`,
  `POST /document-confirmations/:id/reverse`. Confirmar e estornar exigem chave de idempotência; as outras acções
  exigem a versão.
- Permissões novas: `inventory.documents.manage` e `inventory.documents.confirm` (âmbito do armazém).
- Erros: `INVALID_STATE`, `VERSION_CONFLICT`, `NOTHING_CHECKED`, `NO_SERIES`, `HAS_CONFIRMATIONS`, `ALREADY_REVERSED`,
  `NO_CONVERSION`, `DECIMALS`, `BASE_DECIMALS`, `NOT_HOLDING`, `SERIAL_COUNT`, `SERIAL_DUPLICATE`, `NOT_TRACKED`,
  `NOT_ALLOWED` (custo numa saída), `FUTURE`, e os do 8.3 (`INSUFFICIENT_STOCK`, `OVER_RESERVED`, …).

### Ecrãs

Inventário → Entradas e saídas: lista (tipo, estado, armazém, pesquisa por número/referência/contraparte) com "Nova
entrada" e "Nova saída"; documento com cabeçalho, linhas editáveis no rascunho (produto, variante, unidade com a
conversão mostrada e a quantidade base calculada, localização, estado, lote, validade, séries, custo; erros do servidor
na linha certa) e, depois, só leitura com confirmado/por confirmar/conferido; acções conforme estado e permissões
(Conferir, Reabrir conferência, Confirmar — com confirmação explícita —, Fechar saldo, Anular, Estornar), confirmações
com estornos e histórico. O modelo de formulário ganhou o modo só de leitura (sem "Guardar").

### Testes e evidências

- Unitário `inventory_documents_domain.spec.ts` (2): lote, séries (quantidade, inteiros, repetidos), validade, custo
  nas saídas, origens por tipo, estado a partir das quantidades, conferência (limites, séries por inteiro), acções por
  estado.
- Funcional `inventory_documents.spec.ts` (3): validações (linhas, origem, data futura, conversão, lote, validade,
  séries, casas, localização); rascunho não mexe no stock; edição com versão; confirmar sem conferir recusado;
  conferência acima do que falta recusada; reabrir; confirmação parcial numera (`ENT-…1`) e lança 7 caixas = 168;
  repetir a mesma confirmação não duplica; documento confirmado não se edita nem anula; segunda ronda conclui; leite em
  quarentena; movimentos com origem `STOCK_DOCUMENT` e número; estorno (motivo, idempotente, único) devolve saldo por
  confirmar e retira 168; fecho de saldo; auditoria de todas as acções; reconciliação sem diferenças; a base recusa
  apagar confirmações e alterar linhas confirmadas. Saídas: séries por inteiro, custo recusado, saída acima do stock
  recusada sem lançar nem numerar, anulação com motivo, série `SAI-…1`, entidade sem série (`NO_SERIES`). Permissões:
  leitor não cria, fiel cria/confere mas não confirma, chefe confirma, documento de outra entidade → 404; **duas
  confirmações em paralelo: uma 200, outra 409, um só lançamento**.
- `isolation_matrix` (documento de outra empresa: ler, editar, conferir, confirmar, anular → 404; lista vazia; URL
  forjada → 403); `routes_protection`; frontend `stock-document-model.spec.ts` (3).
- Browser (8 passos, sem erros na consola): séries criadas; entrada com 10 CX (= 240 U mostrado), custo, leite com lote,
  validade e quarentena (erro do lote na linha certa); conferência parcial de 6 CX com motivo; confirmação → número da
  série, Parcial, 144 em stock; segunda ronda → Concluído, 240; estorno da 1.ª (96) e fecho do saldo com motivo; saída de
  999 recusada com "Stock insuficiente" sem mexer no stock e anulada; lista filtrada; 390 px sem deslocamento.

## 8.5 Transferências

### Modelo

Migração `0037_create_inventory_transfers`: `stock_transfers` (origem e destino, entidades legais, intragrupo
calculado e verificado por `CHECK`, referência comercial obrigatória a partir da expedição se intragrupo, série e
número, marcas de cada passo, motivos de rejeição/anulação/perda), `stock_transfer_lines` (quantidade base, localização
e estado na origem, localização no destino por FK compostas, lote e séries, separado/expedido/recebido/perdido com
`CHECK` recebido + perdido ≤ expedido), `stock_transfer_events` + linhas (reserva, libertação, expedição, recepção,
perda; só acréscimo). Linhas expedidas imutáveis (gatilho).

### API (`/api/v1/inventory`)

- `GET|POST /transfers`, `GET /transfers/destinations`, `GET|PUT /transfers/:id`,
  `POST /transfers/:id/submit|approve|accept|reject|pick|dispatch|receive|close|cancel`.
- Permissões novas: `inventory.transfers.manage` e `inventory.transfers.approve` (no armazém de cada passo).
- Erros: `SELF_APPROVAL`, `ALREADY_APPROVED`, `ALREADY_ACCEPTED`, `NOT_INTERCOMPANY`, `NO_SERIES`, `INVALID_STATE`,
  `NOTHING_PICKED`, `NOTHING_TO_SHIP`, `NOTHING_RECEIVED`, `NOTHING_IN_TRANSIT`, `SAME`, e os do 8.3 (`OVER_RESERVED`,
  `INSUFFICIENT_STOCK`).

### Ecrãs

Inventário → Transferências: lista (estado, armazém, pesquisa) e transferência com rascunho editável (origem, destinos
possíveis incluindo outras entidades, linhas com localização e estado de origem, localização de destino, lote e
séries) e, depois, passos com quem e quando, acções conforme estado e direitos (Pedir aprovação, Aprovar, Aceitar,
Rejeitar, Separar, Expedir com transportador/guia/referência intragrupo, Receber com localização, Fechar perdas,
Anular), linhas com pedido/separado/expedido/recebido/em trânsito/perdido e movimentos de stock.

### Correcções feitas neste bloco

- `postStock` com `checkAccess: false` exigia que o membro **visse** todos os armazéns das linhas; a expedição
  intragrupo (que toca o armazém de destino) falhava com 404. Passou a confirmar só que o armazém existe na empresa.
- A `isolation_matrix` não tinha as tentativas dos documentos do 8.4 (a inserção falhou em silêncio por formatação):
  foram acrescentadas agora (documentos e transferências).
- Interface: o `ConfirmService` responde só ao pedido a que a resposta pertence (um `close` atrasado de um diálogo já
  respondido não cancela o seguinte; teste `confirm.spec.ts`); os botões de acção de documentos e transferências ficam
  inactivos durante um pedido (no E2E, aceitar com a aprovação ainda em curso enviava uma versão antiga); o histórico
  traduz as acções de documentos e transferências.

### Testes e evidências

- Unitário `inventory_transfers_domain.spec.ts` (2): aprovação completa (intragrupo exige aceitação), segregação,
  quantidade a expedir, recepção, estados.
- Funcional `inventory_transfers.spec.ts` (3): validações; pedido; quem pede não aprova; aprovação numera e reserva
  (físico 100, reservado 30, disponível 70); separação curta (25/30); expedição idempotente (origem 75, reservado 0,
  destino 25 em trânsito); recepção acima do trânsito recusada; recepção parcial (10); perda com motivo (15) e estado
  recebida; eventos, movimentos com origem `STOCK_TRANSFER`, reconciliação sem diferenças, auditoria; a base recusa
  apagar eventos e alterar linhas expedidas. Intragrupo: aprovação da origem não reserva nem deixa expedir; aceitação
  reserva; referência comercial obrigatória; movimentos `INTERCOMPANY_TRANSFER`; aceitar uma interna →
  `NOT_INTERCOMPANY`. Aprovar acima do disponível → `OVER_RESERVED` sem mudar nada; rejeição com motivo; anulação liberta
  a reserva; quarentena transfere-se sem reserva e chega em quarentena; quem gere só a entidade A pede e expede para B
  mas não recebe em B; o leitor de B vê só as transferências que tocam B.
- `isolation_matrix` (transferência de outra empresa: ler, editar, submeter, aprovar, anular → 404; lista e destinos
  vazios; URL forjada → 403), `routes_protection`, frontend `transfer-model.spec.ts` (2) e `confirm.spec.ts` (2).
- Browser (6 passos, três execuções seguidas sem falhas, sem erros na consola; dois utilizadores): pedido pela
  interface e "Aprovar" escondido a quem pediu; aprovação pelo aprovador (número, reserva 20); separação de 15,
  expedição (origem 35, trânsito 15), recepção de 10 e perda de 5 fechada pelo aprovador; intragrupo com aprovação,
  aceitação, referência obrigatória na expedição e recepção no destino; 390 px sem deslocamento. O E2E do 8.4 voltou a
  passar (8/8) depois das alterações.

## 8.6 Reservas e requisições internas

### Modelo

Migração `0038_create_inventory_requisitions`: `stock_requisitions` (armazém e entidade, departamento, centro de custo,
quem pede, finalidade, data em que é preciso, série e número, marcas e motivos), `stock_requisition_lines` (quantidade
base, localização, separado/entregue/libertado com `CHECK` entregue + libertado ≤ pedido) e eventos + linhas (reserva,
entrega, libertação; só acréscimo). Linhas imutáveis depois da reserva (gatilho).

### API (`/api/v1/inventory`)

- `GET|POST /requisitions`, `GET /requisitions/options` (armazéns, departamentos para que o membro pode requisitar,
  centros de custo), `GET|PUT /requisitions/:id`, `POST /requisitions/:id/submit|approve|reject|pick|issue|release|cancel`,
  `GET /reservations` (reservas activas por origem, armazém e produto).
- Permissões novas: `inventory.requisitions.request`, `.approve` e `.fulfil`.
- Erros: `SELF_APPROVAL`, `OUT_OF_SCOPE`, `OTHER_LEGAL_ENTITY`, `NO_SERIES`, `HAS_ISSUES`, `NOTHING_PICKED`,
  `NOTHING_ISSUED`, `NOTHING_OPEN`, `INVALID_STATE`, e os do 8.3 (`OVER_RESERVED`, `INSUFFICIENT_STOCK`).

### Ecrãs

Inventário → Requisições internas (lista e requisição: rascunho com departamento e centro de custo da entidade do
armazém, linhas com localização opcional; depois Pedir aprovação, Aprovar com confirmação, Rejeitar, Separar, Entregar
com a localização de saída, Libertar resto, Anular; linhas com pedido/separado/entregue/libertado/em aberto, movimentos
e histórico) e Reservas activas (origem com ligação, produto, armazém, quantidade). Navegação e rotas com "basta uma
destas permissões".

### Testes e evidências

- Unitário `inventory_requisitions_domain.spec.ts` (2): âmbito do departamento (entidade, filial, departamento),
  em aberto, entregas (acima do separado/em aberto recusadas), estados e acções.
- Funcional `inventory_requisitions.spec.ts` (2): validações (finalidade, linhas, departamento e centro de custo de
  outra entidade, departamento fora do âmbito); rascunho não mexe no stock; quem pede não aprova; aprovação numera
  (`RQ-…1`) e reserva (físico 100, reservado 30, disponível 70) e aparece nas reservas activas; quem pede não atende;
  separação 25; entrega 20 idempotente (físico 80, reservado 10); entrega acima do separado recusada; libertação com
  motivo (reservado 0, reservas activas vazias); movimentos `INTERNAL_REQUISITION` com o número; reconciliação; auditoria;
  a base recusa apagar eventos e alterar linhas reservadas. Segregação (o administrador não aprova a sua); âmbito
  "próprio" (requisita para outro departamento e só vê as suas; o aprovador do departamento 1 não vê a do 2); aprovar
  acima do disponível → `OVER_RESERVED` sem número; rejeição; anulação liberta a reserva; depois de entregas não se
  anula; linha sem posição falha na entrega até quem atende escolher a posição; entidade sem série → `NO_SERIES`.
- `isolation_matrix` (requisição de outra empresa: ler, editar, submeter, aprovar, anular → 404; listas de requisições e
  reservas e opções vazias; URL forjada → 403), `routes_protection`, frontend `requisition-model.spec.ts` (3) e
  navegação ("anyOf").
- Browser (5 passos, três execuções seguidas, sem erros na consola; dois utilizadores): pedido pela interface com
  departamento e centro de custo, "Aprovar" escondido a quem pede; aprovação pelo aprovador (reservado 20, disponível
  30, físico 50) e a reserva em Reservas activas com ligação; separação 15, entrega a partir da posição escolhida
  (físico 35, reservado 5), libertação do resto (reservado 0) com motivo; 390 px sem deslocamento.

## 8.7 Contagens e ajustes

### Modelo

Migração `0039_create_inventory_counts`: `stock_counts` (armazém e entidade, zona e categoria opcionais, cega, data
prevista, série e número no início, marcas de cada passo, motivo de anulação; `CHECK`s de número/estado/anulação/
aprovação), `stock_count_lines` (saldo único por contagem, snapshot e momento, contado da volta, volta, recontagem pedida
e motivo, encontrado durante a contagem, motivo e justificação — `CHECK` lista de motivos e motivo ⇔ justificação),
`stock_count_entries` (cada quantidade registada, quem e em que volta) e `stock_count_postings` (lançamentos de
ajuste). Gatilhos: registos e lançamentos só de acréscimo; contagem e linhas fixas depois de aprovada/anulada; plano
fixo depois do início; linhas não se apagam nem mudam de saldo depois do início.

### API (`/api/v1/inventory`)

- `GET|POST /counts`, `GET /counts/options` (armazéns onde gere contagens com as zonas, categorias, motivos),
  `GET|PUT /counts/:id`, `POST /counts/:id/start|count|lines|submit|justify|recount|approve|cancel`.
- Permissões novas: `inventory.counts.manage` e `inventory.counts.approve`.
- Erros: `SELF_APPROVAL`, `OUT_OF_SCOPE`, `NO_SERIES`, `COUNT_OVERLAP`, `COUNT_TOO_LARGE`, `LINE_EXISTS`,
  `NOT_COUNTED`, `NOT_JUSTIFIED`, `NO_DIFFERENCE`, `OUT_OF_PLAN`, `INVALID_STATE`, `VERSION_CONFLICT` e, na aprovação,
  `INSUFFICIENT_STOCK`/`OVER_RESERVED` (o ajuste não cabe no saldo actual ou deixaria reservado acima do livre).

### Ecrãs

Inventário → Contagens e ajustes (lista com zona, cega, progresso e estado; contagem: plano com armazém, zona,
categoria, data, descrição e "cega"; Iniciar com confirmação; grelha de linhas com o contado editável e "Guardar
contagem (n)"; Artigo encontrado; Terminar; na revisão, sistema/diferença/movido depois para quem pode ver,
Justificar diferenças, Pedir recontagem com escolha das linhas, Aprovar ajuste com confirmação, Anular; aviso de
segregação a quem contou; lançamentos de ajuste com ligação aos movimentos; histórico).

### Testes e evidências

- Unitário `inventory_counts_domain.spec.ts` (2): diferença, repartição do ajuste (livre → quarentena → bloqueado, falta
  não coberta), bloqueios da aprovação, quem vê o sistema, estados.
- Funcional `inventory_counts.spec.ts` (3): validações e zona de outro armazém; plano por zona (Z1 com a posição abaixo,
  Z2 de fora); número `IV-…1`; cega (quem conta não vê, quem aprova vê); plano fixo; movimento −5 depois do snapshot;
  quantidade negativa recusada; submeter com linhas por contar recusado; diferença −3 e "movido depois" −5; aprovar sem
  justificação recusado; quem conta não justifica nem aprova; motivo inválido, linha sem diferença e formulário vazio
  recusados; aprovação ajusta 95 → 92 (filtro e Z2 intactos); movimento `ADJUSTMENT` com origem e número;
  reconciliação; fechada não se anula e a base recusa alterar contagem, linhas, registos e lançamentos; auditoria.
  Contagem aberta de todo o armazém; sobreposição com outra contagem; artigo encontrado (snapshot 0) e duplicado
  recusado; recontagem só por quem aprova, com snapshot renovado (10 → 8 depois de uma saída) e volta 2; quem reconta
  deixa de poder aprovar (`SELF_APPROVAL`); quem gere justifica numa aberta; **duas aprovações em simultâneo: uma 200,
  outra 409, um só lançamento**; 5 registos de contagem. Categoria (só o óleo nas duas zonas); falta depois do snapshot
  que já não cabe → `INSUFFICIENT_STOCK` sem mexer no stock; fora do âmbito 404 e lista vazia; sem série → `NO_SERIES`;
  anulação com motivo sem ajuste; versão desactualizada → `VERSION_CONFLICT`.
- `isolation_matrix` (contagem de outra empresa: ler, editar, iniciar, contar, acrescentar, submeter, justificar,
  recontar, aprovar, anular → 404; lista e opções vazias; URL forjada → 403), `routes_protection`, frontend
  `count-model.spec.ts` (3: acções por estado/direito/cega, só envia quantidades que mudam — vírgula e espaços —,
  linhas com diferença).
- Browser (6 passos, três execuções seguidas com o código final, sem erros na consola; dois utilizadores): o contador
  cria o plano cego pela interface, inicia (sem coluna do sistema nem "Aprovar"), regista 47 e 10, acrescenta um artigo
  encontrado (5) e termina; o aprovador vê −3 e +5, a aprovação sem justificação é recusada com a linha indicada, pede
  recontagem do filtro; o contador reconta 48; o aprovador justifica as duas diferenças e aprova — saldos 48/10/5, dois
  movimentos `ADJUSTMENT` com o número; depois de aprovada o contador vê o sistema e nada é editável; 390 px sem
  deslocamento horizontal.

## Pendências

- 8.8 a 8.12 (lotes/FEFO, valorização, integrações, alertas, QA).
- Mudança de tipo ou de unidade base de um produto com movimentos fica bloqueada quando houver stock (8.3).
- Tabelas de preços por cliente/canal ficam para Vendas; a imagem principal é a primeira anexada (sem ordenação).
- 8.2: o acesso `OPERATE` só passa a ter efeito nas operações de stock (8.4 em diante); mudar a entidade legal de um
  armazém exige criar outro (com transferência de stock depois do 8.5).
- 8.3: a valorização (custo) dos movimentos chega no 8.9; lotes e séries no 8.8 (o saldo ganhará essa dimensão); o saldo
  não guarda a data do documento (fica no documento do 8.4); stock negativo não é permitido (sem configuração).
- 8.4: lote, séries e validade ficam nas linhas dos documentos; os saldos por lote/série chegam no 8.8. Documentos
  ligados a compras e vendas (origem com identificador) chegam no 8.10; anexos ao documento ainda não.
- 8.5: a contabilização intragrupo (venda/compra entre entidades) é do 8.10; o custo em trânsito, do 8.9. Uma
  transferência expede-se de uma vez (o que não foi separado deixa de seguir); recepções podem ser várias.
- 8.6: as requisições não escolhem lote/série (o stock por lote chega no 8.8); sem aprovação em vários níveis nem
  limites por valor (o custo chega no 8.9).
- 8.7: as contagens não bloqueiam movimentos (o ajuste é relativo ao snapshot; a revisão mostra o que mudou depois);
  contagem por lote/série chega com o 8.8 e o valor das diferenças com o 8.9; sem contagem por dispositivo/código de
  barras nem impressão de folhas de contagem; a contagem cega esconde o sistema no ecrã/API da contagem, não na
  consulta de saldos (separação de perfis decidida pela empresa).
