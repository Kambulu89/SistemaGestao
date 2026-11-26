/**
 * Catálogo de permissões, definido no código (fonte de verdade) e sincronizado para a tabela `permissions` com
 * `node ace catalog:sync`. Cada módulo acrescenta as suas aqui quando é implementado; nunca permissões sem rota que as use.
 */
export interface PermissionDefinition {
  code: string
  module: string
  description: string
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  {
    code: 'members.read',
    module: 'members',
    description: 'Ver os membros da empresa e os seus perfis.',
  },
  { code: 'members.invite', module: 'members', description: 'Convidar pessoas para a empresa.' },
  {
    code: 'members.manage',
    module: 'members',
    description:
      'Suspender, reactivar e atribuir ou retirar perfis a membros (nunca a si próprio).',
  },
  { code: 'roles.read', module: 'rbac', description: 'Ver perfis e permissões.' },
  {
    code: 'roles.manage',
    module: 'rbac',
    description: 'Criar, alterar e eliminar perfis (só com permissões que o próprio tem).',
  },
  {
    code: 'organization.read',
    module: 'organization',
    description: 'Ver entidades legais, filiais, departamentos, cargos e centros de custo.',
  },
  {
    code: 'organization.manage',
    module: 'organization',
    description: 'Criar, alterar e inactivar a estrutura organizacional.',
  },
  {
    code: 'subscription.read',
    module: 'subscription',
    description: 'Ver o plano, o estado da subscrição e as funcionalidades contratadas da empresa.',
  },
  {
    code: 'settings.read',
    module: 'settings',
    description:
      'Ver o perfil da empresa, configurações, câmbios, séries documentais e calendários.',
  },
  {
    code: 'settings.manage',
    module: 'settings',
    description:
      'Alterar o perfil da empresa, configurações, câmbios, séries documentais e calendários.',
  },
  {
    code: 'bank_accounts.read',
    module: 'settings',
    description: 'Ver as contas bancárias institucionais.',
  },
  {
    code: 'bank_accounts.manage',
    module: 'settings',
    description:
      'Registar e inactivar contas bancárias institucionais (com aprovação, se configurada).',
  },
  {
    code: 'audit.read',
    module: 'audit',
    description: 'Consultar o registo de auditoria da empresa.',
  },
  {
    code: 'approvals.read',
    module: 'approvals',
    description:
      'Ver todos os pedidos de aprovação da empresa (os próprios e os que decide vêem-se sempre).',
  },
  {
    code: 'approvals.request',
    module: 'approvals',
    description: 'Submeter pedidos de aprovação.',
  },
  {
    code: 'approvals.manage',
    module: 'approvals',
    description:
      'Gerir workflows de aprovação, cancelar qualquer pedido e ver ou revogar delegações de outros.',
  },
  {
    code: 'accounting.read',
    module: 'accounting',
    description: 'Ver planos de contas, exercícios, diários e lançamentos.',
  },
  {
    code: 'accounting.create',
    module: 'accounting',
    description: 'Criar, alterar e submeter lançamentos em rascunho.',
  },
  {
    code: 'accounting.approve',
    module: 'accounting',
    description: 'Aprovar ou rejeitar lançamentos submetidos (nunca os próprios).',
  },
  {
    code: 'accounting.post',
    module: 'accounting',
    description: 'Contabilizar lançamentos aprovados (passam a imutáveis).',
  },
  {
    code: 'accounting.reverse',
    module: 'accounting',
    description: 'Estornar lançamentos contabilizados.',
  },
  {
    code: 'accounting.close',
    module: 'accounting',
    description: 'Fechar períodos contabilísticos.',
  },
  {
    code: 'accounting.reopen',
    module: 'accounting',
    description: 'Reabrir períodos contabilísticos fechados.',
  },
  {
    code: 'accounting.settings',
    module: 'accounting',
    description: 'Gerir planos de contas, contas, exercícios e diários.',
  },
  {
    code: 'accounting.reports',
    module: 'accounting',
    description: 'Consultar razão e balancete (só lançamentos contabilizados).',
  },
  {
    code: 'accounting.analytics',
    module: 'accounting',
    description: 'Imputar linhas a centros de custo e dimensões e consultar o relatório analítico.',
  },
  {
    code: 'accounting.adjustments',
    module: 'accounting',
    description:
      'Gerir planos de regularização e provisões e gerar os seus rascunhos e as diferenças cambiais.',
  },
  {
    code: 'accounting.reconcile',
    module: 'accounting',
    description: 'Reconciliar linhas contabilizadas de uma conta e desfazer reconciliações.',
  },
  {
    code: 'accounting.statements',
    module: 'accounting',
    description: 'Redigir as notas às demonstrações financeiras.',
  },
  {
    code: 'fixed_assets.read',
    module: 'accounting',
    description: 'Consultar activos fixos, classes, mapa de depreciação e movimentos.',
  },
  {
    code: 'fixed_assets.manage',
    module: 'accounting',
    description: 'Gerir classes e fichas de activos fixos e registar transferências.',
  },
  {
    code: 'fixed_assets.post',
    module: 'accounting',
    description: 'Contabilizar aquisições, depreciações e abates de activos fixos (e anulá-los).',
  },
  {
    code: 'hr.read',
    module: 'hr',
    description: 'Ver colaboradores (dados profissionais) no âmbito atribuído.',
  },
  {
    code: 'hr.manage',
    module: 'hr',
    description:
      'Criar e alterar fichas de colaboradores, suspender e reactivar, no âmbito atribuído.',
  },
  {
    code: 'hr.sensitive',
    module: 'hr',
    description:
      'Ver e alterar dados pessoais (documentos, NIF, segurança social, morada, banco) e anexos dos colaboradores no âmbito atribuído.',
  },
  {
    code: 'hr.recruitment.read',
    module: 'hr',
    description:
      'Ver vagas, candidatos, candidaturas, entrevistas e propostas no âmbito atribuído.',
  },
  {
    code: 'hr.recruitment.manage',
    module: 'hr',
    description:
      'Criar vagas e candidatos, gerir candidaturas, entrevistas e propostas, e contratar, no âmbito atribuído.',
  },
  {
    code: 'hr.recruitment.approve',
    module: 'hr',
    description:
      'Aprovar vagas (remuneração autorizada) e propostas no âmbito atribuído, sem ser quem as preparou.',
  },
  {
    code: 'hr.contracts.read',
    module: 'hr',
    description:
      'Ver contratos de trabalho (condições, remuneração, adendas e histórico) no âmbito atribuído.',
  },
  {
    code: 'hr.contracts.manage',
    module: 'hr',
    description:
      'Criar, activar, suspender, terminar e alterar por adenda ou renovação contratos de trabalho no âmbito atribuído.',
  },
  {
    code: 'hr.leave.read',
    module: 'hr',
    description:
      'Ver pedidos de ausência e saldos de férias dos colaboradores no âmbito atribuído.',
  },
  {
    code: 'hr.leave.request',
    module: 'hr',
    description: 'Pedir férias e ausências para si próprio (self-service).',
  },
  {
    code: 'hr.leave.approve',
    module: 'hr',
    description: 'Aprovar ou recusar pedidos de ausência no âmbito atribuído (nunca os próprios).',
  },
  {
    code: 'hr.leave.manage',
    module: 'hr',
    description:
      'Registar ausências por conta dos colaboradores, gerar direitos de férias, ajustar saldos e cancelar ausências aprovadas, no âmbito atribuído.',
  },
  {
    code: 'hr.leave.settings',
    module: 'hr',
    description:
      'Configurar tipos de ausência e políticas de férias (versionadas, com fonte legal).',
  },
  {
    code: 'hr.compensation.read',
    module: 'hr',
    description:
      'Ver a remuneração dos colaboradores (componentes, histórico e propostas) no âmbito atribuído.',
  },
  {
    code: 'hr.compensation.manage',
    module: 'hr',
    description: 'Preparar e submeter propostas de compensação no âmbito atribuído.',
  },
  {
    code: 'hr.compensation.approve',
    module: 'hr',
    description:
      'Aprovar propostas de compensação no âmbito atribuído, nunca as que preparou nem a sua própria remuneração.',
  },
  {
    code: 'hr.compensation.settings',
    module: 'hr',
    description:
      'Configurar componentes de remuneração e a incidência de IRT e INSS por vigência (com fonte legal).',
  },
  {
    code: 'hr.loans.read',
    module: 'hr',
    description:
      'Ver adiantamentos e empréstimos dos colaboradores (plano de prestações e saldo) no âmbito atribuído.',
  },
  {
    code: 'hr.loans.manage',
    module: 'hr',
    description:
      'Preparar, submeter e cancelar pedidos de adiantamento ou empréstimo e registar pagamentos directos de prestações, no âmbito atribuído.',
  },
  {
    code: 'hr.loans.approve',
    module: 'hr',
    description:
      'Aprovar adiantamentos e empréstimos no âmbito atribuído, nunca os que preparou nem os seus.',
  },
  {
    code: 'hr.payroll.read',
    module: 'hr',
    description:
      'Ver processamentos salariais (lotes, recibos calculados e erros) da empresa ou das entidades legais atribuídas.',
  },
  {
    code: 'hr.payroll.manage',
    module: 'hr',
    description:
      'Preparar, calcular (simular), submeter, fechar e cancelar processamentos salariais da empresa ou das entidades legais atribuídas.',
  },
  {
    code: 'hr.payroll.approve',
    module: 'hr',
    description:
      'Aprovar processamentos salariais da empresa ou das entidades legais atribuídas, nunca os que preparou ou calculou nem um lote com o próprio recibo.',
  },
  {
    code: 'hr.payroll.pay',
    module: 'hr',
    description:
      'Registar pagamentos dos salários e das obrigações (IRT, INSS, descontos) de lotes fechados, da empresa ou das entidades legais atribuídas.',
  },
  {
    code: 'hr.payroll.settings',
    module: 'hr',
    description:
      'Configurar as regras de processamento (taxas de INSS, tabela de IRT, incidência do salário base) por vigência e com fonte.',
  },
  {
    code: 'hr.training.read',
    module: 'hr',
    description:
      'Ver sessões de formação e a formação, competências e certificados dos colaboradores no âmbito atribuído (o próprio com OWN).',
  },
  {
    code: 'hr.training.manage',
    module: 'hr',
    description:
      'Planear sessões de formação, inscrever, registar resultados, concluir e registar competências e certificados, no âmbito atribuído.',
  },
  {
    code: 'hr.training.settings',
    module: 'hr',
    description: 'Configurar o catálogo de formação: competências e cursos.',
  },
  {
    code: 'hr.discipline.read',
    module: 'hr',
    description:
      'Consultar processos disciplinares no âmbito atribuído (acesso restrito e auditado; nunca os próprios).',
  },
  {
    code: 'hr.discipline.manage',
    module: 'hr',
    description:
      'Abrir e instruir processos disciplinares e registar a decisão, no âmbito atribuído (nunca os próprios).',
  },
  {
    code: 'hr.terminations.read',
    module: 'hr',
    description:
      'Consultar processos de cessação, liquidação final e checklist de saída no âmbito atribuído (nunca o próprio).',
  },
  {
    code: 'hr.terminations.manage',
    module: 'hr',
    description:
      'Preparar cessações (motivo, aviso, indemnização com base legal, liquidação final), gerar o lote da liquidação e tratar a checklist de saída, no âmbito atribuído.',
  },
  {
    code: 'hr.terminations.approve',
    module: 'hr',
    description:
      'Aprovar ou devolver cessações no âmbito atribuído (nunca as que preparou ou submeteu); a aprovação termina o contrato.',
  },
  {
    code: 'hr.reports.read',
    module: 'hr',
    description:
      'Ver relatórios de RH (efectivos, rotatividade, férias) no âmbito atribuído; a folha salarial exige hr.payroll.read.',
  },
  {
    code: 'hr.settings',
    module: 'hr',
    description:
      'Configurar os recursos humanos (workflows de aprovação e limites de adiantamentos e empréstimos, com fonte).',
  },
  {
    code: 'inventory.read',
    module: 'inventory',
    description:
      'Consultar o catálogo do inventário: produtos, variantes, unidades, categorias e marcas.',
  },
  {
    code: 'inventory.products.manage',
    module: 'inventory',
    description:
      'Criar e alterar produtos e serviços, variantes, conversões de unidades, kits e imagens do produto.',
  },
  {
    code: 'inventory.warehouses.manage',
    module: 'inventory',
    description:
      'Criar e alterar armazéns, localizações e a lista de acesso, no âmbito atribuído (entidade legal ou filial).',
  },
  {
    code: 'inventory.stock.manage',
    module: 'inventory',
    description:
      'Mudar o estado do stock (livre, bloqueado, quarentena) nos armazéns do âmbito atribuído (entidade legal ou filial).',
  },
  {
    code: 'inventory.documents.manage',
    module: 'inventory',
    description:
      'Criar, editar, conferir, reabrir e anular documentos de entrada e saída de stock no âmbito atribuído.',
  },
  {
    code: 'inventory.documents.confirm',
    module: 'inventory',
    description:
      'Confirmar documentos de entrada e saída (movimenta o stock), fechar saldos e estornar confirmações no âmbito atribuído.',
  },
  {
    code: 'inventory.transfers.manage',
    module: 'inventory',
    description:
      'Pedir, separar e expedir transferências (no armazém de origem) e recebê-las (no de destino), no âmbito atribuído.',
  },
  {
    code: 'inventory.transfers.approve',
    module: 'inventory',
    description:
      'Aprovar ou rejeitar transferências (origem), aceitar as intragrupo e fechar perdas em trânsito (destino), no âmbito atribuído.',
  },
  {
    code: 'inventory.requisitions.request',
    module: 'inventory',
    description:
      'Criar e submeter requisições internas de stock para os departamentos do âmbito atribuído (ou só as próprias).',
  },
  {
    code: 'inventory.requisitions.approve',
    module: 'inventory',
    description:
      'Aprovar (reserva o stock) ou rejeitar requisições internas dos departamentos do âmbito atribuído.',
  },
  {
    code: 'inventory.requisitions.fulfil',
    module: 'inventory',
    description:
      'Separar, entregar (consumo) e libertar requisições internas nos armazéns do âmbito atribuído.',
  },
  {
    code: 'inventory.counts.manage',
    module: 'inventory',
    description:
      'Planear, iniciar e registar contagens físicas, acrescentar artigos encontrados e submeter para revisão nos armazéns do âmbito atribuído.',
  },
  {
    code: 'inventory.counts.approve',
    module: 'inventory',
    description:
      'Rever contagens (ver o sistema nas cegas), justificar diferenças, pedir recontagem e aprovar o ajuste de stock nos armazéns do âmbito atribuído.',
  },
  {
    code: 'inventory.lots.manage',
    module: 'inventory',
    description:
      'Bloquear, desbloquear e recolher lotes (o stock livre do lote passa a bloqueado) quando todos os armazéns com stock do lote estão no âmbito atribuído.',
  },
  {
    code: 'inventory.valuation.read',
    module: 'inventory',
    description:
      'Consultar o valor do stock (custo médio, camadas, livro de custo) e a reconciliação com a contabilidade das entidades legais do âmbito atribuído.',
  },
  {
    code: 'inventory.valuation.manage',
    module: 'inventory',
    description:
      'Ajustar o custo do stock existente e configurar as contas da reconciliação das entidades legais do âmbito atribuído.',
  },
  {
    code: 'inventory.integrations.post',
    module: 'inventory',
    description:
      'Integrar operações de Compras e Vendas (recepções de compra, reservas, entregas e devoluções de venda) nos armazéns do âmbito atribuído, pela API.',
  },
  {
    code: 'inventory.accounting.manage',
    module: 'inventory',
    description:
      'Ver e voltar a enviar ao motor de contabilização os eventos contabilísticos do inventário das entidades legais do âmbito atribuído.',
  },
  {
    code: 'inventory.settings',
    module: 'inventory',
    description:
      'Configurar o catálogo: unidades de medida, categorias (com classe contabilística) e marcas.',
  },
  {
    code: 'procurement.suppliers.read',
    module: 'procurement',
    description:
      'Consultar fornecedores, documentos, homologações e histórico (dados bancários mascarados).',
  },
  {
    code: 'procurement.suppliers.manage',
    module: 'procurement',
    description:
      'Criar e alterar fornecedores e a ficha do terceiro, contactos, documentos e contas bancárias, e pedir homologação.',
  },
  {
    code: 'procurement.suppliers.approve',
    module: 'procurement',
    description:
      'Homologar, recusar e suspender fornecedores e aprovar contas bancárias (nunca o que a própria pessoa pediu).',
  },
  {
    code: 'procurement.suppliers.bank',
    module: 'procurement',
    description:
      'Ver os dados bancários dos fornecedores por inteiro (sem esta permissão vêm mascarados).',
  },
  {
    code: 'procurement.requisitions.request',
    module: 'procurement',
    description:
      'Criar requisições de compra para os departamentos do âmbito (ou só as próprias), pedir aprovação, anular e copiar.',
  },
  {
    code: 'procurement.requisitions.approve',
    module: 'procurement',
    description:
      'Decidir as etapas de aprovação das requisições do âmbito (nunca as próprias nem duas etapas da mesma requisição).',
  },
  {
    code: 'procurement.requisitions.process',
    module: 'procurement',
    description:
      'Tratar requisições aprovadas da entidade ou filial: necessidades consolidadas e fecho do que fica por encomendar.',
  },
  {
    code: 'procurement.rfqs.read',
    module: 'procurement',
    description:
      'Consultar pedidos de cotação das entidades do âmbito, convidados, histórico e propostas (valores só depois da abertura).',
  },
  {
    code: 'procurement.rfqs.manage',
    module: 'procurement',
    description:
      'Criar, emitir, rever e anular pedidos de cotação, convidar fornecedores homologados, registar propostas e abri-las.',
  },
  {
    code: 'procurement.rfqs.approve',
    module: 'procurement',
    description:
      'Aprovar ou recusar adjudicações de pedidos de cotação das entidades do âmbito (nunca as que a própria pessoa submeteu).',
  },
  {
    code: 'procurement.orders.read',
    module: 'procurement',
    description:
      'Consultar ordens de compra das entidades do âmbito, linhas, aprovação, revisões e histórico.',
  },
  {
    code: 'procurement.orders.manage',
    module: 'procurement',
    description:
      'Criar e alterar ordens de compra, pedir aprovação, emitir, rever, anular e fechar o que fica por receber.',
  },
  {
    code: 'procurement.orders.approve',
    module: 'procurement',
    description:
      'Decidir as etapas de aprovação das ordens de compra do âmbito (nunca as que a própria pessoa submeteu nem duas etapas da mesma ronda).',
  },
  {
    code: 'procurement.contracts.read',
    module: 'procurement',
    description:
      'Consultar contratos de fornecedor das entidades do âmbito, preços, SLA, adendas e consumo.',
  },
  {
    code: 'procurement.contracts.manage',
    module: 'procurement',
    description:
      'Criar contratos, pedir aprovação, propor adendas e renovações, suspender, reactivar, terminar e anular.',
  },
  {
    code: 'procurement.contracts.approve',
    module: 'procurement',
    description:
      'Aprovar ou recusar contratos e adendas das entidades do âmbito (nunca os que a própria pessoa submeteu ou propôs).',
  },
  {
    code: 'procurement.receipts.read',
    module: 'procurement',
    description: 'Consultar recepções de compra e entregas previstas das entidades do âmbito.',
  },
  {
    code: 'procurement.receipts.manage',
    module: 'procurement',
    description:
      'Registar e confirmar recepções (entrada no inventário e aceitação de serviços), anular rascunhos e estornar.',
  },
  {
    code: 'procurement.returns.read',
    module: 'procurement',
    description:
      'Consultar devoluções a fornecedor e não conformidades das entidades do âmbito, com as evidências.',
  },
  {
    code: 'procurement.returns.manage',
    module: 'procurement',
    description:
      'Registar não conformidades e devoluções a fornecedor, juntar evidências, confirmar (saída do inventário) e anular rascunhos.',
  },
  {
    code: 'procurement.invoices.read',
    module: 'procurement',
    description:
      'Consultar facturas e notas de crédito de fornecedor das entidades do âmbito, conferência e divergências.',
  },
  {
    code: 'procurement.invoices.manage',
    module: 'procurement',
    description:
      'Registar facturas e notas de crédito de fornecedor, pedir a validação (conferência a três), validar notas de crédito, devolver ao fornecedor e anular.',
  },
  {
    code: 'procurement.invoices.approve',
    module: 'procurement',
    description:
      'Autorizar ou recusar as excepções da conferência das facturas do âmbito (nunca as que a própria pessoa pediu).',
  },
  {
    code: 'procurement.budgets.read',
    module: 'procurement',
    description:
      'Consultar a verba de compras por centro de custo e ano das entidades do âmbito: comprometido, realizado e disponível.',
  },
  {
    code: 'procurement.budgets.manage',
    module: 'procurement',
    description:
      'Definir e alterar a verba de compras por centro de custo e ano (bloquear ou só avisar o excesso).',
  },
  {
    code: 'procurement.payables.read',
    module: 'procurement',
    description:
      'Consultar as obrigações a pagar das facturas de fornecedor, pagamentos e contabilização das entidades do âmbito.',
  },
  {
    code: 'procurement.payables.pay',
    module: 'procurement',
    description:
      'Tesouraria: registar pagamentos de facturas de fornecedor (nunca acima do saldo) e repetir a contabilização falhada.',
  },
  {
    code: 'procurement.evaluations.read',
    module: 'procurement',
    description:
      'Consultar o mapa de avaliação dos fornecedores (qualidade, prazo, conformidade, custo) com as provas das entidades do âmbito.',
  },
  {
    code: 'procurement.evaluations.manage',
    module: 'procurement',
    description:
      'Publicar avaliações de fornecedores por período (no âmbito da empresa: as provas de todas as entidades).',
  },
  {
    code: 'procurement.settings',
    module: 'procurement',
    description:
      'Configurar as compras: tipos de documento exigidos, critérios de homologação, etapas de aprovação, tolerâncias da conferência de facturas e pesos da avaliação de fornecedores.',
  },
  {
    code: 'sales.customers.read',
    module: 'sales',
    description:
      'Consultar clientes: ficha, condições de venda, moradas, contactos e versões dos dados fiscais.',
  },
  {
    code: 'sales.customers.manage',
    module: 'sales',
    description:
      'Registar e alterar clientes (ficha do terceiro, condições, moradas, contactos), bloquear e inactivar com motivo.',
  },
  {
    code: 'sales.customers.credit',
    module: 'sales',
    description: 'Definir o limite de crédito dos clientes, com motivo (separado de quem vende).',
  },
  {
    code: 'sales.settings',
    module: 'sales',
    description: 'Configurar as vendas: segmentos de clientes.',
  },
  {
    code: 'sales.prices.read',
    module: 'sales',
    description: 'Consultar tabelas de preços, regras e limites de desconto, e simular preços.',
  },
  {
    code: 'sales.prices.manage',
    module: 'sales',
    description:
      'Preparar tabelas de preços e regras de desconto em rascunho, submetê-las, copiá-las e inactivá-las com motivo.',
  },
  {
    code: 'sales.prices.approve',
    module: 'sales',
    description:
      'Aprovar ou devolver tabelas de preços e regras de desconto submetidas por outra pessoa, e definir os limites de desconto manual.',
  },
  {
    code: 'sales.quotes.read',
    module: 'sales',
    description:
      'Consultar orçamentos e propostas (no âmbito: empresa, entidade legal ou só os próprios).',
  },
  {
    code: 'sales.quotes.manage',
    module: 'sales',
    description:
      'Preparar, submeter, enviar, rever e anular orçamentos e registar a aceitação ou recusa do cliente.',
  },
  {
    code: 'sales.quotes.approve',
    module: 'sales',
    description:
      'Aprovar ou devolver orçamentos com descontos acima do limite ou preço manual, submetidos por outra pessoa.',
  },
  {
    code: 'sales.orders.read',
    module: 'sales',
    description:
      'Consultar encomendas de venda (no âmbito: empresa, entidade legal ou só as próprias).',
  },
  {
    code: 'sales.orders.manage',
    module: 'sales',
    description:
      'Criar encomendas (também a partir de orçamentos aceites), submeter, fechar o resto e anular com motivo.',
  },
  {
    code: 'sales.orders.approve',
    module: 'sales',
    description:
      'Aprovar ou devolver encomendas com excepções de preço ou acima do limite de crédito, submetidas por outra pessoa.',
  },
  {
    code: 'sales.orders.fulfil',
    module: 'sales',
    description:
      'Reservar, libertar e expedir encomendas pelo Inventário; dar serviços por prestados.',
  },
  {
    code: 'sales.fiscal.read',
    module: 'sales',
    description:
      'Consultar impostos, taxas, isenções, arredondamento e séries fiscais; simular o cálculo.',
  },
  {
    code: 'sales.fiscal.manage',
    module: 'sales',
    description:
      'Preparar impostos, taxas e isenções (com a fonte legal), arredondamento, séries fiscais e a integração fiscal electrónica (contingência, fila), só em simulação.',
  },
  {
    code: 'sales.fiscal.confirm',
    module: 'sales',
    description:
      'Confirmar ou retirar taxas e isenções preparadas por outra pessoa, depois de verificadas na fonte oficial.',
  },
  {
    code: 'sales.invoices.read',
    module: 'sales',
    description: 'Consultar facturas de venda (no âmbito da entidade legal).',
  },
  {
    code: 'sales.invoices.manage',
    module: 'sales',
    description:
      'Preparar facturas em rascunho (de serviços ou a partir de encomendas expedidas) e descartá-las com motivo.',
  },
  {
    code: 'sales.invoices.issue',
    module: 'sales',
    description: 'Emitir facturas (numeração pela série fiscal; nesta fase só em simulação).',
  },
  {
    code: 'sales.receipts.read',
    module: 'sales',
    description:
      'Consultar recebimentos, recibos e adiantamentos de clientes (no âmbito da entidade legal).',
  },
  {
    code: 'sales.receipts.manage',
    module: 'sales',
    description:
      'Registar recebimentos com afectação a facturas (pendentes de confirmação), anulá-los e usar adiantamentos.',
  },
  {
    code: 'sales.receipts.confirm',
    module: 'sales',
    description:
      'Confirmar ou recusar recebimentos registados por outra pessoa (confirmação financeira): só então contam.',
  },
  {
    code: 'sales.collections.read',
    module: 'sales',
    description:
      'Consultar cobranças: contas a receber, antiguidade, limite e exposição, promessas e contactos (por entidade legal).',
  },
  {
    code: 'sales.collections.manage',
    module: 'sales',
    description:
      'Registar promessas de pagamento (não são pagamentos) e contactos de cobrança, e anular promessas em aberto.',
  },
  {
    code: 'sales.notes.read',
    module: 'sales',
    description: 'Consultar notas de crédito e débito e reembolsos (no âmbito da entidade legal).',
  },
  {
    code: 'sales.notes.manage',
    module: 'sales',
    description:
      'Preparar notas de crédito/débito sobre facturas emitidas, descartá-las e aplicar o crédito a outras facturas.',
  },
  {
    code: 'sales.notes.issue',
    module: 'sales',
    description:
      'Emitir notas de crédito/débito (série fiscal em simulação); a de crédito nunca por quem a preparou.',
  },
]

export const PERMISSION_CODES: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.code))

/** Perfil de sistema criado em cada tenant: tem todas as permissões de tenant e não se edita nem elimina. */
export const TENANT_ADMIN_ROLE = 'tenant_admin'

/**
 * Âmbito de uma atribuição: toda a empresa, só registos próprios, ou uma entidade legal / filial / departamento (este
 * inclui os subdepartamentos). As equipas entram quando existir o cadastro de equipas.
 */
export type ScopeType = 'TENANT' | 'OWN' | 'LEGAL_ENTITY' | 'BRANCH' | 'DEPARTMENT'
export const SCOPE_TYPES: readonly ScopeType[] = [
  'TENANT',
  'OWN',
  'LEGAL_ENTITY',
  'BRANCH',
  'DEPARTMENT',
]
/** Âmbitos que exigem o identificador do alvo (`scopeId`). */
export const TARGETED_SCOPES: readonly ScopeType[] = ['LEGAL_ENTITY', 'BRANCH', 'DEPARTMENT']
