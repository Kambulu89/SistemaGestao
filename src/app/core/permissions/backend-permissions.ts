import type { Permission } from './permission.model';

/**
 * D-014: o backend usa `<recurso>.<acção>` (ex.: `member.invite`, `iam.manage`); o frontend usa
 * `<módulo>.<recurso>.<acção>`. Este é o **único** ponto de tradução. Cada código do servidor
 * mantém-se tal e qual e ganha os aliases que as páginas do frontend esperam.
 *
 * É só conveniência de navegação: o servidor volta a verificar cada operação.
 */
const ALIASES: Readonly<Record<string, readonly Permission[]>> = {
  'organization.read': ['organization.units.read'],
  'organization.manage': ['organization.units.read', 'organization.units.manage'],
  'member.read': ['iam.users.read'],
  'member.invite': ['iam.users.read', 'iam.users.manage'],
  'member.manage': ['iam.users.read', 'iam.users.manage'],
  'iam.read': ['iam.access-control.read'],
  'iam.manage': ['iam.access-control.read', 'iam.access-control.manage'],
  'settings.read': ['tenant.settings.read'],
  'settings.manage': ['tenant.settings.read', 'tenant.settings.manage'],
  'sequence.manage': ['tenant.sequences.manage'],
  'subscription.read': ['tenant.plan.read'],
  'module.read': ['tenant.modules.read'],
  'module.manage': ['tenant.modules.read', 'tenant.modules.manage'],
  // Entidades dinâmicas (C10): as páginas do Core Dinâmico usam `configuration.forms.*`. Os registos usam
  // directamente `dynamic.*` (ver `SERVER_ENTITY_OPERATIONS`).
  'entity.read': ['configuration.forms.read'],
  'entity.design': ['configuration.forms.read', 'configuration.forms.manage'],
  'entity.publish': ['configuration.forms.read', 'configuration.forms.publish'],
  // Formulários (C11).
  'form.read': ['configuration.form-layouts.read'],
  'form.design': ['configuration.form-layouts.read', 'configuration.form-layouts.manage'],
  'form.publish': ['configuration.form-layouts.read', 'configuration.form-layouts.publish'],
  // Máquinas de estados (C13): desenhar e publicar; executar transições vem de `dynamic.transition` (registos).
  'state.read': ['configuration.state-machines.read'],
  'state.design': ['configuration.state-machines.read', 'configuration.state-machines.manage'],
  'state.publish': ['configuration.state-machines.read', 'configuration.state-machines.publish'],
  // Workflows de aprovação (C14): desenhar e publicar; submeter (`workflow.submit`), decidir (`approval.decide`) e delegar
  // (`approval.delegate`) usam o código do servidor tal e qual.
  'workflow.read': ['configuration.workflows.read'],
  'workflow.design': ['configuration.workflows.read', 'configuration.workflows.manage'],
  'workflow.publish': ['configuration.workflows.read', 'configuration.workflows.publish'],
  // Clientes (M01): a página usa os códigos do servidor (`customer.*`); o alias só abre a rota do módulo.
  'customer.read': ['crm.customers.read'],
  'customer.create': ['crm.customers.read'],
  'customer.update': ['crm.customers.read'],
  // Propostas e encomendas (M04): as páginas usam os códigos do servidor; o alias só abre a rota do módulo.
  'quote.read': ['sales.orders.read'],
  'order.read': ['sales.orders.read'],
  'shipment.read': ['sales.orders.read'],
  // Facturação (M05): as páginas usam os códigos do servidor; o alias só abre a rota do módulo (facturas ou contratos).
  'invoice.read': ['sales.billing.read'],
  'contract.read': ['sales.billing.read'],
  // Compras (M06): as páginas usam os códigos do servidor; o alias só abre a rota do módulo.
  'supplier.read': ['procurement.read'],
  'requisition.read': ['procurement.read'],
  'purchase.read': ['procurement.read'],
  'receipt.read': ['procurement.read'],
  // Tesouraria (M09): as páginas usam os códigos do servidor; o alias só abre a rota do módulo.
  // As capacidades «Contas a receber/pagar» e «Pagamentos e orçamento» do catálogo levam a essa mesma página.
  'treasury.read': ['finance.read'],
  'receivable.read': ['finance.read', 'finance.receivables-payables.read'],
  'payable.read': ['finance.read', 'finance.receivables-payables.read'],
  'payment.read': ['finance.read', 'finance.payments-budget.read'],
  'supplier_invoice.read': ['finance.read'],
  'reconciliation.read': ['finance.read'],
  // Catálogo e preços (M03): as páginas usam o código do servidor; ler preços é independente de ler produtos.
  // Regras de validação (C12).
  'rule.read': ['configuration.rules.read'],
  'rule.manage': ['configuration.rules.read', 'configuration.rules.manage'],
};

/** Códigos do servidor → chaves do frontend (com os códigos originais incluídos). */
export function mapBackendPermissions(codes: readonly string[]): readonly Permission[] {
  const result = new Set<Permission>();
  for (const code of codes) {
    result.add(code);
    for (const alias of ALIASES[code] ?? []) result.add(alias);
  }
  return [...result].sort();
}

/**
 * Concessões de plataforma do servidor (`platform.tenant.manage`, `platform.billing.manage`) → chaves do
 * frontend. Qualquer concessão dá acesso à área de plataforma e ao catálogo de módulos do código (que não
 * vem da API).
 */
export function mapPlatformPermissions(codes: readonly string[]): readonly Permission[] {
  if (codes.length === 0) return [];
  const result = new Set<Permission>(['platform.access', 'platform.modules.read', ...codes]);
  if (codes.includes('platform.tenant.manage')) result.add('platform.tenants.read');
  if (codes.includes('platform.billing.manage')) {
    result.add('platform.plans.read');
    result.add('platform.subscriptions.read');
  }
  return [...result].sort();
}
