# Relatório — Prompt 08 (inventário)

Estado: **8.1, 8.2 e 8.3 implementados e verificados** no branch `claude/pensive-clarke-5gm075`. Blocos 8.4 a 8.12 seguem, um de cada
vez. Decisões a partir de D-036.

## Inventário AS-IS → TO-BE

| Bloco                      | Antes                         | Agora                                                                                                                         | Estado |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| 8.1 Produtos e serviços    | Sem módulo de inventário      | Unidades, categorias (hierarquia, classe contabilística), marcas; produto armazenável/serviço/kit com SKU e EAN únicos, conversões por produto, rastreio por lote/série/validade, stock mín./máx., preço, variantes, componentes, imagens | Feito  |
| 8.2 Armazéns               | Sem armazéns                  | Armazém por entidade legal/filial com responsável, morada, tipo e estado; localizações zona → corredor → estante → posição com caminho fixo e séries; acesso por âmbito e lista nos restritos | Feito  |
| 8.3 Stock                  | Sem stock                     | Lançamentos e movimentos só de acréscimo, saldos derivados na base (livre, bloqueado, quarentena, reservado, trânsito, previsto; físico e disponível), idempotência, estornos, concorrência, reconciliação, mudança de estado | Feito  |

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

## Pendências

- 8.4 a 8.12 ( movimentos, transferências, reservas, contagens, lotes/FEFO, valorização, integrações,
  alertas, QA).
- Mudança de tipo ou de unidade base de um produto com movimentos fica bloqueada quando houver stock (8.3).
- Tabelas de preços por cliente/canal ficam para Vendas; a imagem principal é a primeira anexada (sem ordenação).
- 8.2: o acesso `OPERATE` só passa a ter efeito nas operações de stock (8.4 em diante); mudar a entidade legal de um
  armazém exige criar outro (com transferência de stock depois do 8.5).
- 8.3: a valorização (custo) dos movimentos chega no 8.9; lotes e séries no 8.8 (o saldo ganhará essa dimensão); o saldo
  não guarda a data do documento (fica no documento do 8.4); stock negativo não é permitido (sem configuração).
