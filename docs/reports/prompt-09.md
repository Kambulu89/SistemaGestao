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

## 9.3 Pedidos de cotação

### Modelo

Migração `0045_create_rfqs`: `rfqs` (estado, número e emissão coerentes por `CHECK`; fixos depois do rascunho:
número, entidade, moeda, envelope; anulado/adjudicado imutável; sem eliminação), `rfq_lines` (livres no rascunho,
depois só quantidade/especificações), `rfq_invitations` (uma por fornecedor; recusa com motivo), `rfq_quotes` (versão
por fornecedor, revisão do pedido a que responde, uma só em vigor por fornecedor — índice único parcial; imutáveis
salvo o estado), `rfq_quote_lines` (principal e alternativas 0–9, só acréscimo), `rfq_events` (só acréscimo).

### Backend e API (`/api/v1/procurement`)

- `GET|POST /rfqs`, `GET /rfqs/options`, `GET|PUT /rfqs/:id`, `POST /rfqs/:id/{invitations|issue|amend|quotes|open|cancel}`,
  `DELETE /rfq-invitations/:id`, `POST /rfq-invitations/:id/decline`, `POST /rfq-quotes/:id/withdraw`.
- Anexos do pedido (`subjectType` `rfq`) com o mesmo âmbito; a proposta pode referir um anexo do pedido.
- Permissões `procurement.rfqs.read|manage` (entidade legal). Erros: `OUT_OF_SCOPE`, `NOT_QUALIFIED`, `NO_SERIES`,
  `PAST`, `NOT_INVITED`, `DECLINED`, `QUOTE_LATE`, `EARLY_OPENING`, `NO_MAIN_OFFER`, `INVALID_STATE`, versão (409).

### Ecrãs

Compras → Pedidos de cotação (lista com estado, prazo, convidados e propostas), Novo/Editar (entidade, título, prazo
com hora, condições, especificações, envelope; linhas da requisição, do catálogo ou livres; convidados homologados),
Pedido (estado, prazo e revisão; emitir, registar proposta com alternativas e total calculado como no servidor, rever
com motivo, registar recusa, retirar proposta, abrir propostas, anular; convidar mais; propostas por fornecedor com
versões — no envelope fechado só "chegou", sem valores; anexos; cronologia; auditoria). Nas necessidades
consolidadas, "Pedir cotação" abre o formulário já com a entidade e as linhas da requisição.

### Testes e evidências

- Unitário `procurement_rfqs_domain.spec.ts` (5): envelope, regra de abertura, fases, totais exactos só das principais
  (3 × 0,333333 + 14%; 1,5 × 100,01 + 7%), validações das linhas (linha alheia, alternativa sem descrição, quantidade,
  preço, taxa, prazo, duplicados, alternativa 10).
- Funcional `procurement_rfqs.spec.ts` (2): validações, âmbito por entidade (outra entidade 404/`OUT_OF_SCOPE`, leitor
  sem gestão); linha da requisição traz produto, unidade, 10 em aberto e número; convite a não homologado recusado;
  retirar convidado no rascunho; `NO_SERIES`; versão antiga 409; número; emitido não se edita nem se retira convidado;
  a base recusa mudar número, moeda, descrição de linha e apagar; proposta de não convidado, alternativa sem descrição,
  linha alheia, validade passada, leitor; envelope sem valores (API, leitor, auditoria, cronologia); versão 2 substitui a
  1 (imutável na base); `EARLY_OPENING`; revisão com motivo → revisão 1, proposta desactualizada; recusa com motivo,
  proposta de quem declinou recusada; abertura → 15 005,00 + 2 100,70 = 42 105,70 com a alternativa à parte; fechado
  sem propostas nem revisões; anulação com motivo; cronologia completa; a requisição não foi consumida; acções
  auditadas. Segundo: envelope aberto mostra logo os valores; retirar proposta (motivo, repetida recusada); prazo
  passado → `QUOTE_LATE` e abertura sem todos; emissão com prazo passado recusada; filtro por estado.
- `isolation_matrix` (leitura e todas as acções sobre um pedido de outra empresa → 404; listas vazias; cabeçalho
  forjado recusado), `routes_protection`, regressão de todo o backend; frontend `rfq-model.spec.ts`.
- Browser (8 passos, três execuções seguidas, sem erros na consola; comprador, homologador e leitor): das necessidades
  consolidadas "Pedir cotação" abre o formulário com a linha da requisição (10 em aberto); dois convidados; emissão com
  número; proposta com alternativa e total 17 100,00 calculado no ecrã; envelope fechado — nem o comprador nem o leitor
  vêem valores e o leitor não vê acções; revisão com motivo obrigatório → quantidade 12 e proposta "feita à revisão 0";
  recusa do segundo fornecedor; abertura antes do prazo → 17 100,00 AOA visível para ambos; lista e cronologia; 390 px.
- Defeitos encontrados e corrigidos: ao converter quantidades da API para o formulário, um valor sem casas decimais
  ("10") perdia o zero final (passou a usar `plain`, com teste); o rótulo de auditoria de `rfq.issued` dizia "Entregue"
  (os rótulos passam a aceitar a acção completa).

## Pendências

- 9.1: a homologação é uma decisão directa segregada (não usa os workflows de aprovação em várias etapas); não há aviso
  automático de documentos a caducar (não há agendador — a validade é calculada na leitura); o NIF valida-se só no
  formato (as regras de cada país não são verificadas); fornecedores são da empresa inteira (sem âmbito por entidade
  legal); categorias de fornecedor e a avaliação (score) são do 9.11.
- 9.2: o compromisso orçamental (bloquear verba) é do 9.10 — aqui só a referência de orçamento; sem notificação
  automática aos aprovadores (usam o filtro "à espera da minha decisão"); com várias séries activas para a entidade
  usa-se a primeira por código; as etapas não usam os workflows genéricos de aprovação; produtos para as linhas vêm de
  uma lista (até 1000), sem pesquisa incremental.
- 9.3: as propostas são registadas pelo comprador (sem portal do fornecedor nem envio de convites por e-mail); sem
  aviso automático do fim do prazo (não há agendador); a adjudicação e o mapa comparativo são do 9.4; o pedido não
  consome quantidade da requisição (fica para a ordem de compra, 9.5); com várias séries `RFQ` activas usa-se a
  primeira por código.
