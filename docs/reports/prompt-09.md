# Relatório — Prompt 09 (compras)

Estado: **9.1 e 9.2 implementados e verificados** no branch `claude/pensive-clarke-5gm075`. Blocos 9.3 a 9.12 seguem, um de cada
vez. Decisões a partir de D-047.

## Inventário AS-IS → TO-BE

| Bloco            | Antes                                  | Agora                                                                                                                                                                                                                                                                                                                                                                   | Estado    |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 9.1 Fornecedores | Sem terceiros nem compras na aplicação | Terceiro reutilizável (fornecedor e, no Prompt 10, cliente); ficha com NIF por país, contactos e morada; condições comerciais; documentos com validade e ficheiro; critérios e tipos de documento configuráveis; homologação segregada com validade derivada dos documentos; dados bancários protegidos com aprovação de outra pessoa; suspensão; histórico e auditoria | Feito     |
| 9.2–9.11         | —                                      | Requisições, RFQ, comparação, ordens, contratos, recepções, facturas, devoluções, orçamento/finance, avaliação                                                                                                                                                                                                                                                          | Por fazer |
| 9.12 QA          | —                                      | —                                                                                                                                                                                                                                                                                                                                                                       | Por fazer |

## 9.1 Fornecedores

### Modelo

Migração `0043_create_partners_and_suppliers`: `business_partners` (NIF único por país quando indicado),
`business_partner_contacts` (um principal activo), `suppliers` (um por terceiro; estados; `CHECK` de prazos e mínimo),
`supplier_document_types` e `supplier_criteria`, `supplier_documents` (conteúdo fixo, só se desactiva com motivo; anexo
do fornecedor), `supplier_reviews` + `supplier_review_items` (um pedido pendente por fornecedor; fixos depois de
decididos; quem submete não decide), `supplier_bank_accounts` (conteúdo fixo; quem regista não aprova; IBAN único por
fornecedor entre as contas pendentes e activas), `supplier_events` (só acréscimo).

### Backend e API (`/api/v1/procurement`)

- `partners` (módulo novo, sem rotas): `createPartner`, `updatePartner`, `partnerByTaxId`, `partnerView`, contactos.
- `GET|POST /suppliers`, `GET /suppliers/lookup?countryCode=&taxId=`, `GET|PATCH /suppliers/:id`,
  `POST /suppliers/:id/contacts`, `PATCH /suppliers/:id/contacts/:contactId`, `POST /suppliers/:id/bank-accounts`,
  `POST /supplier-bank-accounts/:id/{approve|reject|deactivate}`, `POST /suppliers/:id/documents`,
  `POST /supplier-documents/:id/deactivate`, `POST /suppliers/:id/{submit|approve|reject|suspend}`,
  `GET|POST /settings/{document-types|criteria}`, `PATCH /settings/{kind}/:id`.
- Contrato para os blocos seguintes: `supplierStanding(scope, id)` → estado, homologação válida e `canOrder`.
- Anexos com o assunto `supplier` (ler com qualquer permissão de fornecedores; acrescentar com `.manage`).
- Permissões: `procurement.suppliers.read|manage|approve|bank`, `procurement.settings`; funcionalidade `procurement`.
- Erros: `TAX_ID_TAKEN` (com o terceiro existente), `ALREADY_SUPPLIER`, `NOT_QUALIFIED` (o que falta ou caducou),
  `REQUIRED_NOT_MET`, `MISSING`, `SELF_APPROVAL`, `FIXED`, `IBAN_EXISTS`, `INVALID_STATE`, `OUT_OF_SCOPE`.

### Ecrãs

Compras → Fornecedores (pesquisa por código, nome ou NIF; filtros de estado e tipo na URL; documentos em dia por linha),
Novo/Editar fornecedor (terceiro e condições; NIF já existente assinalado com a opção de reutilizar o terceiro),
Fornecedor (estado e validade da homologação, condições, contactos, dados bancários com aprovação por linha, documentos
com validade e ficheiro, anexos, pedidos de homologação com a avaliação, cronologia, auditoria) e Configuração das
compras (tipos de documento e critérios). Acções com consequências pedem confirmação; recusas, suspensões e
desactivações pedem motivo.

### Testes e evidências

- Unitário `procurement_suppliers_domain.spec.ts` (2): validade derivada dos documentos (em falta, caducado, a caducar,
  renovação, válido até hoje inclusive), avaliação dos critérios, validações da ficha e das condições.
- Funcional `procurement_suppliers.spec.ts` (3): ficha, NIF repetido aponta para o terceiro existente, um papel por
  terceiro, contactos com um principal, homologação recusada sem documentos e com obrigatório não cumprido, documento
  caducado e renovado, recusa com motivo, quem pede não decide (mesmo com a permissão), versão antiga recusada,
  homologação com a avaliação e os documentos guardados, NIF fixo depois de homologado, documento desactivado faz a
  homologação deixar de valer, suspensão, histórico completo; a base recusa reescrever revisões, linhas, histórico e
  documentos. Dados bancários: IBAN inválido e em falta, pendente até outra pessoa aprovar, quem regista não aprova
  (nem com a permissão), mascarados sem `.bank`, recusa com motivo, conta recusada não se mexe, desactivação; a base
  recusa reescrever e auto-aprovar; o IBAN inteiro não aparece na auditoria nem no histórico. Configuração com
  permissão própria, código fixo, tipo inactivo deixa de ser exigido; sem permissões, 403.
- `isolation_matrix` (leitura e todas as escritas de fornecedores, contas, documentos, homologação e configuração
  contra outra empresa → 404; listas vazias; pesquisa de NIF não vê terceiros alheios; cabeçalho forjado recusado),
  `routes_protection`, `schema_conformance`, regressão de todo o backend; frontend `supplier-model.spec.ts`.
- Browser (7 passos, três execuções seguidas depois dos ajustes, mais uma de confirmação; sem erros na consola; dois
  utilizadores): novo fornecedor pela navegação, contacto, IBAN inválido recusado, conta pendente aprovada por outra
  pessoa (que a vê por inteiro), PDF carregado e ligado ao documento obrigatório, pedido de homologação com critério
  não cumprido recusado e depois aceite, homologação pelo aprovador, lista filtrada, NIF repetido assinalado, 390 px.
  A primeira passagem apanhou um defeito da interface (o botão "Aprovar" da conta aparecia a quem a registou — o
  servidor recusaria): passou a vir do servidor por conta (`canDecide`).

## 9.2 Requisições de compra

### Modelo

Migração `0044_create_purchase_requisitions`: `purchase_approval_levels` (ordem, mínimo, entidade e perfil
opcionais), `purchase_requisitions` (totais conferidos pela base; fora do rascunho tem número, total funcional e
etapas fixadas; fixa fora do rascunho, recusada/anulada imutáveis), `purchase_requisition_lines` (quantidades
encomendadas + fechadas ≤ quantidade; só estas mudam fora do rascunho), `purchase_requisition_approvals` (uma por
etapa, só acréscimo), `purchase_requisition_allocations` (idempotentes, só acréscimo), `purchase_requisition_events`.

### Backend e API (`/api/v1/procurement`)

- `GET|POST /requisitions`, `GET /requisitions/options`, `GET /requisitions/demand`, `GET|PUT /requisitions/:id`,
  `POST /requisitions/:id/{submit|approve|reject|cancel|close|copy}`, `GET|POST /approval-levels`,
  `PATCH /approval-levels/:id`.
- Lista com filtros de estado, prioridade, "pedidas por mim" e "à espera da minha decisão" (a etapa actual é minha).
- Contrato `allocateRequisition(scope, { lineId, quantity, sourceType, sourceId, idempotencyKey })` para o 9.3/9.5.
- Permissões: `procurement.requisitions.request|approve` (departamento, filial, entidade; pedir também "só as
  próprias") e `.process` (entidade, filial); etapas com `procurement.settings`.
- Erros: `OUT_OF_SCOPE`, `NO_SERIES`, `NO_RATE`, `SELF_APPROVAL`, `SAME_APPROVER`, `ROLE_REQUIRED`, `INVALID_STATE`,
  `OVER_ALLOCATED`, `OVER_RELEASED`, `IDEMPOTENCY_MISMATCH`, `CODE_TAKEN`.

### Ecrãs

Compras → Requisições de compra (lista com filtros na URL), Nova/Editar (departamento, centro de custo, prioridade,
necessidade, finalidade, orçamento, moeda; linhas com produto ou descrição livre, quantidade, unidade, preço, imposto,
entrega e fornecedor sugerido; total por linha e geral calculados como no servidor), Requisição (estado, cadeia de
aprovação com a etapa actual, motivo quando não pode decidir, acções com confirmação ou motivo, linhas com encomendado e
em aberto, cronologia, auditoria), Necessidades consolidadas e Etapas de aprovação das compras.

### Testes e evidências

- Unitário `procurement_requisitions_domain.spec.ts` (3): valores ao cêntimo (incluindo 3 × 0,333333 com 6,5%),
  conversão funcional, etapas exigidas, quem decide a seguinte (solicitante, mesma pessoa, perfil), estados do
  atendimento, validação das linhas — apanhou que `2026-02-30` passava como data (corrigido também no 9.1).
- Funcional `procurement_requisitions.spec.ts` (2): validações e âmbito; totais 12 500,50 + 1 400,00 = 13 900,50;
  edição com versão; `NO_SERIES`; número; a chefia vê-a "à espera"; duas chefias em simultâneo → uma decide (200 +
  409); em USD sem câmbio → `NO_RATE`, com câmbio 540 000 000,00 AOA → chefia e direcção; `ROLE_REQUIRED`, quem
  decidiu a etapa 1 não decide a 2, director aprova; recusa com motivo, cópia, anulação; a base recusa alterar linhas,
  totais e decisões. Atendimento: necessidades consolidadas (15 bombas de duas requisições, 15 500,00, necessidade
  mais cedo), afectação parcial, repetição, chave reutilizada, acima do aberto, devolução, fecho do resto pelo
  comprador, devolução numa fechada, âmbito por departamento, sem permissões nada; configuração com código repetido e
  sem permissão.
- `isolation_matrix` (leitura e todas as acções sobre uma requisição e uma etapa de outra empresa → 404; listas vazias;
  cabeçalho forjado recusado), `routes_protection`, regressão de todo o backend; frontend `requisition-model.spec.ts`.
- Browser (7 passos, três execuções seguidas, sem erros na consola; três utilizadores — solicitante, aprovador,
  comprador): requisição pela navegação com duas linhas e total 13 900,50 calculado no ecrã, pedido de aprovação com
  número, quem pede não vê "Aprovar", o aprovador encontra-a em "à espera da minha decisão" e aprova, necessidades
  consolidadas, fecho do resto, recusa com motivo obrigatório e cópia, 390 px.
- Defeitos encontrados e corrigidos: anular um rascunho violava a restrição de número (500 → regra ajustada); o trilho
  de navegação continuava em "Rascunho" depois de a requisição receber número.

## Pendências

- 9.1: a homologação é uma decisão directa segregada (não usa os workflows de aprovação em várias etapas); não há aviso
  automático de documentos a caducar (não há agendador — a validade é calculada na leitura); o NIF valida-se só no
  formato (as regras de cada país não são verificadas); fornecedores são da empresa inteira (sem âmbito por entidade
  legal); categorias de fornecedor e a avaliação (score) são do 9.11.
- 9.2: o compromisso orçamental (bloquear verba) é do 9.10 — aqui só a referência de orçamento; sem notificação
  automática aos aprovadores (usam o filtro "à espera da minha decisão"); com várias séries activas para a entidade
  usa-se a primeira por código; as etapas não usam os workflows genéricos de aprovação; produtos para as linhas vêm de
  uma lista (até 1000), sem pesquisa incremental.
