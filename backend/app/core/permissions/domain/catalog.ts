/**
 * Catálogo de permissões do núcleo (D-014: `<recurso>.<acção>`, igual à especificação). Cada módulo
 * acrescenta as suas quando existir; o catálogo é semeado a partir daqui (idempotente).
 * Papéis de plataforma (`platform.*`) **não** pertencem a este catálogo: nunca são papéis de tenant.
 */
export interface PermissionDefinition {
  code: string
  moduleCode: string
  description: string
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  {
    code: 'iam.read',
    moduleCode: 'iam',
    description: 'Ver papéis, permissões, atribuições e políticas.',
  },
  {
    code: 'iam.manage',
    moduleCode: 'iam',
    description: 'Gerir papéis, atribuições, políticas e simular acessos.',
  },
  { code: 'member.read', moduleCode: 'member', description: 'Ver os membros do tenant.' },
  { code: 'member.invite', moduleCode: 'member', description: 'Convidar membros.' },
  {
    code: 'member.manage',
    moduleCode: 'member',
    description: 'Gerir membros (suspender, terminar).',
  },
  {
    code: 'organization.read',
    moduleCode: 'organization',
    description: 'Ver organizações e unidades.',
  },
  {
    code: 'organization.manage',
    moduleCode: 'organization',
    description: 'Gerir organizações e unidades.',
  },
  { code: 'party.read', moduleCode: 'party', description: 'Ver pessoas e organizações externas.' },
  {
    code: 'party.create',
    moduleCode: 'party',
    description: 'Criar pessoas e organizações externas.',
  },
  {
    code: 'party.update',
    moduleCode: 'party',
    description: 'Alterar pessoas, contactos, moradas e relações.',
  },
  {
    code: 'settings.read',
    moduleCode: 'settings',
    description: 'Ver configurações, impostos, unidades de medida e sequências.',
  },
  {
    code: 'settings.manage',
    moduleCode: 'settings',
    description: 'Alterar configurações, impostos e unidades de medida.',
  },
  {
    code: 'sequence.manage',
    moduleCode: 'settings',
    description: 'Criar e alterar sequências de numeração.',
  },
  {
    code: 'module.read',
    moduleCode: 'modules',
    description: 'Ver o catálogo de módulos e funcionalidades do tenant.',
  },
  {
    code: 'module.manage',
    moduleCode: 'modules',
    description: 'Activar e desactivar módulos e funcionalidades do tenant.',
  },
  {
    code: 'subscription.read',
    moduleCode: 'billing',
    description: 'Ver o plano contratado, o consumo e os limites do tenant.',
  },
  {
    code: 'entity.read',
    moduleCode: 'dynamic',
    description: 'Ver as definições de entidades dinâmicas, os seus campos e versões.',
  },
  {
    code: 'entity.design',
    moduleCode: 'dynamic',
    description: 'Criar e editar rascunhos de entidades dinâmicas e dos seus campos.',
  },
  {
    code: 'entity.publish',
    moduleCode: 'dynamic',
    description: 'Publicar versões de entidades dinâmicas e arquivar entidades.',
  },
  {
    code: 'dynamic.read',
    moduleCode: 'dynamic',
    description: 'Ver registos de entidades dinâmicas (restringível por entidade com políticas).',
  },
  {
    code: 'dynamic.create',
    moduleCode: 'dynamic',
    description: 'Criar registos de entidades dinâmicas.',
  },
  {
    code: 'dynamic.update',
    moduleCode: 'dynamic',
    description: 'Alterar registos de entidades dinâmicas.',
  },
  {
    code: 'dynamic.archive',
    moduleCode: 'dynamic',
    description: 'Arquivar registos de entidades dinâmicas.',
  },
  {
    code: 'dynamic.sensitive',
    moduleCode: 'dynamic',
    description: 'Ver e escrever campos marcados como sensíveis nas entidades dinâmicas.',
  },
  {
    code: 'dynamic.all',
    moduleCode: 'dynamic',
    description: 'Aceder aos registos de todos os responsáveis em entidades de modo OWNER.',
  },
  {
    code: 'rule.read',
    moduleCode: 'dynamic',
    description: 'Ver regras de validação, as suas revisões e avaliações.',
  },
  {
    code: 'rule.manage',
    moduleCode: 'dynamic',
    description: 'Criar, simular, publicar e desactivar regras de validação.',
  },
  {
    code: 'form.read',
    moduleCode: 'dynamic',
    description: 'Ver formulários, as suas revisões e a verificação contra a entidade.',
  },
  {
    code: 'form.design',
    moduleCode: 'dynamic',
    description: 'Criar formulários e alterar rascunhos.',
  },
  {
    code: 'form.publish',
    moduleCode: 'dynamic',
    description: 'Publicar e retirar formulários.',
  },
  {
    code: 'dynamic.transition',
    moduleCode: 'dynamic',
    description: 'Executar transições de estado nos registos das entidades dinâmicas.',
  },
  {
    code: 'state.read',
    moduleCode: 'dynamic',
    description: 'Ver máquinas de estados e as suas revisões.',
  },
  {
    code: 'state.design',
    moduleCode: 'dynamic',
    description: 'Criar máquinas de estados e alterar rascunhos.',
  },
  {
    code: 'state.publish',
    moduleCode: 'dynamic',
    description: 'Publicar e retirar máquinas de estados.',
  },
  {
    code: 'workflow.read',
    moduleCode: 'dynamic',
    description: 'Ver workflows, as suas revisões e todos os processos de aprovação.',
  },
  {
    code: 'workflow.design',
    moduleCode: 'dynamic',
    description: 'Criar workflows e alterar rascunhos.',
  },
  {
    code: 'workflow.publish',
    moduleCode: 'dynamic',
    description: 'Publicar e retirar workflows.',
  },
  {
    code: 'workflow.submit',
    moduleCode: 'dynamic',
    description: 'Submeter registos das entidades dinâmicas a um processo de aprovação.',
  },
  {
    code: 'approval.decide',
    moduleCode: 'dynamic',
    description:
      'Ver a caixa de aprovações, reclamar tarefas de grupo e aprovar, rejeitar ou devolver.',
  },
  {
    code: 'approval.delegate',
    moduleCode: 'dynamic',
    description: 'Delegar as próprias aprovações noutro membro, por um período limitado.',
  },
  {
    code: 'automation.read',
    moduleCode: 'dynamic',
    description:
      'Ver automações, o catálogo de eventos e acções, simular e consultar o histórico de execuções.',
  },
  {
    code: 'automation.manage',
    moduleCode: 'dynamic',
    description: 'Definir, activar e pausar automações e reprocessar execuções falhadas.',
  },
  {
    code: 'catalog.read',
    moduleCode: 'catalog',
    description: 'Ver categorias, produtos e variantes do catálogo.',
  },
  {
    code: 'catalog.manage',
    moduleCode: 'catalog',
    description: 'Criar e alterar categorias, produtos e variantes (nada se apaga: desactiva-se).',
  },
  {
    code: 'price.read',
    moduleCode: 'catalog',
    description: 'Ver tabelas de preços e resolver o preço de uma variante.',
  },
  {
    code: 'price.manage',
    moduleCode: 'catalog',
    description: 'Criar e alterar tabelas de preços e os seus escalões.',
  },
  {
    code: 'customer.read',
    moduleCode: 'customers',
    description: 'Ver clientes, segmentos e interacções comerciais.',
  },
  {
    code: 'customer.create',
    moduleCode: 'customers',
    description: 'Registar um cliente sobre uma pessoa ou organização existente.',
  },
  {
    code: 'customer.update',
    moduleCode: 'customers',
    description: 'Alterar condições comerciais, segmentos e registar interacções.',
  },
  {
    code: 'customer.block',
    moduleCode: 'customers',
    description: 'Bloquear e desbloquear clientes (com motivo).',
  },
  {
    code: 'customer.credit_manage',
    moduleCode: 'customers',
    description: 'Ver e alterar o limite de crédito e a sua moeda.',
  },
  {
    code: 'quote.read',
    moduleCode: 'orders',
    description: 'Ver propostas comerciais.',
  },
  {
    code: 'quote.manage',
    moduleCode: 'orders',
    description: 'Criar, alterar, enviar, aceitar e rejeitar propostas.',
  },
  {
    code: 'order.read',
    moduleCode: 'orders',
    description: 'Ver encomendas de venda.',
  },
  {
    code: 'order.manage',
    moduleCode: 'orders',
    description:
      'Criar e alterar encomendas de venda em rascunho (aceitar uma proposta também exige esta).',
  },
  {
    code: 'sales.confirm',
    moduleCode: 'orders',
    description: 'Confirmar e cancelar encomendas de venda.',
  },
  {
    code: 'shipment.read',
    moduleCode: 'orders',
    description: 'Ver expedições.',
  },
  {
    code: 'shipment.manage',
    moduleCode: 'orders',
    description: 'Criar e alterar expedições em rascunho.',
  },
  {
    code: 'shipment.post',
    moduleCode: 'orders',
    description: 'Lançar (baixa de stock) e reverter expedições.',
  },
  {
    code: 'invoice.read',
    moduleCode: 'invoicing',
    description: 'Ver facturas.',
  },
  {
    code: 'invoice.manage',
    moduleCode: 'invoicing',
    description: 'Criar e alterar facturas em rascunho.',
  },
  {
    code: 'invoice.issue',
    moduleCode: 'invoicing',
    description: 'Emitir facturas (número, instantâneo do cliente).',
  },
  {
    code: 'credit_note.manage',
    moduleCode: 'invoicing',
    description: 'Criar e alterar notas de crédito em rascunho.',
  },
  {
    code: 'credit_note.issue',
    moduleCode: 'invoicing',
    description: 'Emitir notas de crédito.',
  },
  {
    code: 'contract.read',
    moduleCode: 'invoicing',
    description: 'Ver contratos.',
  },
  {
    code: 'contract.manage',
    moduleCode: 'invoicing',
    description: 'Criar, alterar, activar e terminar contratos.',
  },
  {
    code: 'supplier.read',
    moduleCode: 'procurement',
    description: 'Ver fornecedores.',
  },
  {
    code: 'supplier.manage',
    moduleCode: 'procurement',
    description: 'Criar e alterar fornecedores (condições de compra).',
  },
  {
    code: 'requisition.read',
    moduleCode: 'procurement',
    description: 'Ver requisições de compra.',
  },
  {
    code: 'requisition.manage',
    moduleCode: 'procurement',
    description: 'Criar, alterar e submeter requisições de compra.',
  },
  {
    code: 'requisition.approve',
    moduleCode: 'procurement',
    description: 'Aprovar e rejeitar requisições de compra (nunca as próprias).',
  },
  {
    code: 'purchase.read',
    moduleCode: 'procurement',
    description: 'Ver encomendas a fornecedor.',
  },
  {
    code: 'purchase.manage',
    moduleCode: 'procurement',
    description: 'Criar e alterar encomendas a fornecedor em rascunho e converter requisições.',
  },
  {
    code: 'purchase.confirm',
    moduleCode: 'procurement',
    description: 'Confirmar e cancelar encomendas a fornecedor.',
  },
  {
    code: 'receipt.read',
    moduleCode: 'procurement',
    description: 'Ver recepções de mercadoria.',
  },
  {
    code: 'receipt.manage',
    moduleCode: 'procurement',
    description: 'Criar e alterar recepções em rascunho.',
  },
  {
    code: 'receipt.post',
    moduleCode: 'procurement',
    description: 'Lançar (entrada de stock) e reverter recepções.',
  },
  {
    code: 'treasury.read',
    moduleCode: 'finance',
    description: 'Ver contas de tesouraria, saldos e extractos.',
  },
  {
    code: 'treasury.manage',
    moduleCode: 'finance',
    description: 'Criar e alterar contas de tesouraria (incluindo o identificador da conta).',
  },
  {
    code: 'reconciliation.read',
    moduleCode: 'finance',
    description: 'Ver extractos importados, correspondências e o estado da conciliação.',
  },
  {
    code: 'reconciliation.manage',
    moduleCode: 'finance',
    description: 'Importar extractos bancários e descartar lotes sem correspondências.',
  },
  {
    code: 'reconciliation.confirm',
    moduleCode: 'finance',
    description: 'Confirmar e desfazer correspondências entre o extracto e os movimentos.',
  },
  {
    code: 'crm.read',
    moduleCode: 'prospecting',
    description: 'Ver leads, pipeline, oportunidades, actividades e campanhas.',
  },
  {
    code: 'crm.manage',
    moduleCode: 'prospecting',
    description:
      'Criar e alterar leads, converter leads, gerir etapas, mover oportunidades e gerir campanhas e a lista de exclusão.',
  },
  {
    code: 'campaign.send',
    moduleCode: 'prospecting',
    description: 'Enviar uma campanha (pedir o contacto aos destinatários que o permitem).',
  },
  {
    code: 'notification.read',
    moduleCode: 'notifications',
    description: 'Ver o próprio centro de notificações e gerir as suas preferências.',
  },
  {
    code: 'communication.manage',
    moduleCode: 'notifications',
    description:
      'Consultar as entregas e as falhas de comunicação (dados minimizados), repeti-las e enviar avisos aos membros.',
  },
  {
    code: 'document.read',
    moduleCode: 'documents',
    description: 'Ver a biblioteca de documentos a que tem acesso e descarregar os ficheiros.',
  },
  {
    code: 'document.manage',
    moduleCode: 'documents',
    description:
      'Carregar ficheiros, criar documentos e versões, ligá-los a recursos, apagar e fixar retenção.',
  },
  { code: 'template.read', moduleCode: 'documents', description: 'Ver modelos e as suas versões.' },
  {
    code: 'template.manage',
    moduleCode: 'documents',
    description: 'Criar modelos e rascunhos, pré-visualizar e gerar documentos a partir deles.',
  },
  {
    code: 'template.publish',
    moduleCode: 'documents',
    description: 'Publicar uma versão de um modelo (passa a imutável).',
  },
  {
    code: 'receivable.read',
    moduleCode: 'finance',
    description: 'Ver contas a receber e a exposição de crédito dos clientes.',
  },
  {
    code: 'payable.read',
    moduleCode: 'finance',
    description: 'Ver contas a pagar.',
  },
  {
    code: 'payment.read',
    moduleCode: 'finance',
    description: 'Ver pagamentos e recebimentos.',
  },
  {
    code: 'payment.manage',
    moduleCode: 'finance',
    description: 'Registar, submeter e apagar pagamentos em rascunho.',
  },
  {
    code: 'payment.confirm',
    moduleCode: 'finance',
    description: 'Confirmar, marcar como falhados e reverter pagamentos (movimenta dinheiro).',
  },
  {
    code: 'supplier_invoice.read',
    moduleCode: 'finance',
    description: 'Ver facturas de fornecedor.',
  },
  {
    code: 'supplier_invoice.manage',
    moduleCode: 'finance',
    description: 'Criar e alterar facturas de fornecedor em rascunho.',
  },
  {
    code: 'supplier_invoice.validate',
    moduleCode: 'finance',
    description: 'Validar e anular facturas de fornecedor (cria a conta a pagar).',
  },
  {
    code: 'supplier_invoice.override',
    moduleCode: 'finance',
    description: 'Validar uma factura com divergências na conferência, com justificação.',
  },
  {
    code: 'transfer.read',
    moduleCode: 'inventory',
    description: 'Ver transferências de stock entre armazéns.',
  },
  {
    code: 'transfer.manage',
    moduleCode: 'inventory',
    description: 'Criar e alterar transferências em rascunho e cancelá-las.',
  },
  {
    code: 'transfer.dispatch',
    moduleCode: 'inventory',
    description: 'Expedir transferências (tira da origem e põe em trânsito).',
  },
  {
    code: 'transfer.receive',
    moduleCode: 'inventory',
    description: 'Receber o stock em trânsito no armazém de destino.',
  },
  {
    code: 'count.read',
    moduleCode: 'inventory',
    description: 'Ver contagens físicas de inventário.',
  },
  {
    code: 'count.manage',
    moduleCode: 'inventory',
    description: 'Criar, abrir, contar e rever contagens físicas e cancelá-las.',
  },
  {
    code: 'count.post',
    moduleCode: 'inventory',
    description: 'Lançar os ajustes de uma contagem (as diferenças aprovadas).',
  },
  {
    code: 'return.read',
    moduleCode: 'inventory',
    description: 'Ver devoluções de clientes e a fornecedores.',
  },
  {
    code: 'return.manage',
    moduleCode: 'inventory',
    description: 'Criar e alterar devoluções em rascunho.',
  },
  {
    code: 'return.post',
    moduleCode: 'inventory',
    description: 'Aprovar e lançar devoluções (movem stock).',
  },
  {
    code: 'inventory.read',
    moduleCode: 'inventory',
    description: 'Ver stock, movimentos, lotes e reservas.',
  },
  {
    code: 'inventory.adjust',
    moduleCode: 'inventory',
    description: 'Ajustar stock, reverter movimentos e criar lotes.',
  },
  {
    code: 'inventory.reserve',
    moduleCode: 'inventory',
    description: 'Criar e libertar reservas de stock.',
  },
  {
    code: 'warehouse.manage',
    moduleCode: 'inventory',
    description: 'Criar e alterar armazéns e locais.',
  },
  {
    code: 'audit.read',
    moduleCode: 'audit',
    description: 'Ver o histórico de auditoria e os eventos de segurança.',
  },
]

const CODE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

export const isValidPermissionCode = (code: string): boolean => CODE.test(code)

export function splitPermission(code: string): { resource: string; action: string } {
  const [resource, action] = code.split('.')
  return { resource, action }
}

/** Código do papel de sistema que concentra todas as permissões do catálogo (por tenant). */
export const TENANT_ADMIN_ROLE = 'tenant_admin'
