import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { legalEntityFacts } from '#modules/organization/index'
import { rateOn } from '#modules/settings/index'
import { customerSnapshot } from '#modules/sales/application/customer_service'
import { resolvePrices, searchSalesRefs } from '#modules/sales/application/pricing_service'
import { customerActive, customerRow } from '#modules/sales/application/quote_service'
import { invoiceableOrder, recordInvoiced } from '#modules/sales/application/order_service'
import { allocateFiscalNumber, resolveTaxes } from '#modules/sales/application/fiscal_service'
import { enqueueFiscalDocument } from '#modules/sales/application/fiscal_integration_service'
import {
  dbScaled,
  PCT_SCALE,
  PRICE_SCALE,
  QTY_SCALE,
  scaledText,
} from '#modules/sales/domain/pricing'
import {
  addDays,
  collectionView,
  documentHash,
  effectiveDiscount,
  INVOICE_STATUSES,
  type InvoiceLineInput,
  lineNet,
  normalizeInvoiceHeader,
  normalizeInvoiceLines,
} from '#modules/sales/domain/invoices'
import { collectionOf } from '#modules/sales/domain/notes'

/*
 * Facturas de venda (10.6), emissão DEMONSTRATIVA. Permissões no âmbito da entidade legal: `sales.invoices.read`,
 * `.manage` (rascunhos, descartar) e `.issue` (emitir). Preços: os acordados na encomenda de origem, ou o motor do 10.2
 * à data da factura (serviços sem encomenda); impostos: o motor fiscal do 10.5 (só valores confirmados em vigor);
 * número: a série fiscal em simulação. A encomenda regista o facturado na mesma transacção da emissão.
 */

const today = () => new Date().toISOString().slice(0, 10)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const money = (v: unknown) => scaledText(dbScaled(v, 2), 2)
const cents = (v: unknown) => dbScaled(v, 2)
/** Em dívida: a pagar + débitos − créditos − pago (10.8). */
const openOf = (i: any) =>
  cents(i.payable_total) + cents(i.debited_total) - cents(i.credited_total) - cents(i.paid_total)
const num = (v: unknown, scale: number) =>
  v === null || v === undefined ? null : scaledText(dbScaled(v, scale), scale)

type Need = 'read' | 'manage' | 'issue'
async function scopesOf(scope: TenantScope): Promise<Record<Need, PermissionScope>> {
  return {
    read: await permissionScope(scope, 'sales.invoices.read'),
    manage: await permissionScope(scope, 'sales.invoices.manage'),
    issue: await permissionScope(scope, 'sales.invoices.issue'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
function rights(s: Record<Need, PermissionScope>, le: string) {
  const manage = covers(s.manage, le)
  const issue = covers(s.issue, le)
  return { read: manage || issue || covers(s.read, le), manage, issue }
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select *, invoice_date::text as idate, due_date::text as ddate from sales_invoices where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}
async function authorized(scope: TenantScope, id: string, need: Need, lock = false) {
  const i = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), i.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (!g[need])
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      need === 'issue' ? 'Não emite facturas desta entidade.' : 'Não gere facturas desta entidade.'
    )
  return { i, g }
}
const versionCheck = (r: any, expected: unknown) => {
  if (Number(r.version) !== Number(expected)) throw ApiError.versionConflict(Number(r.version))
}
async function event(
  scope: TenantScope,
  id: string,
  kind: string,
  reason: string | null = null,
  details?: Record<string, unknown>
) {
  await scope.trx.rawQuery(
    `insert into sales_invoice_events (tenant_id, invoice_id, kind, reason, details, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      id,
      kind,
      reason,
      details ? JSON.stringify(details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}
async function setInvoice(scope: TenantScope, id: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields)
  await scope.trx.rawQuery(
    `update sales_invoices set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
      where tenant_id = ? and id = ?`,
    [...cols.map((c) => fields[c]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/** Produtos das linhas: tipo e unidade base. */
async function products(scope: TenantScope, ids: string[]) {
  if (!ids.length) return new Map<string, any>()
  const rows = (
    await scope.trx.rawQuery(
      `select p.id, p.product_type, p.name, u.code as uom from products p join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
        where p.tenant_id = ? and p.id in (${ids.map(() => '?').join(', ')})`,
      [scope.context.tenantId, ...ids]
    )
  ).rows as any[]
  return new Map(rows.map((r) => [r.id as string, r]))
}

interface Priced {
  input: InvoiceLineInput
  productId: string
  variantId: string | null
  description: string
  uom: string
  priceSource: string
  basePrice: string | null
  netUnitPrice: string | null
  netAmount: string
  pricing: Record<string, unknown>
  requiresApproval: boolean
}

/**
 * Preços das linhas: com encomenda, o preço acordado e no máximo o entregue por facturar; sem encomenda, só serviços,
 * pelo motor de preços à data da factura.
 */
async function priceLines(
  scope: TenantScope,
  inv: any,
  lines: InvoiceLineInput[]
): Promise<Priced[]> {
  const issues: ErrorDetail[] = []
  if (inv.order_id) {
    const { lines: ol } = await invoiceableOrder(scope, inv.order_id)
    const prods = await products(
      scope,
      ol.map((l) => l.productId)
    )
    const used = new Map<string, bigint>()
    const out = lines.map((l, i) => {
      const o = ol.find((x) => x.id === l.orderLineId)
      if (!o) {
        issues.push({
          path: `lines.${i}.orderLineId`,
          code: 'NOT_FOUND',
          message: 'Linha inexistente na encomenda.',
        })
        return null
      }
      const total = (used.get(o.id) ?? 0n) + dbScaled(l.quantity, QTY_SCALE)
      used.set(o.id, total)
      if (total > dbScaled(o.invoiceable, QTY_SCALE))
        issues.push({
          path: `lines.${i}.quantity`,
          code: 'OVER_INVOICED',
          message: `Só há ${o.invoiceable.replace(/\.?0+$/, '')} entregue por facturar.`,
        })
      return {
        input: { ...l, productId: o.productId, variantId: o.variantId },
        productId: o.productId,
        variantId: o.variantId,
        description: l.description ?? o.description,
        uom: prods.get(o.productId)?.uom ?? 'UN',
        priceSource: 'ORDER',
        basePrice: o.basePrice,
        netUnitPrice: o.netUnitPrice,
        netAmount: lineNet(l.quantity, o.netUnitPrice),
        pricing: { ...o.pricing, orderLineNo: o.lineNo },
        requiresApproval: false,
      }
    })
    fail(issues)
    return out as Priced[]
  }
  const prods = await products(
    scope,
    lines.map((l) => l.productId)
  )
  lines.forEach((l, i) => {
    const p = prods.get(l.productId)
    if (!p)
      issues.push({
        path: `lines.${i}.productId`,
        code: 'NOT_FOUND',
        message: 'Produto inexistente.',
      })
    else if (p.product_type !== 'SERVICE')
      issues.push({
        path: `lines.${i}.productId`,
        code: 'STOCK_NEEDS_ORDER',
        message: 'Produtos de stock facturam-se a partir da encomenda expedida.',
      })
  })
  fail(issues)
  if (!lines.length) return []
  const snap = await resolvePrices(scope, {
    customerId: inv.customer_id,
    currency: String(inv.currency).trim(),
    date: inv.idate,
    legalEntityId: inv.legal_entity_id,
    lines: lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      quantity: l.quantity,
      manualDiscountPct: l.manualDiscountPct,
      manualUnitPrice: l.manualUnitPrice,
    })),
  })
  // Factura de contrato recorrente (10.11): preço fixado na versão aprovada do contrato (origem CONTRACT).
  const contract = new Map<string, string>()
  if (inv.recurring_version_id)
    for (const x of (
      await scope.trx.rawQuery(
        `select product_id, unit_price from sales_recurring_version_lines where tenant_id = ? and version_id = ? and unit_price is not null`,
        [scope.context.tenantId, inv.recurring_version_id]
      )
    ).rows as any[])
      contract.set(x.product_id, scaledText(dbScaled(x.unit_price, PRICE_SCALE), PRICE_SCALE))
  return lines.map((l, i) => {
    const r = snap.lines[i]
    const fixed = contract.get(l.productId)
    if (fixed !== undefined && l.manualUnitPrice === null && l.manualDiscountPct === null)
      return {
        input: l,
        productId: l.productId,
        variantId: l.variantId,
        description: l.description ?? r.name,
        uom: prods.get(l.productId)?.uom ?? 'UN',
        priceSource: 'CONTRACT',
        basePrice: fixed,
        netUnitPrice: fixed,
        netAmount: lineNet(l.quantity, fixed),
        pricing: { source: 'CONTRACT', versionId: inv.recurring_version_id, unitPrice: fixed },
        requiresApproval: false,
      }
    return {
      input: l,
      productId: l.productId,
      variantId: l.variantId,
      description: l.description ?? r.name,
      uom: prods.get(l.productId)?.uom ?? 'UN',
      priceSource: r.source,
      basePrice: r.basePrice,
      netUnitPrice: r.netUnitPrice,
      netAmount: r.netUnitPrice === null ? '0.00' : lineNet(l.quantity, r.netUnitPrice),
      pricing: r as unknown as Record<string, unknown>,
      requiresApproval: r.requiresApproval,
    }
  })
}

/** Grava as linhas (substitui) com preços e impostos à data da factura; devolve os avisos para a emissão. */
async function writeLines(scope: TenantScope, inv: any, lines: InvoiceLineInput[]) {
  const t = scope.context.tenantId
  const priced = await priceLines(scope, inv, lines)
  const taxes = priced.length
    ? await resolveTaxes(scope, {
        legalEntityId: inv.legal_entity_id,
        date: inv.idate,
        lines: priced.map((p, i) => ({
          key: String(i),
          netAmount: p.netAmount,
          taxCodeIds: p.input.taxCodeIds,
          exemptionCode: p.input.exemptionCode,
        })),
      })
    : null
  await scope.trx.rawQuery(
    `delete from sales_invoice_lines where tenant_id = ? and invoice_id = ?`,
    [t, inv.id]
  )
  for (const [i, p] of priced.entries()) {
    const lt = taxes!.lines[i].taxes
    const taxAmount = lt
      .filter((x) => x.kind === 'TAX')
      .reduce((a, x) => a + dbScaled(x.amount, 6), 0n)
    await scope.trx.rawQuery(
      `insert into sales_invoice_lines (tenant_id, invoice_id, line_no, product_id, variant_id, description, quantity, uom_code,
         manual_discount_pct, manual_unit_price, price_source, base_price, net_unit_price, discount_pct, net_amount, tax_code_ids,
         exemption_code, tax_amount, taxes, pricing, order_line_id, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::uuid[], ?, ?, ?, ?, ?, ?, ?)`,
      [
        t,
        inv.id,
        i + 1,
        p.productId,
        p.variantId,
        p.description,
        p.input.quantity,
        p.uom,
        p.input.manualDiscountPct,
        p.input.manualUnitPrice,
        p.priceSource,
        p.basePrice,
        p.netUnitPrice,
        p.netUnitPrice === null ? '0' : effectiveDiscount(p.basePrice, p.netUnitPrice),
        p.netAmount,
        `{${p.input.taxCodeIds.join(',')}}`,
        lt.find((x) => x.exemptionCode)?.exemptionCode ?? null,
        scaledText(taxAmount, 6),
        JSON.stringify(lt),
        JSON.stringify(p.pricing),
        p.input.orderLineId,
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
  }
  const totals = taxes?.totals ?? {
    net: '0.00',
    tax: '0.00',
    gross: '0.00',
    withholding: '0.00',
    payable: '0.00',
  }
  await setInvoice(scope, inv.id, {
    net_total: totals.net,
    tax_total: totals.tax,
    gross_total: totals.gross,
    withholding_total: totals.withholding,
    payable_total: totals.payable,
    tax_summary: taxes
      ? JSON.stringify({ summary: taxes.summary, ratesUsed: taxes.ratesUsed })
      : null,
    rounding_level: taxes?.rounding ?? null,
  })
  return {
    priced,
    taxes,
    pricingApproval: priced.some((p) => p.requiresApproval),
    missing: priced.some((p) => p.netUnitPrice === null),
  }
}

async function storedLines(scope: TenantScope, id: string): Promise<InvoiceLineInput[]> {
  const rows = (
    await scope.trx.rawQuery(
      `select * from sales_invoice_lines where tenant_id = ? and invoice_id = ? order by line_no`,
      [scope.context.tenantId, id]
    )
  ).rows as any[]
  return rows.map((l) => ({
    productId: l.product_id,
    variantId: l.variant_id ?? null,
    description: l.description,
    quantity: num(l.quantity, QTY_SCALE)!,
    manualDiscountPct: num(l.manual_discount_pct, PCT_SCALE),
    manualUnitPrice: num(l.manual_unit_price, PRICE_SCALE),
    taxCodeIds: l.tax_code_ids as string[],
    exemptionCode: l.exemption_code ?? null,
    orderLineId: l.order_line_id ?? null,
  }))
}

async function detail(scope: TenantScope, id: string, g?: ReturnType<typeof rights>) {
  const t = scope.context.tenantId
  const i = (
    await scope.trx.rawQuery(
      `select i.*, i.invoice_date::text as idate, i.due_date::text as ddate, le.code as le_code, le.legal_name as le_name,
              le.tax_id as le_tax_id, b.code as br_code, b.name as br_name, bp.code as cus_code, bp.name as cus_name,
              c.status as cus_status, o.number as o_number, s.code as s_code, s.mode as s_mode, s.fiscal_code as s_fcode,
              u.full_name as issuer
         from sales_invoices i
         join legal_entities le on le.tenant_id = i.tenant_id and le.id = i.legal_entity_id
         join customers c on c.tenant_id = i.tenant_id and c.id = i.customer_id
         join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
         left join branches b on b.tenant_id = i.tenant_id and b.id = i.branch_id
         left join sales_orders o on o.tenant_id = i.tenant_id and o.id = i.order_id
         left join fiscal_series s on s.tenant_id = i.tenant_id and s.id = i.series_id
         left join users u on u.id = i.issued_by
        where i.tenant_id = ? and i.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!i) throw ApiError.notFound()
  const lines = (
    await scope.trx.rawQuery(
      `select l.*, p.sku, v.sku as variant_sku from sales_invoice_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         left join product_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
        where l.tenant_id = ? and l.invoice_id = ? order by l.line_no`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from sales_invoice_events e left join users u on u.id = e.created_by where e.tenant_id = ? and e.invoice_id = ? order by e.created_at, e.id`,
      [t, id]
    )
  ).rows as any[]
  const payments = (
    await scope.trx.rawQuery(
      `select r.id, r.number, r.received_date::text as d, a.amount, 'RECEIPT' as kind from sales_receipt_allocations a
         join sales_receipts r on r.tenant_id = a.tenant_id and r.id = a.receipt_id
        where a.tenant_id = ? and a.invoice_id = ? and r.status = 'CONFIRMED'
       union all
       select r.id, r.number, x.created_at::date::text as d, x.amount, 'ADVANCE' as kind from sales_advance_applications x
         join sales_receipts r on r.tenant_id = x.tenant_id and r.id = x.receipt_id
        where x.tenant_id = ? and x.invoice_id = ?
       union all
       select r.id, r.number, r.received_date::text as d, r.amount, 'INVOICE_RECEIPT' as kind from sales_receipts r
        where r.tenant_id = ? and r.invoice_id = ? and r.purpose = 'INVOICE_RECEIPT' and r.status = 'CONFIRMED'
       union all
       select n.id, n.number, x.created_at::date::text as d, x.amount, 'CREDIT_NOTE' as kind from sales_note_applications x
         join sales_notes n on n.tenant_id = x.tenant_id and n.id = x.note_id
        where x.tenant_id = ? and x.invoice_id = ?
       order by d`,
      [t, id, t, id, t, id, t, id]
    )
  ).rows as any[]
  const recurring = (
    await scope.trx.rawQuery(
      `select c.id, c.reference, r.period_start::text as ps, r.period_end::text as pe from sales_recurring_runs r
         join sales_recurring_contracts c on c.tenant_id = r.tenant_id and c.id = r.contract_id
        where r.tenant_id = ? and r.invoice_id = ? limit 1`,
      [t, id]
    )
  ).rows[0] as any
  const notes = (
    await scope.trx.rawQuery(
      `select id, kind, number, status, note_date::text as d, payable_total, reason_code from sales_notes
        where tenant_id = ? and invoice_id = ? and status <> 'DISCARDED' order by created_at`,
      [t, id]
    )
  ).rows as any[]
  const a = g ?? rights(await scopesOf(scope), i.legal_entity_id)
  const draft = i.status === 'DRAFT'
  return {
    id: i.id as string,
    version: Number(i.version),
    number: (i.number as string) ?? null,
    status: i.status as string,
    fiscalStatus: (i.fiscal_status as string) ?? null,
    collectionStatus: collectionView(i.status, i.collection_status, i.ddate, today()),
    documentKind: i.document_kind as 'INVOICE' | 'INVOICE_RECEIPT',
    simulation: i.series_id ? i.s_mode === 'SIMULATION' : true,
    legalEntity: {
      id: i.legal_entity_id as string,
      code: i.le_code as string,
      name: i.le_name as string,
      taxId: (i.le_tax_id as string) ?? null,
    },
    branch: i.branch_id
      ? { id: i.branch_id as string, code: i.br_code as string, name: i.br_name as string }
      : null,
    customer: {
      id: i.customer_id as string,
      code: i.cus_code as string,
      name: i.cus_name as string,
      status: i.cus_status as string,
    },
    customerSnapshot: (i.customer_snapshot as Record<string, unknown>) ?? null,
    order: i.order_id ? { id: i.order_id as string, number: i.o_number as string } : null,
    series: i.series_id
      ? { id: i.series_id as string, code: i.s_code as string, fiscalCode: i.s_fcode as string }
      : null,
    invoiceDate: i.idate as string,
    dueDate: (i.ddate as string) ?? null,
    currency: String(i.currency).trim(),
    functionalCurrency: i.functional_currency ? String(i.functional_currency).trim() : null,
    exchangeRate: num(i.exchange_rate, 10),
    paymentTermsDays: Number(i.payment_terms_days),
    customerReference: (i.customer_reference as string) ?? null,
    notes: (i.notes as string) ?? null,
    roundingLevel: (i.rounding_level as string) ?? null,
    netTotal: money(i.net_total),
    taxTotal: money(i.tax_total),
    grossTotal: money(i.gross_total),
    withholdingTotal: money(i.withholding_total),
    payableTotal: money(i.payable_total),
    paidTotal: money(i.paid_total),
    creditedTotal: money(i.credited_total),
    debitedTotal: money(i.debited_total),
    openTotal: i.status === 'ISSUED' || i.status === 'CORRECTED' ? scaledText(openOf(i), 2) : null,
    recurring: recurring
      ? {
          contractId: recurring.id as string,
          reference: recurring.reference as string,
          periodStart: recurring.ps as string,
          periodEnd: recurring.pe as string,
        }
      : null,
    correctionNotes: notes.map((n) => ({
      id: n.id as string,
      kind: n.kind as string,
      number: (n.number as string) ?? null,
      status: n.status as string,
      date: n.d as string,
      payable: money(n.payable_total),
      reasonCode: n.reason_code as string,
    })),
    taxSummary: (i.tax_summary as Record<string, unknown>) ?? null,
    documentHash: (i.document_hash as string) ?? null,
    issuedAt: i.issued_at ? new Date(i.issued_at).toISOString() : null,
    issuedBy: (i.issuer as string) ?? null,
    discardReason: (i.discard_reason as string) ?? null,
    payments: payments.map((p) => ({
      receiptId: p.id as string,
      number: (p.number as string) ?? null,
      date: p.d as string,
      amount: money(p.amount),
      kind: p.kind as string,
    })),
    lines: lines.map((l) => ({
      id: l.id as string,
      lineNo: Number(l.line_no),
      product: { id: l.product_id as string, sku: l.sku as string },
      variant: l.variant_id ? { id: l.variant_id as string, sku: l.variant_sku as string } : null,
      description: l.description as string,
      quantity: num(l.quantity, QTY_SCALE)!,
      uom: l.uom_code as string,
      manualDiscountPct: num(l.manual_discount_pct, PCT_SCALE),
      manualUnitPrice: num(l.manual_unit_price, PRICE_SCALE),
      priceSource: l.price_source as string,
      basePrice: num(l.base_price, PRICE_SCALE),
      netUnitPrice: num(l.net_unit_price, PRICE_SCALE),
      discountPct: num(l.discount_pct, 4)!,
      netAmount: money(l.net_amount),
      taxCodeIds: l.tax_code_ids as string[],
      exemptionCode: (l.exemption_code as string) ?? null,
      taxAmount: num(l.tax_amount, 6)!,
      taxes: (l.taxes as any[]) ?? [],
      pricing: l.pricing as Record<string, unknown>,
      orderLineId: (l.order_line_id as string) ?? null,
    })),
    history: events.map((e) => ({
      kind: e.kind as string,
      reason: (e.reason as string) ?? null,
      details: (e.details as Record<string, unknown>) ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: { edit: a.manage && draft, issue: a.issue && draft, discard: a.manage && draft },
  }
}
export type InvoiceView = Awaited<ReturnType<typeof detail>>

/** Códigos de imposto sugeridos para uma taxa (o único imposto confirmado em vigor com essa taxa, se houver). */
async function suggestTaxCodes(
  scope: TenantScope,
  legalEntityId: string,
  date: string,
  rate: string
) {
  const rows = (
    await scope.trx.rawQuery(
      `select distinct c.id from tax_codes c join tax_rates r on r.tenant_id = c.tenant_id and r.tax_code_id = c.id
         join legal_entities le on le.tenant_id = c.tenant_id and le.id = ?
        where c.tenant_id = ? and c.kind = 'TAX' and c.status = 'ACTIVE' and c.country_code = le.country_code
          and r.status = 'CONFIRMED' and r.rate = ? and r.valid_from <= ?::date and (r.valid_to is null or r.valid_to >= ?::date)
          and (r.legal_entity_id is null or r.legal_entity_id = ?)`,
      [legalEntityId, scope.context.tenantId, rate, date, date, legalEntityId]
    )
  ).rows as any[]
  return rows.length === 1 ? [rows[0].id as string] : []
}

/**
 * Emissão de um rascunho (factura ou factura-recibo) na transacção de quem chama: recalcula preços e impostos,
 * fotografa o cliente, fixa câmbio e vencimento, regista o facturado na encomenda, numera pela série fiscal do tipo e
 * fixa a impressão digital. A factura-recibo só é emitida pela confirmação do recebimento (10.7).
 */
export async function issueDraft(scope: TenantScope, i: any, seriesInput: unknown) {
  const context = scope.context
  const id = i.id as string
  const kind = i.document_kind as 'INVOICE' | 'INVOICE_RECEIPT'
  if (i.idate > today())
    fail([
      {
        path: 'invoiceDate',
        code: 'FUTURE',
        message: 'A data da factura não pode ser futura.',
      },
    ])
  const customer = await customerSnapshot(scope, i.customer_id)
  if (customer.status !== 'ACTIVE')
    throw ApiError.conflict('CUSTOMER_BLOCKED', 'O cliente não está activo.')
  const lines = await storedLines(scope, id)
  if (!lines.length) throw ApiError.conflict('NO_LINES', 'A factura não tem linhas.')
  const w = await writeLines(scope, i, lines)
  if (w.missing) throw ApiError.conflict('NO_PRICE', 'Há linhas sem preço.')
  if (w.pricingApproval)
    throw ApiError.conflict(
      'PRICING_APPROVAL_REQUIRED',
      'Há descontos acima do limite ou preços manuais: passe por orçamento ou encomenda aprovados.'
    )
  // Série fiscal de facturas da entidade, do ano da data: a indicada ou a única activa.
  const year = Number(i.idate.slice(0, 4))
  let seriesId = typeof seriesInput === 'string' && seriesInput ? seriesInput : null
  if (!seriesId) {
    const ser = (
      await scope.trx.rawQuery(
        `select id, code from fiscal_series where tenant_id = ? and legal_entity_id = ? and document_kind = ? and status = 'ACTIVE' and fiscal_year = ? order by code`,
        [context.tenantId, i.legal_entity_id, kind, year]
      )
    ).rows as any[]
    if (!ser.length)
      throw ApiError.conflict(
        'NO_SERIES',
        `Sem série fiscal de ${kind === 'INVOICE' ? 'facturas' : 'facturas-recibo'} activa para ${year} nesta entidade.`
      )
    if (ser.length > 1)
      throw new ApiError(
        409,
        'SERIES_REQUIRED',
        'Há várias séries de facturas activas: escolha uma.',
        [
          {
            path: 'seriesId',
            code: 'REQUIRED',
            message: `Escolha a série (${ser.map((x) => x.code).join(', ')}).`,
          },
        ]
      )
    seriesId = ser[0].id
  }
  const le = (await legalEntityFacts(scope, i.legal_entity_id))!
  const functional = le.functionalCurrency
  const cur = String(i.currency).trim()
  let rate = '1.0000000000'
  if (cur !== functional) {
    const r = await rateOn(scope, cur, functional, i.idate)
    if (!r) throw ApiError.conflict('NO_RATE', `Sem câmbio ${cur}→${functional} até ${i.idate}.`)
    rate = r.rate
  }
  const fiscalNo = await allocateFiscalNumber(scope, {
    seriesId: seriesId!,
    legalEntityId: i.legal_entity_id,
    documentKind: kind,
    issueDate: i.idate,
    documentType: 'SALES_INVOICE',
    documentId: id,
  })
  if (i.order_id)
    await recordInvoiced(
      scope,
      i.order_id,
      w.priced.map((p) => ({ orderLineId: p.input.orderLineId!, quantity: p.input.quantity })),
      fiscalNo.formatted
    )
  const dueDate = addDays(i.idate, Number(i.payment_terms_days))
  const content = {
    number: fiscalNo.formatted,
    series: fiscalNo.seriesId,
    mode: fiscalNo.mode,
    legalEntity: { id: le.id, code: le.code },
    branchId: i.branch_id,
    customer: { versionId: customer.versionId, data: customer.data },
    invoiceDate: i.idate,
    dueDate,
    currency: cur,
    exchangeRate: rate,
    lines: w.priced.map((p, n) => ({
      n: n + 1,
      productId: p.productId,
      description: p.description,
      quantity: p.input.quantity,
      uom: p.uom,
      unitPrice: p.netUnitPrice,
      net: p.netAmount,
      taxes: w.taxes!.lines[n].taxes,
    })),
    totals: w.taxes!.totals,
  }
  const payable = w.taxes!.totals.payable
  await setInvoice(scope, id, {
    status: 'ISSUED',
    series_id: fiscalNo.seriesId,
    fiscal_number: fiscalNo.number,
    number: fiscalNo.formatted,
    customer_version_id: customer.versionId,
    customer_snapshot: JSON.stringify(customer.data),
    due_date: dueDate,
    functional_currency: functional,
    exchange_rate: rate,
    fiscal_status: 'PENDING',
    collection_status: dbScaled(payable, 2) === 0n ? 'PAID' : 'UNPAID',
    document_hash: documentHash(content),
    issued_by: context.userId,
    issued_at: new Date(),
  })
  // Comunicação fiscal (10.9): fila na mesma transacção, só em simulação.
  await enqueueFiscalDocument(scope, { documentType: 'SALES_INVOICE', documentId: id })
  await event(scope, id, 'ISSUED', null, {
    number: fiscalNo.formatted,
    mode: fiscalNo.mode,
    payable,
  })
  await audit(scope, {
    action: 'sales_invoice.issued',
    entityType: 'sales_invoice',
    entityId: id,
    changes: { status: { from: 'DRAFT', to: 'ISSUED' } },
    metadata: { number: fiscalNo.formatted, mode: fiscalNo.mode, payable },
  })
  return { payable: w.taxes!.totals.payable }
}

export class InvoiceService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      fiscalStatus?: string
      collection?: string
      customerId?: string
      orderId?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const all = Object.values(s)
      const where = ['i.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!all.some((x) => x.tenant)) {
        const les = [...new Set(all.flatMap((x) => [...x.legalEntityIds]))]
        if (!les.length) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar facturas.')
        where.push(`i.legal_entity_id in (${les.map(() => '?').join(', ')})`)
        params.push(...les)
      }
      if (f.status && (INVOICE_STATUSES as readonly string[]).includes(f.status))
        (where.push('i.status = ?'), params.push(f.status))
      if (f.fiscalStatus) (where.push('i.fiscal_status = ?'), params.push(f.fiscalStatus))
      if (f.collection === 'OVERDUE')
        (where.push(
          `i.status in ('ISSUED','CORRECTED') and i.collection_status <> 'PAID' and i.due_date < ?::date`
        ),
          params.push(today()))
      else if (f.collection) (where.push('i.collection_status = ?'), params.push(f.collection))
      for (const [k, col] of [
        ['customerId', 'i.customer_id'],
        ['orderId', 'i.order_id'],
      ] as const)
        if (f[k] && isUuid(f[k])) (where.push(`${col} = ?`), params.push(f[k]))
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(i.number, '')) like ? or lower(bp.code) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like)
      }
      const from = `from sales_invoices i join customers c on c.tenant_id = i.tenant_id and c.id = i.customer_id
        join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
        join legal_entities le on le.tenant_id = i.tenant_id and le.id = i.legal_entity_id where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select i.*, i.invoice_date::text as idate, i.due_date::text as ddate, bp.code as cus_code, bp.name as cus_name, le.code as le_code
             ${from} order by i.created_at desc, i.id limit ? offset ?`,
          [...params, f.limit, f.offset] as never[]
        )
      ).rows as any[]
      const total = Number(
        (
          (await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[]))
            .rows[0] as any
        ).n
      )
      return {
        items: rows.map((i) => ({
          id: i.id as string,
          number: (i.number as string) ?? null,
          customer: { code: i.cus_code as string, name: i.cus_name as string },
          legalEntity: i.le_code as string,
          invoiceDate: i.idate as string,
          dueDate: (i.ddate as string) ?? null,
          currency: String(i.currency).trim(),
          payableTotal: money(i.payable_total),
          paidTotal: money(i.paid_total),
          openTotal:
            i.status === 'ISSUED' || i.status === 'CORRECTED' ? scaledText(openOf(i), 2) : null,
          status: i.status as string,
          fiscalStatus: (i.fiscal_status as string) ?? null,
          collectionStatus: collectionView(i.status, i.collection_status, i.ddate, today()),
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const { g } = await authorized(scope, id, 'read')
      return detail(scope, id, g)
    })
  }

  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const t = context.tenantId
      const les = (
        (
          await scope.trx.rawQuery(
            `select id, code, legal_name, status, country_code from legal_entities where tenant_id = ? order by code`,
            [t]
          )
        ).rows as any[]
      ).filter((l) => l.status === 'ACTIVE' && covers(s.manage, l.id))
      const branches = (
        await scope.trx.rawQuery(
          `select id, code, name, legal_entity_id from branches where tenant_id = ? and status = 'ACTIVE' order by code`,
          [t]
        )
      ).rows as any[]
      const series = (
        await scope.trx.rawQuery(
          `select id, code, prefix, legal_entity_id, fiscal_year, mode from fiscal_series where tenant_id = ? and document_kind = 'INVOICE' and status = 'ACTIVE' order by code`,
          [t]
        )
      ).rows as any[]
      const codes = (
        await scope.trx.rawQuery(
          `select id, code, name, kind, country_code from tax_codes where tenant_id = ? and status = 'ACTIVE' order by kind, code`,
          [t]
        )
      ).rows as any[]
      const exemptions = (
        await scope.trx.rawQuery(
          `select code, description, country_code from tax_exemptions where tenant_id = ? and status = 'CONFIRMED' order by code`,
          [t]
        )
      ).rows as any[]
      return {
        legalEntities: les.map((l) => ({
          id: l.id as string,
          code: l.code as string,
          name: l.legal_name as string,
          countryCode: String(l.country_code).trim(),
        })),
        branches: branches.map((b) => ({
          id: b.id as string,
          code: b.code as string,
          name: b.name as string,
          legalEntityId: b.legal_entity_id as string,
        })),
        series: series.map((x) => ({
          id: x.id as string,
          code: x.code as string,
          prefix: x.prefix as string,
          legalEntityId: x.legal_entity_id as string,
          fiscalYear: Number(x.fiscal_year),
          mode: x.mode as string,
        })),
        taxCodes: codes.map((c) => ({
          id: c.id as string,
          code: c.code as string,
          name: c.name as string,
          kind: c.kind as string,
          countryCode: String(c.country_code).trim(),
        })),
        exemptions: exemptions.map((x) => ({
          code: x.code as string,
          description: x.description as string,
          countryCode: String(x.country_code).trim(),
        })),
      }
    })
  }

  search(context: TenantContext, kind: 'customers' | 'products', q: string) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!(s.manage.tenant || s.manage.legalEntityIds.size))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere facturas.')
      return searchSalesRefs(scope, kind, q)
    })
  }

  /** O que uma encomenda tem por facturar, com o imposto sugerido por linha. */
  orderDraft(context: TenantContext, orderId: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(orderId)) throw ApiError.notFound()
      const o = (
        await scope.trx.rawQuery(
          `select legal_entity_id from sales_orders where tenant_id = ? and id = ?`,
          [context.tenantId, orderId]
        )
      ).rows[0] as any
      if (!o) throw ApiError.notFound()
      if (!covers((await scopesOf(scope)).manage, o.legal_entity_id))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere facturas desta entidade.')
      const { order, lines } = await invoiceableOrder(scope, orderId)
      const out = []
      for (const l of lines)
        if (dbScaled(l.invoiceable, QTY_SCALE) > 0n)
          out.push({
            ...l,
            suggestedTaxCodeIds: await suggestTaxCodes(
              scope,
              order.legal_entity_id,
              today(),
              l.taxRate
            ),
          })
      return {
        orderId,
        number: order.number as string,
        legalEntityId: order.legal_entity_id as string,
        lines: out,
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const orderId = input.orderId ?? null
      if (orderId !== null && !isUuid(orderId))
        fail([{ path: 'orderId', code: 'INVALID', message: 'Encomenda inválida.' }])
      const order = orderId
        ? ((
            await scope.trx.rawQuery(
              `select o.*, o.order_date::text as od from sales_orders o where tenant_id = ? and id = ?`,
              [context.tenantId, orderId as string]
            )
          ).rows[0] as any)
        : null
      if (orderId && !order) throw ApiError.notFound()
      const { v, issues } = normalizeInvoiceHeader(
        order
          ? { ...input, legalEntityId: order.legal_entity_id, customerId: order.customer_id }
          : input,
        true
      )
      const nl = normalizeInvoiceLines(input.lines ?? [], !!order)
      fail([...issues, ...nl.issues])
      const le = await legalEntityFacts(scope, v.legalEntityId as string)
      if (!le)
        fail([{ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' }])
      if (!covers((await scopesOf(scope)).manage, le!.id))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere facturas desta entidade.')
      if (le!.status !== 'ACTIVE')
        throw ApiError.conflict('INVALID_STATE', 'A entidade legal não está activa.')
      const c = await customerRow(scope, v.customerId as string)
      if (!c) fail([{ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' }])
      customerActive(c)
      if (v.branchId) {
        const b = (
          await scope.trx.rawQuery(
            `select legal_entity_id from branches where tenant_id = ? and id = ?`,
            [context.tenantId, v.branchId as string]
          )
        ).rows[0] as any
        if (!b || b.legal_entity_id !== le!.id)
          fail([
            {
              path: 'branchId',
              code: 'NOT_FOUND',
              message: 'Estabelecimento inexistente nesta entidade.',
            },
          ])
      }
      const ins = await scope.trx.rawQuery(
        `insert into sales_invoices (tenant_id, legal_entity_id, branch_id, customer_id, order_id, invoice_date, currency,
           payment_terms_days, customer_reference, notes, created_by, updated_by, document_kind)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          le!.id,
          v.branchId ?? null,
          c.id,
          orderId,
          v.invoiceDate,
          order
            ? String(order.currency).trim()
            : ((v.currency as string) ?? String(c.currency).trim()),
          order
            ? Number(order.payment_terms_days)
            : ((v.paymentTermsDays as number) ?? Number(c.payment_terms_days)),
          (v.customerReference as string) ?? order?.customer_reference ?? null,
          v.notes ?? null,
          context.userId,
          context.userId,
          input.documentKind === 'INVOICE_RECEIPT' ? 'INVOICE_RECEIPT' : 'INVOICE',
        ] as never[]
      )
      const id = (ins.rows[0] as any).id as string
      await writeLines(scope, await load(scope, id), nl.lines)
      await event(
        scope,
        id,
        order ? 'CREATED_FROM_ORDER' : 'CREATED',
        null,
        order ? { order: order.number } : undefined
      )
      await audit(scope, {
        action: 'sales_invoice.created',
        entityType: 'sales_invoice',
        entityId: id,
        changes: { customerId: { from: null, to: c.id } },
        metadata: order ? { orderId } : undefined,
      })
      return detail(scope, id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { i } = await authorized(scope, id, 'manage', true)
      versionCheck(i, input.expectedVersion)
      if (i.status !== 'DRAFT')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se altera em rascunho: emitida, corrige-se por nota de crédito ou débito.'
        )
      const { expectedVersion, legalEntityId, lines: rawLines, ...rest } = input
      for (const k of i.order_id ? ['customerId', 'currency', 'paymentTermsDays'] : [])
        if (k in rest) fail([{ path: k, code: 'NOT_ALLOWED', message: 'Vem da encomenda.' }])
      for (const k of i.recurring_version_id ? ['customerId', 'currency'] : [])
        if (k in rest)
          fail([{ path: k, code: 'NOT_ALLOWED', message: 'Vem do contrato recorrente.' }])
      const { v, issues } = normalizeInvoiceHeader(rest, false)
      const nl = rawLines === undefined ? null : normalizeInvoiceLines(rawLines, !!i.order_id)
      fail([...issues, ...(nl?.issues ?? [])])
      if (v.customerId && v.customerId !== i.customer_id) {
        const c = await customerRow(scope, v.customerId as string)
        if (!c) fail([{ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' }])
        customerActive(c)
      }
      if (v.branchId) {
        const b = (
          await scope.trx.rawQuery(
            `select legal_entity_id from branches where tenant_id = ? and id = ?`,
            [context.tenantId, v.branchId as string]
          )
        ).rows[0] as any
        if (!b || b.legal_entity_id !== i.legal_entity_id)
          fail([
            {
              path: 'branchId',
              code: 'NOT_FOUND',
              message: 'Estabelecimento inexistente nesta entidade.',
            },
          ])
      }
      const map: Record<string, string> = {
        customerId: 'customer_id',
        branchId: 'branch_id',
        invoiceDate: 'invoice_date',
        currency: 'currency',
        paymentTermsDays: 'payment_terms_days',
        customerReference: 'customer_reference',
        notes: 'notes',
      }
      const fields = Object.fromEntries(
        Object.entries(map)
          .filter(([k]) => k in v)
          .map(([k, col]) => [col, v[k]])
      )
      if (Object.keys(fields).length) await setInvoice(scope, id, fields)
      await writeLines(scope, await load(scope, id), nl ? nl.lines : await storedLines(scope, id))
      await audit(scope, {
        action: 'sales_invoice.updated',
        entityType: 'sales_invoice',
        entityId: id,
        metadata: { fields: Object.keys(fields), lines: nl ? nl.lines.length : undefined },
      })
      return detail(scope, id)
    })
  }

  /**
   * Emitir: recalcula preços e impostos à data, fotografa o cliente, fixa o câmbio, regista o facturado na encomenda,
   * numera pela série fiscal (simulação) e fixa a impressão digital. Uma segunda emissão é recusada (nunca dois números).
   */
  issue(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { i } = await authorized(scope, id, 'issue', true)
      if (i.status !== 'DRAFT')
        throw ApiError.conflict('ALREADY_ISSUED', 'A factura já foi emitida (ou descartada).')
      versionCheck(i, input.expectedVersion)
      if (i.document_kind === 'INVOICE_RECEIPT')
        throw ApiError.conflict(
          'FR_NEEDS_PAYMENT',
          'A factura-recibo emite-se quando a tesouraria confirma o recebimento (registe o recibo).'
        )
      await issueDraft(scope, i, input.seriesId)
      return detail(scope, id)
    })
  }

  discard(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { i } = await authorized(scope, id, 'manage', true)
      versionCheck(i, input.expectedVersion)
      if (i.status !== 'DRAFT')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se descarta um rascunho; emitida, corrige-se por nota de crédito.'
        )
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      if (reason.length < 3 || reason.length > 500)
        fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' }])
      await setInvoice(scope, id, { status: 'DISCARDED', discard_reason: reason })
      await event(scope, id, 'DISCARDED', reason)
      await audit(scope, {
        action: 'sales_invoice.discarded',
        entityType: 'sales_invoice',
        entityId: id,
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }
}

/** Acesso aos anexos da factura. */
export async function invoiceAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const i = (
    await scope.trx.rawQuery(
      `select legal_entity_id from sales_invoices where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!i) return null
  const g = rights(await scopesOf(scope), i.legal_entity_id)
  return g.read ? { read: true, write: g.manage || g.issue } : null
}

/**
 * Aplica um pagamento confirmado a uma factura emitida (na transacção de quem chama): bloqueia a factura, nunca deixa
 * o pago passar o valor a pagar (`OVER_PAYMENT`) e actualiza o estado de cobrança.
 */
export async function applyInvoicePayment(scope: TenantScope, invoiceId: string, amount: string) {
  const i = await load(scope, invoiceId, true)
  if (i.status !== 'ISSUED' && i.status !== 'CORRECTED')
    throw ApiError.conflict('INVOICE_NOT_ISSUED', 'Só se recebe de facturas emitidas.')
  const open = openOf(i)
  if (dbScaled(amount, 2) > open)
    throw ApiError.conflict(
      'OVER_PAYMENT',
      `A factura ${i.number} só tem ${scaledText(open, 2)} por receber.`
    )
  const paid = cents(i.paid_total) + dbScaled(amount, 2)
  await setInvoice(scope, invoiceId, {
    paid_total: scaledText(paid, 2),
    collection_status: collectionOf(
      cents(i.payable_total),
      cents(i.debited_total),
      cents(i.credited_total),
      paid
    ),
  })
  await event(scope, invoiceId, 'PAYMENT', null, { amount, paid: scaledText(paid, 2) })
  return { number: i.number as string, open: scaledText(open - dbScaled(amount, 2), 2) }
}

/** Valores de uma factura para afectação: emitida, cliente, entidade, moeda e o que falta receber. */
export async function invoiceForPayment(scope: TenantScope, invoiceId: string) {
  if (!isUuid(invoiceId)) return null
  const i = (
    await scope.trx.rawQuery(
      `select id, number, status, document_kind, legal_entity_id, customer_id, currency, payable_total, paid_total,
              credited_total, debited_total from sales_invoices where tenant_id = ? and id = ?`,
      [scope.context.tenantId, invoiceId]
    )
  ).rows[0] as any
  if (!i) return null
  return {
    id: i.id as string,
    number: (i.number as string) ?? null,
    status: i.status as string,
    documentKind: i.document_kind as string,
    legalEntityId: i.legal_entity_id as string,
    customerId: i.customer_id as string,
    currency: String(i.currency).trim(),
    payable: money(i.payable_total),
    open: scaledText(openOf(i), 2),
  }
}

/** Rascunho de factura bloqueado para a emissão pela confirmação do recebimento (factura-recibo). */
export async function lockDraftInvoice(scope: TenantScope, invoiceId: string) {
  return load(scope, invoiceId, true)
}

/** Factura original de uma nota (10.8), com as linhas, bloqueada se pedido. */
export async function invoiceForNote(scope: TenantScope, invoiceId: string, lock = false) {
  if (!isUuid(invoiceId)) return null
  const i = (
    await scope.trx.rawQuery(
      `select *, invoice_date::text as idate from sales_invoices where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, invoiceId]
    )
  ).rows[0] as any
  if (!i) return null
  const lines = (
    await scope.trx.rawQuery(
      `select l.*, p.sku from sales_invoice_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
        where l.tenant_id = ? and l.invoice_id = ? order by l.line_no`,
      [scope.context.tenantId, invoiceId]
    )
  ).rows as any[]
  return { i, lines, open: openOf(i) }
}

/**
 * Efeito de uma nota emitida na factura original (na transacção de quem chama, com a factura bloqueada): a factura
 * passa a corrigida; o crédito abate o que está em dívida (`credit`, nunca acima) e o débito aumenta-o. Os totais
 * nunca descem (gatilho).
 */
export async function adjustInvoice(
  scope: TenantScope,
  invoiceId: string,
  change: { credit?: bigint; debit?: bigint; note: string }
) {
  const i = await load(scope, invoiceId, true)
  if (i.status !== 'ISSUED' && i.status !== 'CORRECTED')
    throw ApiError.conflict('INVOICE_NOT_ISSUED', 'Só se corrige uma factura emitida.')
  const credit = change.credit ?? 0n
  const debit = change.debit ?? 0n
  if (credit > openOf(i))
    throw ApiError.conflict(
      'OVER_CREDIT',
      `A factura ${i.number} só tem ${scaledText(openOf(i), 2)} em dívida.`
    )
  const credited = cents(i.credited_total) + credit
  const debited = cents(i.debited_total) + debit
  await setInvoice(scope, invoiceId, {
    status: 'CORRECTED',
    credited_total: scaledText(credited, 2),
    debited_total: scaledText(debited, 2),
    collection_status: collectionOf(cents(i.payable_total), debited, credited, cents(i.paid_total)),
  })
  await event(scope, invoiceId, debit > 0n ? 'DEBITED' : 'CREDITED', null, {
    note: change.note,
    amount: scaledText(debit > 0n ? debit : credit, 2),
  })
  return { number: i.number as string }
}

/**
 * Rascunho de factura de um período de contrato recorrente (10.11), na transacção de quem chama. Só rascunho: a emissão
 * é sempre de uma pessoa com `sales.invoices.issue`. Os preços fixados na versão aprovada entram com origem CONTRACT.
 */
export async function createRecurringDraft(
  scope: TenantScope,
  d: {
    legalEntityId: string
    customerId: string
    invoiceDate: string
    currency: string
    paymentTermsDays: number
    customerReference: string
    notes: string
    versionId: string
    lines: InvoiceLineInput[]
  }
) {
  const context = scope.context
  const ins = await scope.trx.rawQuery(
    `insert into sales_invoices (tenant_id, legal_entity_id, customer_id, invoice_date, currency, payment_terms_days,
       customer_reference, notes, recurring_version_id, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
    [
      context.tenantId,
      d.legalEntityId,
      d.customerId,
      d.invoiceDate,
      d.currency,
      d.paymentTermsDays,
      d.customerReference.slice(0, 60),
      d.notes.slice(0, 2000),
      d.versionId,
      context.userId,
      context.userId,
    ] as never[]
  )
  const id = (ins.rows[0] as any).id as string
  await writeLines(scope, await load(scope, id), d.lines)
  await event(scope, id, 'CREATED_RECURRING', null, { reference: d.customerReference })
  await audit(scope, {
    action: 'sales_invoice.created',
    entityType: 'sales_invoice',
    entityId: id,
    changes: { customerId: { from: null, to: d.customerId } },
    metadata: { recurring: d.customerReference },
  })
  return id
}
