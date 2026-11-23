# Relatório — Prompt 10 (vendas e facturação)

Estado: **Prompt 10 em curso** — 10.1 feito, no branch `claude/pensive-clarke-5gm075`. Decisão D-059. Antes de começar
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
