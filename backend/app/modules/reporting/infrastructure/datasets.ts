import type { DatasetDefinition } from '#modules/reporting/domain/reporting'

/**
 * Datasets de relatórios. O SQL é fixo, escrito aqui: o tenant só escolhe campos, filtros, agrupamentos e medidas.
 * Lêem as tabelas dos módulos donos como **read models** (só leitura, sempre filtrados por `tenant_id`); a RLS aplica-se
 * por cima. Quem não tem a permissão do dataset não o vê nem o corre.
 */
export const SALES_DOCUMENTS: DatasetDefinition = {
  code: 'sales_documents',
  name: 'Vendas facturadas',
  description: 'Facturas emitidas e notas de crédito emitidas, por data de emissão.',
  permission: 'invoice.read',
  from: `(
    select i.id, 'INVOICE' as kind, i.number, i.issued_on, i.currency,
           i.net_total as net, i.tax_total as tax, i.total as amount,
           (select cu.code from customers cu where cu.tenant_id = i.tenant_id and cu.id = i.customer_id) as customer_code
      from invoices i
     where i.tenant_id = :tenant and i.status in ('ISSUED', 'CREDITED')
    union all
    select c.id, 'CREDIT_NOTE', c.number, c.issued_on, i.currency,
           -c.net_total, -c.tax_total, -c.total,
           (select cu.code from customers cu where cu.tenant_id = i.tenant_id and cu.id = i.customer_id)
      from credit_notes c
      join invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
     where c.tenant_id = :tenant and c.status = 'ISSUED'
  ) d`,
  fields: [
    {
      code: 'kind',
      label: 'Tipo',
      type: 'enum',
      expression: 'd.kind',
      enumValues: ['INVOICE', 'CREDIT_NOTE'],
    },
    { code: 'number', label: 'Número', type: 'string', expression: 'd.number' },
    { code: 'issued_on', label: 'Data de emissão', type: 'date', expression: 'd.issued_on' },
    { code: 'customer_code', label: 'Cliente', type: 'string', expression: 'd.customer_code' },
    { code: 'currency', label: 'Moeda', type: 'string', expression: 'd.currency' },
    { code: 'net', label: 'Valor líquido', type: 'decimal', expression: 'd.net' },
    { code: 'tax', label: 'Imposto', type: 'decimal', expression: 'd.tax' },
    { code: 'amount', label: 'Total', type: 'decimal', expression: 'd.amount' },
  ],
  defaultSort: 'd.issued_on desc, d.number, d.id',
  documentation: [
    'Vendas facturadas = facturas emitidas − notas de crédito emitidas, no período da data de emissão (as notas de crédito entram com sinal negativo).',
    'Cada moeda soma-se à parte: agrupe por moeda, nunca some moedas diferentes.',
    'Rascunhos não contam; uma factura creditada continua contada pelo valor emitido e o crédito aparece como nota.',
    'Os valores têm 4 casas decimais e viajam como texto.',
  ],
}

export const SALES_ORDERS: DatasetDefinition = {
  code: 'sales_orders',
  name: 'Encomendas de venda',
  description: 'Encomendas de clientes por data de encomenda e estado.',
  permission: 'order.read',
  from: `(
    select o.id, o.number, o.order_date, o.status, o.currency, o.net_total, o.tax_total, o.total,
           o.credit_reservation,
           (select cu.code from customers cu where cu.tenant_id = o.tenant_id and cu.id = o.customer_id) as customer_code
      from sales_orders o
     where o.tenant_id = :tenant
  ) d`,
  fields: [
    { code: 'number', label: 'Número', type: 'string', expression: 'd.number' },
    { code: 'order_date', label: 'Data da encomenda', type: 'date', expression: 'd.order_date' },
    {
      code: 'status',
      label: 'Estado',
      type: 'enum',
      expression: 'd.status',
      enumValues: ['DRAFT', 'CONFIRMED', 'PARTIAL', 'FULFILLED', 'CANCELLED'],
    },
    { code: 'customer_code', label: 'Cliente', type: 'string', expression: 'd.customer_code' },
    { code: 'currency', label: 'Moeda', type: 'string', expression: 'd.currency' },
    { code: 'net_total', label: 'Valor líquido', type: 'decimal', expression: 'd.net_total' },
    { code: 'tax_total', label: 'Imposto', type: 'decimal', expression: 'd.tax_total' },
    { code: 'total', label: 'Total', type: 'decimal', expression: 'd.total' },
    {
      code: 'credit_reservation',
      label: 'Crédito reservado',
      type: 'decimal',
      expression: 'd.credit_reservation',
      permission: 'customer.credit_manage',
    },
  ],
  defaultSort: 'd.order_date desc, d.number, d.id',
  documentation: [
    'Encomendas contadas por data da encomenda; o estado CANCELLED e DRAFT contam como linhas, mas não como venda confirmada.',
    'Encomenda confirmada ≠ factura emitida ≠ recebimento: este dataset não mede facturação nem dinheiro recebido.',
    'O crédito reservado só o vê quem pode gerir o crédito dos clientes.',
  ],
}

export const PAYMENTS_RECEIVED: DatasetDefinition = {
  code: 'payments_received',
  name: 'Recebimentos',
  description: 'Pagamentos de entrada confirmados, por data do pagamento.',
  permission: 'payment.read',
  from: `(
    select p.id, p.occurred_on, p.method, p.currency, p.amount, p.reference,
           (select pa.display_name from parties pa where pa.tenant_id = p.tenant_id and pa.id = p.party_id) as party_name
      from payments p
     where p.tenant_id = :tenant and p.direction = 'INBOUND' and p.status = 'CONFIRMED'
  ) d`,
  fields: [
    { code: 'occurred_on', label: 'Data do pagamento', type: 'date', expression: 'd.occurred_on' },
    { code: 'party_name', label: 'Pagador', type: 'string', expression: 'd.party_name' },
    {
      code: 'method',
      label: 'Método',
      type: 'enum',
      expression: 'd.method',
      enumValues: ['CASH', 'TRANSFER', 'CARD', 'OTHER'],
    },
    { code: 'currency', label: 'Moeda', type: 'string', expression: 'd.currency' },
    { code: 'amount', label: 'Valor', type: 'decimal', expression: 'd.amount' },
    { code: 'reference', label: 'Referência', type: 'string', expression: 'd.reference' },
  ],
  defaultSort: 'd.occurred_on desc, d.id',
  documentation: [
    'Recebimentos = pagamentos de entrada (INBOUND) confirmados, por data do pagamento; não são vendas.',
    'Pagamentos revertidos, falhados ou por confirmar não contam.',
    'Cada moeda soma-se à parte.',
  ],
}

export const DATASETS = [SALES_DOCUMENTS, SALES_ORDERS, PAYMENTS_RECEIVED] as const
