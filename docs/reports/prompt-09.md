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

## 9.4 Comparação e adjudicação

### Modelo

Migração `0046_create_rfq_awards`: `rfq_awards` (pesos com `CHECK` de soma 100, moeda de base e data do câmbio,
justificação, totais, submissão e decisão — quem decide ≠ quem submeteu por `CHECK`; uma viva por pedido por índice
único parcial; gatilho: em aprovação só a decisão/anulação, finais imutáveis, sem eliminação), `rfq_award_scores`
(nota de qualidade por fornecedor), `rfq_award_lines` (oferta escolhida, quantidade e fotografia dos valores; motivo
obrigatório quando não é a melhor por `CHECK`); notas e linhas só mudam em rascunho (gatilho).

### Backend e API (`/api/v1/procurement`)

- `POST /rfqs/:id/comparison` (mapa sem gravar, com pesos e notas), `POST /rfqs/:id/awards`, `GET|PUT /rfq-awards/:id`,
  `POST /rfq-awards/:id/{submit|approve|reject|cancel}`; filtro `pendingAward` na lista de pedidos; o pedido mostra as
  adjudicações e `can.award`.
- Permissão nova `procurement.rfqs.approve` (entidade legal), que também dá leitura dos pedidos.
- Erros: `WEIGHTS_SUM`, `QUALITY_REQUIRED`, `NOT_BEST`, `OVER_OFFER`, `OVER_REQUESTED`, `NO_RATE`, `QUOTE_EXPIRED`,
  `AWARD_EXISTS`, `AWARD_IN_PROGRESS`, `SELF_APPROVAL`, `INVALID_STATE`, versão (409). Todos os erros de validação
  (pesos, notas, justificação e linhas) vêm juntos.

### Ecrãs

Pedido de cotação → "Comparar e adjudicar" / "Mapa comparativo": pesos com a soma à vista, tabela de fornecedores
(total convertido, moeda e câmbio, prazos, validade, nota de qualidade), por linha as ofertas ordenadas pela pontuação
(detalhe por critério, "Melhor"), quantidade a adjudicar por oferta, motivo quando não é a melhor, "Escolher as
melhores por linha", justificação e erros das linhas com a linha e o fornecedor. Adjudicação: estado, totais na moeda
de base, critérios, justificação, linhas adjudicadas com câmbio e motivo, totais por fornecedor, submeter, aprovar,
recusar e anular com motivo, auditoria. Lista de pedidos com o filtro "Adjudicação por aprovar".

### Testes e evidências

- Unitário `procurement_awards_domain.spec.ts` (7): pesos (omissão, soma, inteiros, limites), notas, conversão (incluindo
  12,35 EUR × 1 012,3456789012), pontuação por linha (90/54,55/50,82 → 80,91; a melhor 94,84; sem câmbio; preço zero),
  desempate, validação das linhas (oferta alheia, caducada, sem câmbio, acima da oferta e da pedida, duplicada, motivo),
  segregação.
- Funcional `procurement_awards.spec.ts` (2): mapa com USD a 900 (900/810 por unidade, totais 10 260,00 e 64 260,00),
  pontuações e ordem, outros pesos mudam a ordem; outra entidade 404; leitor vê mas não adjudica; `QUALITY_REQUIRED`,
  justificação, `NOT_BEST`, `OVER_OFFER`, `OVER_REQUESTED`, oferta alheia; rascunho com fotografia (63 500,00 +
  1 330,00 = 64 830,00; 60 USD → 54 000,00) e totais por fornecedor; `AWARD_EXISTS`; edição com versão; submissão;
  `SELF_APPROVAL`; a base recusa mudar linhas, pesos e apagar; `AWARD_IN_PROGRESS`; filtro "por aprovar"; recusa com
  motivo; nova adjudicação aprovada por outra pessoa → pedido adjudicado; auditoria e cronologia. Segundo: EUR sem
  câmbio → sem pontuação e `NO_RATE`; proposta caducada → `QUOTE_EXPIRED`; anulação liberta o pedido.
- `isolation_matrix` (mapa, adjudicar, ler e todas as acções sobre uma adjudicação de outra empresa → 404; listas
  vazias), `routes_protection`, regressão de todo o backend; frontend `rfq-award-model.spec.ts`.
- Browser (6 passos, três execuções seguidas, sem erros na consola; comprador e aprovador): mapa a partir do pedido,
  soma dos pesos (90% recusado), notas de qualidade, melhor da linha 1 com 94,84, total do fornecedor em EUR convertido
  (71 400,00), "escolher as melhores", troca da linha 2 para uma oferta que não é a melhor (erro com linha e fornecedor
  até indicar o motivo; justificação obrigatória), adjudicação 70 830,00 AOA, submissão, quem submeteu não vê "Aprovar",
  o aprovador encontra-a em "por aprovar" e aprova, o pedido fica adjudicado; 390 px.
- Defeitos encontrados e corrigidos: os campos sem `app-field` na tabela usavam `appControl` (erro de injecção); a soma
  dos pesos não se actualizava ao escrever; o servidor parava na justificação sem validar as linhas (agora todos os
  erros juntos).

## 9.5 Ordens de compra

### Modelo

Migração `0047_create_purchase_orders`: `purchase_orders` (três estados com `CHECK`, ronda de aprovação, câmbio e
total funcional obrigatórios em aprovação, número ↔ revisão emitida ↔ data coerentes, totais conferidos; gatilho:
anulada final, número/série/entidade/fornecedor/moeda fixos depois de emitida, conteúdo fixo fora do rascunho/recusa,
sem eliminação), `purchase_order_lines` (valores conferidos, recebido + cancelado ≤ quantidade, afectado ≤ quantidade;
gatilho: livres em rascunho sem baixar do recebido/facturado, depois só as quantidades de recepção, facturação,
cancelamento e afectação mudam; linhas com movimento não se apagam), `purchase_order_approvals` (única por ronda e
etapa), `purchase_order_revisions` e `purchase_order_events` (só acréscimo).

### Backend e API (`/api/v1/procurement`)

- `GET|POST /orders`, `GET /orders/options`, `GET|PUT /orders/:id`,
  `POST /orders/:id/{submit|approve|reject|issue|revise|cancel|close}`, `POST /rfq-awards/:id/orders` (uma ordem em
  rascunho por fornecedor da adjudicação aprovada, com preço, imposto, moeda, prazo e referência da proposta).
- Lista com filtros dos três estados e "à espera da minha decisão". Anexos `purchase_order`.
- Erros: `NOT_QUALIFIED`, `WAREHOUSE_REQUIRED`, `OVER_OPEN`, `BELOW_RECEIVED`, `BELOW_INVOICED`, `LINE_HAS_RECEIPTS`,
  `LINE_HAS_MOVEMENT`, `NO_RATE`, `NO_SERIES`, `SELF_APPROVAL`, `SAME_APPROVER`, `ROLE_REQUIRED`, `AWARD_ALREADY_ORDERED`,
  `INVALID_STATE`, versão (409).

### Ecrãs

Compras → Ordens de compra (lista com os três estados), Nova/Editar (fornecedor com moeda e prazo por omissão,
entidade, filial, centro de custo, armazém, datas, condições; linhas da requisição, do catálogo ou livres com preço,
desconto, imposto e total calculado como no servidor), Ordem (os três estados, total funcional e câmbio, emissão e
revisão em curso, condições, cadeia de aprovação, linhas com recebido/facturado/em aberto, revisões, anexos,
cronologia, auditoria; pedir aprovação, aprovar/recusar, emitir, rever, fechar o resto, anular, com erros detalhados
no próprio ecrã). Nas necessidades consolidadas, "Encomendar"; na adjudicação aprovada, "Criar ordens de compra".

### Testes e evidências

- Unitário `procurement_orders_domain.spec.ts` (4): valores (6 × 1 000 −10% +14% = 6 156,00; 3 × 0,333333 −2,5% +14%;
  desconto total), estados de recepção e facturação, acções pelos três estados, validação das linhas e afectação.
- Funcional `procurement_orders.spec.ts` (2): validações e âmbito (fornecedor não homologado, outra entidade, armazém
  alheio, datas, acima do aberto, desconto); totais 11 000,00 − 600,00 + 756,00 = 11 156,00; `WAREHOUSE_REQUIRED`;
  recusa com motivo, edição, nova ronda (a etapa volta a decidir-se), aprovação; `NO_SERIES`; número; afectação à
  requisição (parcialmente encomendada, 6); a base recusa alterar a ordem emitida; revisão com motivo, fotografia,
  nova aprovação e emissão com o mesmo número, afectação 8; recepção parcial (simulada) impede anular; fecho do resto
  (5 cancelados devolvidos à requisição); histórico e auditoria. Segundo: da adjudicação aprovada (USD) uma ordem com
  preço, prazo e referência da proposta, `AWARD_ALREADY_ORDERED`; 13 680 USD × 900 → chefia e direcção;
  `SAME_APPROVER`, `ROLE_REQUIRED`, "à espera"; emissão encomenda a requisição; anulação devolve e permite refazer.
- `isolation_matrix` (leitura, todas as acções e ordens de uma adjudicação de outra empresa → 404; listas vazias),
  `routes_protection`, regressão de todo o backend; frontend `order-model.spec.ts`.
- Browser (6 passos, três execuções seguidas, sem erros na consola; comprador e aprovador): "Encomendar" a partir das
  necessidades com a linha da requisição, prazo do fornecedor, desconto e imposto, total 15 260,00 no ecrã; pedir
  aprovação sem armazém mostra o motivo; com armazém fica em aprovação e quem pede não vê "Aprovar"; o aprovador
  aprova pelo filtro "à espera"; emissão com número e requisição encomendada; revisão com motivo obrigatório, edição
  (14 260,00), nova aprovação e "Emitir revisão" com o mesmo número; 390 px.
- Defeitos encontrados e corrigidos: decisões por revisão faziam uma recusa contar como etapa decidida na nova
  submissão (passou a ronda); um `PUT` sem moeda repunha a moeda do fornecedor; o erro ao pedir aprovação só aparecia
  num aviso genérico.

## 9.6 Contratos de fornecedor

### Modelo

Migração `0048_create_purchase_contracts`: `purchase_contracts` (estados e motivos por `CHECK`, vigência, máximo e
consumido ≤ máximo, aprovação por outra pessoa; gatilho: conteúdo fixo fora do rascunho salvo ao aplicar uma adenda,
número/entidade/fornecedor/moeda fixos, terminado só aceita devoluções, sem eliminação), `purchase_contract_prices`
(produto/variante uma vez), `purchase_contract_slas`, `purchase_contract_amendments` (uma pendente por contrato;
decididas imutáveis; quem decide ≠ quem propôs), `purchase_contract_consumptions` (idempotentes, só acréscimo),
`purchase_contract_events`; `purchase_orders.contract_id` (fixo depois de emitida, também no gatilho das ordens).

### Backend e API (`/api/v1/procurement`)

- `GET|POST /contracts`, `GET /contracts/options`, `GET|PUT /contracts/:id`,
  `POST /contracts/:id/{submit|approve|reject|suspend|reactivate|terminate|cancel|amendments}`,
  `POST /contract-amendments/:id/{approve|reject|cancel}`; filtros por estado (incluindo caducado) e "a renovar".
- Ordens de compra: `contractId` no cabeçalho, contratos e preços nas opções, contrato na ficha; consumo na emissão,
  devolução no fecho do resto e na anulação (`consumeContract`).
- Permissões `procurement.contracts.read|manage|approve` (entidade legal). Anexos `purchase_contract`.
- Erros: `BEFORE_START`, `NOT_QUALIFIED`, `NO_SERIES`, `SELF_APPROVAL`, `AMENDMENT_PENDING`, `BELOW_CONSUMED`,
  `NOT_EXTENDED`, `NOTHING`, `CONTRACT_NOT_ACTIVE`, `CONTRACT_OUT_OF_TERM`, `CONTRACT_OTHER_SUPPLIER|ENTITY|CURRENCY`,
  `PRICE_ABOVE_CONTRACT`, `CONTRACT_EXCEEDED`, `INVALID_STATE`, versão (409).

### Ecrãs

Compras → Contratos de fornecedor (lista com estado efectivo e "a renovar"), Novo/Editar (entidade, fornecedor, objecto,
vigência, máximo, pagamento, renovação, tabela de preços e SLA), Contrato (estado, barra consumido/disponível/máximo,
condições, preços, SLA, adendas e renovações com aprovar/recusar/anular, ordens que o consomem, anexos, cronologia,
auditoria), Adenda e Renovar (o mesmo formulário, com motivo e data de efeito; fim pré-preenchido na renovação). Na
ordem de compra, a escolha do contrato (filtrado por entidade, fornecedor e moeda) sugere o preço acordado.

### Testes e evidências

- Unitário `procurement_contracts_domain.spec.ts` (5): estado efectivo e "a renovar", meses com fim de mês e anos
  bissextos, valor em vigor proporcional, validações de cabeçalho, preços e SLA, encaixe da ordem.
- Funcional `procurement_contracts.spec.ts` (2): validações e âmbito; recusa, edição, `NO_SERIES`, aprovação numerada;
  "a renovar"; a base recusa alterar directamente; adenda (máximo e preços) pendente única, decidida por outra pessoa,
  com o anterior guardado; renovação recusada, `NOT_EXTENDED`, aprovada (+12 meses); suspensão e reactivação.
  Segundo: encaixe (fornecedor, moeda, vigência, preço); consumo de 6 000,00 (líquido); `CONTRACT_EXCEEDED` ao pedir
  aprovação e na emissão (a ordem aprovada antes não emite quando outra esgota o saldo); `CHECK` acima do máximo; fecho
  do resto devolve 4 000,00; terminação recusa ordens novas mas aceita a devolução da anulação; contrato da ordem
  emitida fixo; caducado no filtro e recusado.
- Regressão encontrada e corrigida no 9.5: um `PUT` de ordem sem o produto numa linha existente apagava o produto
  (agora mantém o que não vem; verificado no teste das ordens).
- `isolation_matrix` (contrato e adenda de outra empresa: leitura e todas as acções → 404; listas vazias),
  `routes_protection`, regressão de todo o backend; frontend `contract-model.spec.ts` e `order-model.spec.ts`.
- Browser (6 passos, três execuções seguidas, sem erros na consola; comprador e aprovador): contrato pela navegação
  com preço e SLA, pedido de aprovação (quem pede não aprova), aprovação com número e "a renovar"; ordem com o contrato
  (preço 1 000 sugerido, 1 100 recusado com a mensagem do contrato), aprovação e emissão; o contrato mostra 6 000,00
  consumidos e 4 000,00 disponíveis e a ordem; renovação com motivo obrigatório (fim +12 meses pré-preenchido),
  aprovada por outra pessoa, novo fim e sem alerta; 390 px.

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
- 9.4: aprovação numa só etapa (sem níveis por valor nem workflows genéricos); nota de qualidade manual até ao 9.11;
  sem notificação automática ao aprovador (filtro "por aprovar"); a comparação usa o câmbio em vigor na data da
  abertura (o registado depois para essa data não conta se já houvesse outro).
- 9.5: o contrato do fornecedor entra no 9.6 (sem coluna provisória); sem PDF/envio da ordem ao fornecedor; as linhas
  retiradas numa revisão devolvem a afectação logo (não só na emissão); notificações aos aprovadores por filtro;
  recepção e facturação são escritas pelo 9.7/9.8 (aqui simuladas nos testes).
- 9.6: a renovação automática não corre sozinha (sem agendador): o alerta "a renovar" e a proposta de renovação são
  manuais; "caducado" é calculado na leitura; os SLA são medidos no 9.11; o máximo é líquido e na moeda do contrato
  (sem limites por quantidade ou por artigo); a aprovação do contrato é numa etapa.
