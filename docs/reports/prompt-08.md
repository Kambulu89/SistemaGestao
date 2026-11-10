# Relatório — Prompt 08 (inventário)

Estado: **8.1 implementado e verificado** no branch `claude/pensive-clarke-5gm075`. Blocos 8.2 a 8.12 seguem, um de cada
vez. Decisões a partir de D-036.

## Inventário AS-IS → TO-BE

| Bloco                      | Antes                         | Agora                                                                                                                         | Estado |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| 8.1 Produtos e serviços    | Sem módulo de inventário      | Unidades, categorias (hierarquia, classe contabilística), marcas; produto armazenável/serviço/kit com SKU e EAN únicos, conversões por produto, rastreio por lote/série/validade, stock mín./máx., preço, variantes, componentes, imagens | Feito  |

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

## Pendências

- 8.2 a 8.12 (armazéns, stock, movimentos, transferências, reservas, contagens, lotes/FEFO, valorização, integrações,
  alertas, QA).
- Mudança de tipo ou de unidade base de um produto com movimentos fica bloqueada quando houver stock (8.3).
- Tabelas de preços por cliente/canal ficam para Vendas; a imagem principal é a primeira anexada (sem ordenação).
