# Relatório — Prompt 08 (inventário)

Estado: **8.1 e 8.2 implementados e verificados** no branch `claude/pensive-clarke-5gm075`. Blocos 8.3 a 8.12 seguem, um de cada
vez. Decisões a partir de D-036.

## Inventário AS-IS → TO-BE

| Bloco                      | Antes                         | Agora                                                                                                                         | Estado |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| 8.1 Produtos e serviços    | Sem módulo de inventário      | Unidades, categorias (hierarquia, classe contabilística), marcas; produto armazenável/serviço/kit com SKU e EAN únicos, conversões por produto, rastreio por lote/série/validade, stock mín./máx., preço, variantes, componentes, imagens | Feito  |
| 8.2 Armazéns               | Sem armazéns                  | Armazém por entidade legal/filial com responsável, morada, tipo e estado; localizações zona → corredor → estante → posição com caminho fixo e séries; acesso por âmbito e lista nos restritos | Feito  |

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

## Pendências

- 8.3 a 8.12 (stock, movimentos, transferências, reservas, contagens, lotes/FEFO, valorização, integrações,
  alertas, QA).
- Mudança de tipo ou de unidade base de um produto com movimentos fica bloqueada quando houver stock (8.3).
- Tabelas de preços por cliente/canal ficam para Vendas; a imagem principal é a primeira anexada (sem ordenação).
- 8.2: o acesso `OPERATE` só passa a ter efeito nas operações de stock (8.4 em diante); mudar a entidade legal de um
  armazém exige criar outro (com transferência de stock depois do 8.5).
