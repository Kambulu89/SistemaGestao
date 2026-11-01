# Custom Fields e Entidades Dinâmicas

Extensão do **Core Dinâmico** (ver `README.md`, secção «Core Dinâmico») para dois casos:

- **A — Campos personalizados** que um tenant acrescenta a uma entidade nativa (ex.: _Cliente_).
- **B — Entidades dinâmicas** que um tenant cria só com metadados (ex.: _Equipamento_).

Não há um segundo motor de formulários, um segundo Entity Registry nem um sistema de permissões
paralelo. Tudo reutiliza `EntityDefinition`, `FieldDefinition`, o motor de validação, o
`DynamicEntityRegistryService`, o `DynamicFormRenderer`/`DynamicListRenderer` e o IAM existente.
Nenhuma entidade criada por um tenant tem componentes Angular próprios.

> **Segurança.** O frontend esconde e valida por conveniência; **quem decide é o backend**. O
> `core/mock/` simula esse backend (tenant pelo contexto do pedido, RBAC + ABAC, validação,
> unicidade, concorrência, auditoria) e é o contrato que o servidor real tem de cumprir.

## 1. Modelo

| Contrato do pedido                                                | Onde está                                       | Nota                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `FieldDefinition` (união discriminada, 22 tipos)                  | `core/dynamic/models/field-definition.model.ts` | `origin: 'core' \| 'custom'`, `sensitivity`                                                   |
| `CustomEntityDefinition`                                          | `custom-definition.model.ts`                    | alias de `EntityDefinition` com `scope: 'tenant'`                                             |
| `CustomFieldDefinition`                                           | `custom-definition.model.ts`                    | `{ id, tenantId, entity: EntityRef, field, displayOrder, showInList, state, version, audit }` |
| `CustomEntityRecord`, `CustomFieldValue`                          | `custom-definition.model.ts`                    | os mesmos `EntityRecord`/`FieldValue` de qualquer entidade                                    |
| `EntityReferenceDefinition`                                       | `EntityReferenceField`                          | `entityKey` (+ existência validada no servidor, mesmo tenant)                                 |
| `FormulaDefinition` / `LookupDefinition` / `AutoNumberDefinition` | `field-definition.model.ts`                     | ver §3                                                                                        |
| `FieldOptionDefinition`                                           | `FieldOption`                                   | `{ value, label, active? }`: o `value` é estável                                              |
| `FieldValidationDefinition`                                       | `ValidationRule`                                | `required, minLength, maxLength, min, max, pattern, email, unique, compare`                   |
| `FieldTypeDefinition`                                             | `core/dynamic/engine/field-types.ts`            | catálogo com capacidades por tipo                                                             |

`EntityRef = { kind: 'core' \| 'custom', key }` identifica a entidade de forma estável (independente
do nome visível). O código (`key`) de uma entidade ou campo **nunca muda** depois de publicado e nunca
se reutiliza (nem o de campos arquivados).

## 2. Registo e fusão

`DynamicEntityRegistryService.published()` devolve as definições **já com os campos personalizados do
tenant fundidos** (`mergeCustomFields`). Os renderers e motores recebem uma `EntityDefinition`
normal e não sabem o que é personalizado.

- Só se fundem campos do tenant activo, da entidade certa, `active` (rascunhos e arquivados ficam de fora).
- Só entidades `extensible: true` aceitam campos personalizados. A definição nativa nunca é alterada.
- Ordem: campos nativos, depois os personalizados por `displayOrder`; a secção «Campos personalizados»
  é acrescentada aos formulários explícitos; colunas (`showInList`), pesquisa e filtros respeitam as
  capacidades do tipo.
- O registo valida códigos duplicados/colisões (`customFieldIssues`) e nunca mistura tenants
  (`CustomFieldRegistryService` guarda o `tenantId` com que carregou).

## 3. Tipos de campo

Capacidades em `FIELD_TYPE_CATALOG` (o designer, a integridade e o servidor consultam-nas):

| Tipo              |      Escrito pelo utilizador       | Pesquisa | Filtro | Ordenar |     Único     | Regras específicas                                                                                                                                                 |
| ----------------- | :--------------------------------: | :------: | :----: | :-----: | :-----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| text, textarea    |                 ✔                  |    ✔     |   —    | text ✔  |    text ✔     | min/max comprimento, padrão                                                                                                                                        |
| number            |                 ✔                  |    —     |   ✔    |    ✔    |       ✔       | inteiro; min/max                                                                                                                                                   |
| decimal, currency |                 ✔                  |    —     |   —    |    ✔    |       —       | `scale` (decimal 0–10, moeda 0–6); sem aritmética de vírgula flutuante                                                                                             |
| boolean, checkbox |                 ✔                  |    —     |   ✔    |    —    |       —       | checkbox obrigatória = tem de estar marcada                                                                                                                        |
| date, datetime    |                 ✔                  |    —     |   —    |    ✔    |       —       |                                                                                                                                                                    |
| email, phone, url |                 ✔                  |    ✔     |   —    | email ✔ | email/phone ✔ | url só `http(s)`                                                                                                                                                   |
| select, radio     |                 ✔                  |    —     |   ✔    |    ✔    |       —       | opções `{value, label, active}`                                                                                                                                    |
| multiselect       |                 ✔                  |    —     |   —    |    —    |       —       | opções                                                                                                                                                             |
| file, image       |                 ✔                  |    —     |   —    |    —    |       —       | MIME (`image/*`), tamanho máx. (≤ 50 MB), «um ficheiro» — validado no servidor. O mock guarda metadados (nome, tamanho, tipo); o conteúdo binário é do backend/DMS |
| entity-reference  |                 ✔                  |    —     |   —    |    —    |       —       | a entidade existe; o registo existe **no mesmo tenant**                                                                                                            |
| user-reference    |                 ✔                  |    —     |   —    |    —    |       —       | só membros do tenant; o directório devolve apenas id e nome                                                                                                        |
| **formula**       |            ✘ (servidor)            |    —     |   —    |    ✔    |       —       | ver abaixo                                                                                                                                                         |
| **lookup**        | ✔ (servidor, fatia 3.5; ver D-039) |    —     |   —    |    —    |       —       | ver abaixo                                                                                                                                                         |
| **auto-number**   |            ✘ (servidor)            |    ✔     |   —    |    ✔    |       —       | ver abaixo                                                                                                                                                         |

### Fórmulas (`core/dynamic/engine/formula.ts`)

Texto numa gramática restrita, **nunca JavaScript**: `+ - * /`, parênteses, `round(x, n)`, `min`, `max`,
`abs` e referências a campos. Aritmética **BigInt de ponto fixo** (12 casas internas, arredondamento
«meio afastado de zero»): `0,1 + 0,2 = 0,3` e `2,675 → 2,68`. Valor em falta ou divisão por zero ⇒
resultado vazio (nunca se assume zero). Limites: 500 caracteres, 100 elementos, profundidade 20.
Integridade: sintaxe; referências existentes, não arquivadas e **numéricas**; **dependência circular**
(directa ou indirecta) rejeitada; não mistura moedas; se usa um campo **sensível**, a fórmula tem de ser
sensível com a **mesma permissão de leitura** (o resultado não revela o que o utilizador não vê). O
servidor calcula na escrita e recalcula na leitura (reflecte a definição em vigor).

### Valores relacionados (`lookup`)

`{ relationField, sourceField, onMissing }`: lê um campo do registo apontado por um campo
`entity-reference` da mesma entidade. O servidor só devolve o valor se o utilizador puder ler a
entidade alvo (RBAC **e** políticas ABAC sobre esse registo), o módulo estiver disponível e o campo de
origem for legível; caso contrário fica vazio. Origem sensível ⇒ o lookup tem de ser sensível com a
mesma permissão. A origem não pode ser outro lookup (sem cadeias). `onMissing: 'error'` recusa guardar
um registo cuja relação aponta para o vazio.

### Numeração automática (`auto-number`)

`{ prefix, padding, start, reset: 'never' \| 'yearly' \| 'monthly' }`. Atribuída **pelo servidor** na
criação, sequência **por tenant + entidade + campo (+ período)**, sem reutilizar números (nem após
apagar), imutável e nunca aceite do cliente. Ex.: `EQ-2026-0007`.

## 4. Designers

Configuração → Core Dinâmico (permissão `configuration.forms.read`):

- **Campos personalizados** (`:entityKey/campos`): lista campos nativos (só leitura) e do tenant, com
  estado (rascunho/activo/arquivado). O **Custom Field Designer** (`CustomFieldDesigner`, reutilizável)
  adapta a configuração ao tipo (opções, precisão/moeda, limites, MIME/tamanho, entidade referenciada,
  expressão da fórmula, valor relacionado, numeração), mostra uma **pré-visualização** com o mesmo
  `DynamicField` dos formulários reais e valida localmente (o servidor volta a validar). Sem drag-and-drop.
- **Nova entidade / Editar** (`novo`, `:entityKey/editar`): identificação, campos (adicionar, editar,
  subir/descer, remover; os já publicados **arquivam-se**), pré-visualização do formulário gerado,
  _Guardar rascunho_, _Publicar_, _Descartar rascunho_. Reutiliza o `CustomFieldDesigner` em modo
  `owned`. A listagem, pesquisa, filtros, permissões `entities.<chave>.*`, auditoria e menu «Dados»
  são gerados.

Permissões do módulo `configuration.forms`: `read`, `manage` (rascunhos) e `publish` (publicar e
arquivar). O servidor exige a permissão certa em cada operação.

## 5. Versões e compatibilidade

- Um campo personalizado nasce **rascunho** (não aparece a ninguém) → **activo** (publicado) →
  **arquivado**. Um publicado não volta a rascunho.
- Uma entidade do tenant tem versões `draft` / `published` / `archived`; editar uma publicada cria um
  rascunho `vN+1`; publicar arquiva a anterior. Os registos guardam a `definitionVersion`.
- Regras (`diffField` / `diffDefinitions` / `checkPublishable`): **destrutivo (bloqueia)** — mudar o
  tipo, retirar opções (desactivam-se), diminuir a precisão ou mudar a moeda, mudar a entidade
  referenciada, remover um campo (arquiva-se); **aviso** — passar a obrigatório/único/sensível, mudar
  uma fórmula, uma numeração ou um valor relacionado; **seguro** — acrescentar opções, arquivar,
  mudar rótulos.
- **Apagar/arquivar um campo nunca apaga dados**: os valores continuam gravados, deixam de ser
  devolvidos, validados ou escritos, e preservam-se em cada actualização do registo.

## 6. Segurança (aplicada no servidor)

| Risco                            | Controlo                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ver campos de outro tenant       | tenant pelo contexto do pedido; o cliente ainda filtra por `tenantId` (defesa em profundidade); ids de outro tenant respondem 404                                      |
| Campo sensível                   | exige `permissions.read/write` explícitas (`entities.<entidade>.sensitive.*`); sem leitura o valor **nunca** é devolvido (listas, detalhe, resultado de create/update) |
| Contornar campos escondidos      | o servidor rejeita escrita sem permissão de escrita (422) e **filtros, pesquisa e ordenação por campos ilegíveis** (403/ignorados)                                     |
| Fórmula/lookup a vazar dados     | exigem a mesma protecção do campo de origem (integridade) e o lookup verifica RBAC+ABAC do alvo em cada leitura                                                        |
| Valores atribuídos pelo servidor | fórmulas, lookups e numeração são recusados se vierem do cliente                                                                                                       |
| Tipos desconhecidos              | tratados como só de leitura e sem capacidades; a integridade assinala-os; o servidor recusa criá-los                                                                   |
| Concorrência                     | `expectedVersion` (campos/entidades) e `expectedRowVersion` (registos) → 409                                                                                           |
| Auditoria                        | quem/quando em campos e entidades (`audit`), diferenças por campo nos registos (incluindo valores calculados)                                                          |

## 7. Contratos de API propostos

Todos recebem o tenant do contexto (`X-Tenant-Id` / token) e respondem 403/404 entre tenants.

```
GET    /api/custom-fields                                   → CustomFieldDefinition[] (todos os estados)
POST   /api/custom-fields                                   ← SaveCustomFieldInput          (manage; publish se state=active)
PUT    /api/custom-fields/{id}                              ← SaveCustomFieldInput + expectedVersion
POST   /api/custom-fields/{id}/archive | /activate          (publish)

GET    /api/entity-definitions                              → EntityDefinition[] (globais + do tenant, todas as versões)
PUT    /api/entity-definitions/{key}/draft                  ← SaveEntityDraftInput          (manage)
POST   /api/entity-definitions/{key}/publish                (publish; 422 com issues + alterações destrutivas)
DELETE /api/entity-definitions/{key}/draft                  (manage)

GET    /api/entities/{key}/records?page&pageSize&search&filters&sort
POST   /api/entities/{key}/records            PUT|DELETE  /api/entities/{key}/records/{id}
GET    /api/entities/{key}/records/{id}/audit
GET    /api/entities/{key}/lookup?search&ids                 (inclui o alvo especial `@user`)
```

Erros de definição: `422 { message, details: { issues: [{ severity, path, message }] } }`. Erros de
registo: `422 { details: { issues: [{ fieldKey, rule, message }] } }`.

## 8. Persistência proposta (PostgreSQL + JSONB)

Híbrida: metadados relacionais, valores em JSONB. Todas as tabelas têm `tenant_id` e **Row Level
Security** (`USING (tenant_id = current_setting('app.tenant_id')::uuid)`).

```sql
CREATE TABLE custom_entity_types (            -- entidades do tenant (e overrides)
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  key           text NOT NULL,                -- imutável; ^[a-z][a-z0-9-]{1,29}$
  version       int  NOT NULL,
  state         text NOT NULL CHECK (state IN ('draft','published','archived')),
  name_singular text NOT NULL,
  name_plural   text NOT NULL,                -- extra: nome no plural
  icon          text NOT NULL DEFAULT 'cube', -- extra
  description   text,
  definition    jsonb NOT NULL,               -- list, forms, statuses, workflow, permissions, audit
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  UNIQUE (tenant_id, key, version)
);
CREATE UNIQUE INDEX one_draft_per_entity  ON custom_entity_types (tenant_id, key) WHERE state = 'draft';
CREATE UNIQUE INDEX one_published_entity  ON custom_entity_types (tenant_id, key) WHERE state = 'published';

CREATE TABLE custom_field_definitions (       -- campos personalizados de entidades nativas
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  entity_kind   text NOT NULL CHECK (entity_kind IN ('core','custom')),
  entity_key    text NOT NULL,                -- referência estável (não o nome visível)
  code          text NOT NULL,                -- imutável; nunca reutilizado (mesmo arquivado)
  field_type    text NOT NULL,
  definition    jsonb NOT NULL,               -- FieldDefinition completo
  display_order int  NOT NULL,                -- nunca `order` (palavra reservada)
  show_in_list  boolean NOT NULL DEFAULT false,
  state         text NOT NULL CHECK (state IN ('draft','active','archived')),
  version       int  NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  UNIQUE (tenant_id, entity_kind, entity_key, code)
);

CREATE TABLE entity_records (                 -- registos de QUALQUER entidade dinâmica
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  entity_key          text NOT NULL,
  definition_version  int  NOT NULL,
  status              text,
  data                jsonb NOT NULL DEFAULT '{}',  -- valores dos campos (inclui personalizados e arquivados)
  row_version         int  NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL
);
CREATE INDEX entity_records_tenant_entity ON entity_records (tenant_id, entity_key, updated_at DESC);
CREATE INDEX entity_records_data_gin      ON entity_records USING gin (data jsonb_path_ops);
-- Campos únicos, ordenáveis ou muito filtrados ganham índices de expressão por campo, criados na
-- publicação do campo, ex.: CREATE UNIQUE INDEX ... ON entity_records (tenant_id, (data->>'codigo'))
--   WHERE entity_key = 'equipamento';

CREATE TABLE auto_number_sequences (          -- numeração automática (atómica)
  tenant_id uuid NOT NULL, entity_key text NOT NULL, field_code text NOT NULL,
  period    text NOT NULL DEFAULT '',         -- '', 'YYYY' ou 'YYYYMM'
  last_value bigint NOT NULL,
  PRIMARY KEY (tenant_id, entity_key, field_code, period)
);
-- Atribuição: INSERT ... ON CONFLICT DO UPDATE SET last_value = last_value + 1 RETURNING last_value
-- dentro da transacção que grava o registo (sem reutilização após ROLLBACK/DELETE).

CREATE TABLE entity_audit (                   -- auditoria de registos e de definições
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_key text NOT NULL, record_id uuid,
  action text NOT NULL, actor_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  changes jsonb NOT NULL
);
```

Notas: tipos numéricos exactos devem ser gravados como **texto decimal** em JSONB (ex.: `"1250.50"`)
ou `numeric` via colunas geradas, nunca como `float`, para preservar a precisão de moeda e fórmulas;
ficheiros/imagens guardam apenas metadados + referência ao DMS (o conteúdo vive no armazenamento de
objectos).

## 9. Casos de teste

| Caso                                                                                             | Onde está coberto                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **A** — Cliente: cada tenant vê só os seus campos personalizados                                 | `custom-field-registry.service.spec.ts`, `dynamic-form-field-types.spec.ts`                             |
| **B** — Nova entidade Viatura por metadados (formulário, listagem e validações gerados)          | `mock-entity-lifecycle.spec.ts` («Casos B e C»), `entity-designer-page.spec.ts`                         |
| **C** — Acrescentar `numeroChassis` depois: nova versão sem perder registos                      | `mock-entity-lifecycle.spec.ts` («Casos B e C»), `mock-entity-records.gateway.spec.ts`                  |
| **D** — Equipamento (código, designação, data, valor, responsável, estado) sem componentes novos | `mock-entity-lifecycle.spec.ts`, `entity-designer-page.spec.ts`                                         |
| Obrigatório, único, sensível, opções, tipo imutável, arquivar preserva dados                     | `mock-custom-field.gateway.spec.ts`, `custom-fields.spec.ts`, `validation-types.spec.ts`                |
| Segurança entre tenants e permissões (sensíveis, fórmulas, lookups, filtros ilegíveis)           | `custom-field-registry.service.spec.ts`, `mock-lookup.gateway.spec.ts`, `mock-entity-lifecycle.spec.ts` |
| Fórmulas, ciclos, aritmética exacta                                                              | `formula.spec.ts`, `formula-integrity.spec.ts`                                                          |
| Numeração automática                                                                             | `auto-number.spec.ts`, `mock-entity-lifecycle.spec.ts`                                                  |

## 10. Limitações conhecidas

- O mock é um servidor simulado em memória: os pedidos não persistem entre recarregamentos.
- Ficheiros e imagens: validação de tipo/tamanho no servidor; o armazenamento do conteúdo depende do
  DMS (fora do âmbito).
- A listagem de uma entidade criada no designer é gerada (primeiras colunas, campos
  pesquisáveis/filtráveis); o ajuste fino das colunas por campo (`showInList`) existe nos campos
  personalizados de entidades nativas, não ainda no designer de entidades.
- Formulários explícitos (secções) e fluxos de estados de entidades do tenant não são editados pelo
  designer de entidades (as já existentes preservam-nos).
- Pesquisa/filtro/ordenação por fórmulas e valores relacionados no servidor real exigem colunas ou
  índices de expressão materializados; o mock calcula em memória.
