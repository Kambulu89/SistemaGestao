import { createHash } from 'node:crypto'
import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { allocateFiscalNumber } from '#modules/sales/application/fiscal_service'
import {
  applyInvoicePayment,
  invoiceForPayment,
  issueDraft,
  lockDraftInvoice,
} from '#modules/sales/application/invoice_service'
import { searchSalesRefs } from '#modules/sales/application/pricing_service'
import { dbScaled, parseScaled, scaledText } from '#modules/sales/domain/pricing'

/*
 * Recibos, factura-recibo e adiantamentos (10.7). Permissões no âmbito da entidade legal: `sales.receipts.read`,
 * `.manage` (registar recebimentos com afectações, anular pendentes, usar adiantamentos) e `.confirm` (confirmação
 * financeira: só então o dinheiro conta — afecta as facturas, numera o recibo, emite a factura-recibo, cria o
 * adiantamento; nunca quem registou). Não há módulo financeiro: o registo e a confirmação ficam aqui como contrato
 * até ao Prompt 11 (Finanças), que passará a ser o dono da confirmação bancária.
 */

const today = () => new Date().toISOString().slice(0, 10)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const money = (v: unknown) => scaledText(dbScaled(v, 2), 2)
const cents = (v: unknown) => dbScaled(v, 2)
const METHODS = ['CASH', 'TRANSFER', 'CARD', 'CHEQUE', 'OTHER'] as const
export const RECEIPT_STATUSES = ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED'] as const

type Need = 'read' | 'manage' | 'confirm'
async function scopesOf(scope: TenantScope): Promise<Record<Need, PermissionScope>> {
  return {
    read: await permissionScope(scope, 'sales.receipts.read'),
    manage: await permissionScope(scope, 'sales.receipts.manage'),
    confirm: await permissionScope(scope, 'sales.receipts.confirm'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
function rights(s: Record<Need, PermissionScope>, le: string) {
  const manage = covers(s.manage, le)
  const confirm = covers(s.confirm, le)
  return { read: manage || confirm || covers(s.read, le), manage, confirm }
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select *, received_date::text as rdate from sales_receipts where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}
async function authorized(scope: TenantScope, id: string, need: Need, lock = false) {
  const r = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), r.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (!g[need])
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      need === 'confirm'
        ? 'Não confirma recebimentos desta entidade.'
        : 'Não gere recebimentos desta entidade.'
    )
  return { r, g }
}
const versionCheck = (r: any, expected: unknown) => {
  if (Number(r.version) !== Number(expected)) throw ApiError.versionConflict(Number(r.version))
}
async function setReceipt(scope: TenantScope, id: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields)
  await scope.trx.rawQuery(
    `update sales_receipts set ${cols.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = now(), updated_by = ?
      where tenant_id = ? and id = ?`,
    [...cols.map((c) => fields[c]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}
const reasonOf = (v: unknown) => {
  const r = typeof v === 'string' ? v.trim() : ''
  if (r.length < 3 || r.length > 500)
    fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' }])
  return r
}

async function detail(scope: TenantScope, id: string, g?: ReturnType<typeof rights>) {
  const t = scope.context.tenantId
  const r = (
    await scope.trx.rawQuery(
      `select r.*, r.received_date::text as rdate, le.code as le_code, bp.code as cus_code, bp.name as cus_name,
              ba.bank_name, ba.holder_name, inv.number as fr_number, inv.status as fr_status, cu.full_name as creator,
              fu.full_name as confirmer
         from sales_receipts r
         join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
         join customers c on c.tenant_id = r.tenant_id and c.id = r.customer_id
         join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
         left join bank_accounts ba on ba.tenant_id = r.tenant_id and ba.id = r.bank_account_id
         left join sales_invoices inv on inv.tenant_id = r.tenant_id and inv.id = r.invoice_id
         left join users cu on cu.id = r.created_by
         left join users fu on fu.id = r.confirmed_by
        where r.tenant_id = ? and r.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  const allocations = (
    await scope.trx.rawQuery(
      `select a.invoice_id, a.amount, i.number from sales_receipt_allocations a join sales_invoices i on i.tenant_id = a.tenant_id and i.id = a.invoice_id
        where a.tenant_id = ? and a.receipt_id = ? order by i.number`,
      [t, id]
    )
  ).rows as any[]
  const applications = (
    await scope.trx.rawQuery(
      `select x.invoice_id, x.amount, x.created_at, i.number, u.full_name from sales_advance_applications x
         join sales_invoices i on i.tenant_id = x.tenant_id and i.id = x.invoice_id left join users u on u.id = x.created_by
        where x.tenant_id = ? and x.receipt_id = ? order by x.created_at`,
      [t, id]
    )
  ).rows as any[]
  const a = g ?? rights(await scopesOf(scope), r.legal_entity_id)
  const pending = r.status === 'PENDING'
  const remaining = cents(r.advance_total) - cents(r.advance_used)
  return {
    id: r.id as string,
    version: Number(r.version),
    number: (r.number as string) ?? null,
    purpose: r.purpose as string,
    status: r.status as string,
    legalEntity: { id: r.legal_entity_id as string, code: r.le_code as string },
    customer: {
      id: r.customer_id as string,
      code: r.cus_code as string,
      name: r.cus_name as string,
    },
    invoice: r.invoice_id
      ? {
          id: r.invoice_id as string,
          number: (r.fr_number as string) ?? null,
          status: r.fr_status as string,
        }
      : null,
    currency: String(r.currency).trim(),
    amount: money(r.amount),
    method: r.method as string,
    bankAccount: r.bank_account_id
      ? { id: r.bank_account_id as string, label: `${r.bank_name} — ${r.holder_name}` }
      : null,
    reference: (r.reference as string) ?? null,
    receivedDate: r.rdate as string,
    notes: (r.notes as string) ?? null,
    allocatedTotal: money(r.allocated_total),
    advanceTotal: money(r.advance_total),
    advanceUsed: money(r.advance_used),
    advanceRemaining: scaledText(remaining, 2),
    registeredBy: (r.creator as string) ?? null,
    confirmedBy: (r.confirmer as string) ?? null,
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
    decisionReason: (r.decision_reason as string) ?? null,
    allocations: allocations.map((x) => ({
      invoiceId: x.invoice_id as string,
      number: x.number as string,
      amount: money(x.amount),
    })),
    applications: applications.map((x) => ({
      invoiceId: x.invoice_id as string,
      number: x.number as string,
      amount: money(x.amount),
      at: new Date(x.created_at).toISOString(),
      by: (x.full_name as string) ?? null,
    })),
    can: {
      confirm: a.confirm && pending && r.created_by !== scope.context.userId,
      reject: a.confirm && pending,
      cancel: a.manage && pending,
      applyAdvance: a.manage && r.status === 'CONFIRMED' && remaining > 0n,
    },
  }
}
export type ReceiptView = Awaited<ReturnType<typeof detail>>

/** Série fiscal de recibos da entidade e do ano: a indicada ou a única activa. */
async function receiptSeries(scope: TenantScope, le: string, year: number, wanted: unknown) {
  if (typeof wanted === 'string' && wanted) return wanted
  const ser = (
    await scope.trx.rawQuery(
      `select id, code from fiscal_series where tenant_id = ? and legal_entity_id = ? and document_kind = 'RECEIPT' and status = 'ACTIVE' and fiscal_year = ? order by code`,
      [scope.context.tenantId, le, year]
    )
  ).rows as any[]
  if (!ser.length)
    throw ApiError.conflict(
      'NO_SERIES',
      `Sem série fiscal de recibos activa para ${year} nesta entidade.`
    )
  if (ser.length > 1)
    throw new ApiError(
      409,
      'SERIES_REQUIRED',
      'Há várias séries de recibos activas: escolha uma.',
      [
        {
          path: 'seriesId',
          code: 'REQUIRED',
          message: `Escolha a série (${ser.map((x) => x.code).join(', ')}).`,
        },
      ]
    )
  return ser[0].id as string
}

export class ReceiptService {
  list(
    context: TenantContext,
    f: {
      q?: string
      status?: string
      customerId?: string
      advances?: boolean
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const all = Object.values(s)
      const where = ['r.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!all.some((x) => x.tenant)) {
        const les = [...new Set(all.flatMap((x) => [...x.legalEntityIds]))]
        if (!les.length)
          throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar recebimentos.')
        where.push(`r.legal_entity_id in (${les.map(() => '?').join(', ')})`)
        params.push(...les)
      }
      if (f.status && (RECEIPT_STATUSES as readonly string[]).includes(f.status))
        (where.push('r.status = ?'), params.push(f.status))
      if (f.customerId && isUuid(f.customerId))
        (where.push('r.customer_id = ?'), params.push(f.customerId))
      if (f.advances) where.push(`r.status = 'CONFIRMED' and r.advance_total > r.advance_used`)
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        where.push(
          `(lower(coalesce(r.number, '')) like ? or lower(coalesce(r.reference, '')) like ? or lower(bp.code) like ? or lower(bp.name) like ?)`
        )
        params.push(like, like, like, like)
      }
      const from = `from sales_receipts r join customers c on c.tenant_id = r.tenant_id and c.id = r.customer_id
        join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
        left join sales_invoices inv on inv.tenant_id = r.tenant_id and inv.id = r.invoice_id where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select r.*, r.received_date::text as rdate, bp.code as cus_code, bp.name as cus_name, inv.number as fr_number
             ${from} order by r.created_at desc, r.id limit ? offset ?`,
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
        items: rows.map((r) => ({
          id: r.id as string,
          number: (r.number as string) ?? (r.fr_number as string) ?? null,
          purpose: r.purpose as string,
          customer: { code: r.cus_code as string, name: r.cus_name as string },
          receivedDate: r.rdate as string,
          currency: String(r.currency).trim(),
          amount: money(r.amount),
          method: r.method as string,
          reference: (r.reference as string) ?? null,
          advanceRemaining: scaledText(cents(r.advance_total) - cents(r.advance_used), 2),
          status: r.status as string,
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
            `select id, code, legal_name, status from legal_entities where tenant_id = ? order by code`,
            [t]
          )
        ).rows as any[]
      ).filter((l) => l.status === 'ACTIVE' && (covers(s.manage, l.id) || covers(s.confirm, l.id)))
      const banks = (
        await scope.trx.rawQuery(
          `select id, legal_entity_id, bank_name, holder_name, currency from bank_accounts where tenant_id = ? and status = 'ACTIVE' order by bank_name`,
          [t]
        )
      ).rows as any[]
      const series = (
        await scope.trx.rawQuery(
          `select id, code, prefix, legal_entity_id, fiscal_year, document_kind from fiscal_series where tenant_id = ? and document_kind in ('RECEIPT','INVOICE_RECEIPT') and status = 'ACTIVE' order by code`,
          [t]
        )
      ).rows as any[]
      return {
        legalEntities: les.map((l) => ({
          id: l.id as string,
          code: l.code as string,
          name: l.legal_name as string,
        })),
        bankAccounts: banks.map((b) => ({
          id: b.id as string,
          legalEntityId: b.legal_entity_id as string,
          label: `${b.bank_name} — ${b.holder_name}`,
          currency: String(b.currency).trim(),
        })),
        series: series.map((x) => ({
          id: x.id as string,
          code: x.code as string,
          prefix: x.prefix as string,
          legalEntityId: x.legal_entity_id as string,
          fiscalYear: Number(x.fiscal_year),
          documentKind: x.document_kind as string,
        })),
      }
    })
  }

  search(context: TenantContext, q: string) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!(s.manage.tenant || s.manage.legalEntityIds.size))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere recebimentos.')
      return searchSalesRefs(scope, 'customers', q)
    })
  }

  /** Facturas emitidas por receber de um cliente numa entidade (para afectar) e adiantamentos disponíveis. */
  openItems(context: TenantContext, legalEntityId: string, customerId: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(legalEntityId) || !isUuid(customerId)) throw ApiError.notFound()
      const s = await scopesOf(scope)
      if (!covers(s.manage, legalEntityId))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere recebimentos desta entidade.')
      const t = context.tenantId
      const exists = await scope.trx.rawQuery(
        `select 1 from legal_entities le join customers c on c.tenant_id = le.tenant_id and c.id = ?
          where le.tenant_id = ? and le.id = ?`,
        [customerId, t, legalEntityId]
      )
      if (!exists.rows[0]) throw ApiError.notFound()
      const inv = (
        await scope.trx.rawQuery(
          `select id, number, invoice_date::text as d, due_date::text as due, currency, payable_total, paid_total, document_kind
             from sales_invoices where tenant_id = ? and legal_entity_id = ? and customer_id = ? and status in ('ISSUED','CORRECTED')
              and paid_total < payable_total order by due_date, number`,
          [t, legalEntityId, customerId]
        )
      ).rows as any[]
      const drafts = (
        await scope.trx.rawQuery(
          `select id, invoice_date::text as d, currency, payable_total from sales_invoices where tenant_id = ? and legal_entity_id = ?
              and customer_id = ? and status = 'DRAFT' and document_kind = 'INVOICE_RECEIPT' order by created_at`,
          [t, legalEntityId, customerId]
        )
      ).rows as any[]
      const adv = (
        await scope.trx.rawQuery(
          `select id, number, currency, advance_total, advance_used from sales_receipts where tenant_id = ? and legal_entity_id = ?
              and customer_id = ? and status = 'CONFIRMED' and advance_total > advance_used order by confirmed_at`,
          [t, legalEntityId, customerId]
        )
      ).rows as any[]
      return {
        invoices: inv.map((i) => ({
          id: i.id as string,
          number: i.number as string,
          invoiceDate: i.d as string,
          dueDate: i.due as string,
          currency: String(i.currency).trim(),
          open: scaledText(cents(i.payable_total) - cents(i.paid_total), 2),
        })),
        invoiceReceiptDrafts: drafts.map((d) => ({
          id: d.id as string,
          invoiceDate: d.d as string,
          currency: String(d.currency).trim(),
          payable: money(d.payable_total),
        })),
        advances: adv.map((r) => ({
          id: r.id as string,
          number: r.number as string,
          currency: String(r.currency).trim(),
          remaining: scaledText(cents(r.advance_total) - cents(r.advance_used), 2),
        })),
      }
    })
  }

  /** Registar um recebimento (pendente de confirmação financeira), idempotente pela chave do pedido. */
  register(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const issues: ErrorDetail[] = []
      const t = context.tenantId
      const purpose =
        input.purpose === 'INVOICE_RECEIPT'
          ? 'INVOICE_RECEIPT'
          : input.purpose === 'RECEIPT' || input.purpose === undefined
            ? 'RECEIPT'
            : null
      if (!purpose)
        issues.push({ path: 'purpose', code: 'INVALID', message: 'Recibo ou factura-recibo.' })
      for (const k of ['legalEntityId', 'customerId'] as const)
        if (!isUuid(input[k])) issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      const amount = parseScaled(input.amount, 2)
      if (amount === null || amount === 0n)
        issues.push({
          path: 'amount',
          code: 'INVALID',
          message: 'Valor maior que 0, 2 casas, em texto.',
        })
      if (!(METHODS as readonly unknown[]).includes(input.method))
        issues.push({ path: 'method', code: 'INVALID', message: 'Meio de pagamento inválido.' })
      const date = input.receivedDate
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        issues.push({ path: 'receivedDate', code: 'INVALID', message: 'Data obrigatória.' })
      else if (date > today())
        issues.push({
          path: 'receivedDate',
          code: 'FUTURE',
          message: 'Não se regista um recebimento futuro.',
        })
      const key = typeof input.requestKey === 'string' ? input.requestKey.trim() : ''
      if (!/^[A-Za-z0-9:._-]{8,80}$/.test(key))
        issues.push({
          path: 'requestKey',
          code: 'INVALID',
          message: 'Chave do pedido (8 a 80 caracteres).',
        })
      const reference =
        typeof input.reference === 'string' && input.reference.trim()
          ? input.reference.trim()
          : null
      if (reference && reference.length > 80)
        issues.push({ path: 'reference', code: 'LENGTH', message: 'Até 80 caracteres.' })
      if (['TRANSFER', 'CARD', 'CHEQUE'].includes(input.method as string) && !reference)
        issues.push({
          path: 'reference',
          code: 'REQUIRED',
          message: 'Indique a referência do movimento.',
        })
      const notes =
        typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null
      if (notes && notes.length > 500)
        issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 500 caracteres.' })
      const allocations: { invoiceId: string; amount: bigint }[] = []
      if (purpose === 'RECEIPT' && input.allocations !== undefined) {
        if (!Array.isArray(input.allocations) || input.allocations.length > 100)
          issues.push({ path: 'allocations', code: 'INVALID', message: 'Até 100 facturas.' })
        else
          input.allocations.forEach((x: any, i: number) => {
            const v = parseScaled(x?.amount, 2)
            if (!isUuid(x?.invoiceId))
              issues.push({
                path: `allocations.${i}.invoiceId`,
                code: 'REQUIRED',
                message: 'Factura.',
              })
            if (v === null || v === 0n)
              issues.push({
                path: `allocations.${i}.amount`,
                code: 'INVALID',
                message: 'Valor maior que 0.',
              })
            if (allocations.some((y) => y.invoiceId === x?.invoiceId))
              issues.push({
                path: `allocations.${i}.invoiceId`,
                code: 'DUPLICATE',
                message: 'Factura repetida.',
              })
            allocations.push({ invoiceId: x?.invoiceId, amount: v ?? 0n })
          })
      }
      fail(issues)
      const le = input.legalEntityId as string
      if (!covers((await scopesOf(scope)).manage, le))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere recebimentos desta entidade.')
      const hash = createHash('sha256')
        .update(
          JSON.stringify([
            purpose,
            le,
            input.customerId,
            scaledText(amount!, 2),
            input.method,
            reference,
            date,
            input.invoiceId ?? null,
            allocations.map((a) => [a.invoiceId, scaledText(a.amount, 2)]),
          ])
        )
        .digest('hex')
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `receipt:${t}:${le}:${key}`,
      ])
      const prev = (
        await scope.trx.rawQuery(
          `select id, request_hash from sales_receipts where tenant_id = ? and legal_entity_id = ? and request_key = ?`,
          [t, le, key]
        )
      ).rows[0] as any
      if (prev) {
        if (prev.request_hash !== hash)
          throw ApiError.conflict(
            'IDEMPOTENCY_MISMATCH',
            'Esta chave já foi usada num recebimento diferente.'
          )
        return detail(scope, prev.id)
      }
      const c = (
        await scope.trx.rawQuery(
          `select id, currency from customers where tenant_id = ? and id = ?`,
          [t, input.customerId as string]
        )
      ).rows[0] as any
      if (!c) fail([{ path: 'customerId', code: 'NOT_FOUND', message: 'Cliente inexistente.' }])
      let currency =
        typeof input.currency === 'string' && /^[A-Za-z]{3}$/.test(input.currency)
          ? input.currency.toUpperCase()
          : String(c.currency).trim()
      let invoiceId: string | null = null
      if (purpose === 'INVOICE_RECEIPT') {
        const inv = await invoiceForPayment(scope, input.invoiceId as string)
        if (!inv || inv.legalEntityId !== le || inv.customerId !== c.id)
          fail([
            {
              path: 'invoiceId',
              code: 'NOT_FOUND',
              message: 'Factura-recibo inexistente para este cliente e entidade.',
            },
          ])
        if (inv!.status !== 'DRAFT' || inv!.documentKind !== 'INVOICE_RECEIPT')
          throw ApiError.conflict(
            'INVALID_STATE',
            'Só uma factura-recibo em rascunho se emite com um recebimento.'
          )
        if (cents(inv!.payable) !== amount)
          throw new ApiError(
            409,
            'AMOUNT_MISMATCH',
            `O recebimento tem de ser o total a pagar da factura-recibo (${inv!.payable}).`,
            [{ path: 'amount', code: 'AMOUNT_MISMATCH', message: `Total: ${inv!.payable}.` }]
          )
        currency = inv!.currency
        invoiceId = inv!.id
      }
      if (
        input.bankAccountId !== undefined &&
        input.bankAccountId !== null &&
        input.bankAccountId !== ''
      ) {
        const b = isUuid(input.bankAccountId)
          ? ((
              await scope.trx.rawQuery(
                `select legal_entity_id, status, currency from bank_accounts where tenant_id = ? and id = ?`,
                [t, input.bankAccountId]
              )
            ).rows[0] as any)
          : null
        if (!b || b.legal_entity_id !== le || b.status !== 'ACTIVE')
          fail([
            {
              path: 'bankAccountId',
              code: 'NOT_FOUND',
              message: 'Conta bancária activa inexistente nesta entidade.',
            },
          ])
        if (String(b.currency).trim() !== currency)
          fail([
            {
              path: 'bankAccountId',
              code: 'CURRENCY_MISMATCH',
              message: 'A conta é de outra moeda.',
            },
          ])
      } else if (input.method === 'TRANSFER')
        fail([
          {
            path: 'bankAccountId',
            code: 'REQUIRED',
            message: 'Indique a conta que recebeu a transferência.',
          },
        ])
      // Afectações: facturas emitidas do mesmo cliente, entidade e moeda; nunca acima do que falta receber.
      let sum = 0n
      for (const [i, x] of allocations.entries()) {
        const inv = await invoiceForPayment(scope, x.invoiceId)
        if (!inv || inv.legalEntityId !== le || inv.customerId !== c.id)
          issues.push({
            path: `allocations.${i}.invoiceId`,
            code: 'NOT_FOUND',
            message: 'Factura inexistente para este cliente e entidade.',
          })
        else if (!['ISSUED', 'CORRECTED'].includes(inv.status))
          issues.push({
            path: `allocations.${i}.invoiceId`,
            code: 'NOT_ISSUED',
            message: 'Só facturas emitidas.',
          })
        else if (inv.currency !== currency)
          issues.push({
            path: `allocations.${i}.invoiceId`,
            code: 'CURRENCY_MISMATCH',
            message: 'Factura noutra moeda.',
          })
        else if (x.amount > cents(inv.open))
          issues.push({
            path: `allocations.${i}.amount`,
            code: 'OVER_PAYMENT',
            message: `A factura ${inv.number} só tem ${inv.open} por receber.`,
          })
        sum += x.amount
      }
      if (sum > amount!)
        issues.push({
          path: 'allocations',
          code: 'OVER_ALLOCATED',
          message: 'As afectações passam o valor recebido.',
        })
      fail(issues)
      let ins: any
      try {
        ins = await scope.trx.rawQuery(
          `insert into sales_receipts (tenant_id, legal_entity_id, customer_id, purpose, invoice_id, currency, amount, method, bank_account_id,
             reference, received_date, request_key, request_hash, notes, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
          [
            t,
            le,
            c.id,
            purpose,
            invoiceId,
            currency,
            scaledText(amount!, 2),
            input.method,
            input.bankAccountId || null,
            reference,
            date,
            key,
            hash,
            notes,
            context.userId,
            context.userId,
          ] as never[]
        )
      } catch (e: any) {
        if (e?.code === '23505' && String(e.constraint ?? '').startsWith('sales_receipts_fr'))
          throw ApiError.conflict(
            'FR_PENDING',
            'Esta factura-recibo já tem um recebimento pendente ou confirmado.'
          )
        throw e
      }
      const id = (ins.rows[0] as any).id as string
      for (const x of allocations)
        await scope.trx.rawQuery(
          `insert into sales_receipt_allocations (tenant_id, receipt_id, invoice_id, amount, created_by, updated_by) values (?, ?, ?, ?, ?, ?)`,
          [t, id, x.invoiceId, scaledText(x.amount, 2), context.userId, context.userId] as never[]
        )
      await audit(scope, {
        action: 'sales_receipt.registered',
        entityType: 'sales_receipt',
        entityId: id,
        changes: { amount: { from: null, to: scaledText(amount!, 2) } },
        metadata: { purpose, allocated: scaledText(sum, 2), method: input.method },
      })
      return detail(scope, id)
    })
  }

  /**
   * Confirmação financeira (outra pessoa): aplica as afectações às facturas (nunca acima do que falta), numera o recibo
   * ou emite a factura-recibo, e o excedente fica como adiantamento. Tudo ou nada.
   */
  confirm(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'confirm', true)
      if (r.status !== 'PENDING')
        throw ApiError.conflict('INVALID_STATE', 'Só se confirma um recebimento pendente.')
      versionCheck(r, input.expectedVersion)
      if (r.created_by === context.userId)
        throw ApiError.forbidden('SELF_CONFIRMATION', 'Quem registou o recebimento não o confirma.')
      const amount = cents(r.amount)
      const fields: Record<string, unknown> = {
        status: 'CONFIRMED',
        confirmed_by: context.userId,
        confirmed_at: new Date(),
      }
      let documentRef: string
      if (r.purpose === 'INVOICE_RECEIPT') {
        const draft = await lockDraftInvoice(scope, r.invoice_id)
        if (draft.status !== 'DRAFT')
          throw ApiError.conflict('INVALID_STATE', 'A factura-recibo já não está em rascunho.')
        const issued = await issueDraft(scope, draft, input.seriesId)
        if (cents(issued.payable) !== amount)
          throw new ApiError(
            409,
            'AMOUNT_MISMATCH',
            `O total da factura-recibo à emissão é ${issued.payable}: registe o recebimento com esse valor.`
          )
        const paid = await applyInvoicePayment(scope, r.invoice_id, scaledText(amount, 2))
        documentRef = paid.number
        Object.assign(fields, { allocated_total: scaledText(amount, 2), advance_total: '0.00' })
      } else {
        const allocations = (
          await scope.trx.rawQuery(
            `select invoice_id, amount from sales_receipt_allocations where tenant_id = ? and receipt_id = ? order by invoice_id`,
            [context.tenantId, id]
          )
        ).rows as any[]
        let sum = 0n
        for (const x of allocations) {
          await applyInvoicePayment(scope, x.invoice_id, money(x.amount))
          sum += cents(x.amount)
        }
        const seriesId = await receiptSeries(
          scope,
          r.legal_entity_id,
          Number(String(r.rdate).slice(0, 4)),
          input.seriesId
        )
        const no = await allocateFiscalNumber(scope, {
          seriesId,
          legalEntityId: r.legal_entity_id,
          documentKind: 'RECEIPT',
          issueDate: r.rdate,
          documentType: 'SALES_RECEIPT',
          documentId: id,
        })
        documentRef = no.formatted
        Object.assign(fields, {
          series_id: no.seriesId,
          fiscal_number: no.number,
          number: no.formatted,
          allocated_total: scaledText(sum, 2),
          advance_total: scaledText(amount - sum, 2),
        })
      }
      await setReceipt(scope, id, fields)
      await audit(scope, {
        action: 'sales_receipt.confirmed',
        entityType: 'sales_receipt',
        entityId: id,
        changes: { status: { from: 'PENDING', to: 'CONFIRMED' } },
        metadata: { document: documentRef, advance: fields.advance_total ?? '0.00' },
      })
      return detail(scope, id)
    })
  }

  decide(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    action: 'reject' | 'cancel'
  ) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, action === 'reject' ? 'confirm' : 'manage', true)
      if (r.status !== 'PENDING')
        throw ApiError.conflict('INVALID_STATE', 'Só um recebimento pendente.')
      versionCheck(r, input.expectedVersion)
      const reason = reasonOf(input.reason)
      const to = action === 'reject' ? 'REJECTED' : 'CANCELLED'
      await setReceipt(scope, id, { status: to, decision_reason: reason })
      await audit(scope, {
        action: `sales_receipt.${action === 'reject' ? 'rejected' : 'cancelled'}`,
        entityType: 'sales_receipt',
        entityId: id,
        changes: { status: { from: 'PENDING', to } },
        metadata: { reason },
      })
      return detail(scope, id)
    })
  }

  /** Usar parte do adiantamento numa factura: nunca acima do saldo nem do que falta receber (bloqueios na transacção). */
  applyAdvance(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'manage', true)
      versionCheck(r, input.expectedVersion)
      if (r.status !== 'CONFIRMED')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se usa o adiantamento de um recebimento confirmado.'
        )
      const amount = parseScaled(input.amount, 2)
      if (amount === null || amount === 0n)
        fail([{ path: 'amount', code: 'INVALID', message: 'Valor maior que 0, 2 casas.' }])
      const remaining = cents(r.advance_total) - cents(r.advance_used)
      if (amount! > remaining)
        throw new ApiError(
          409,
          'OVER_ADVANCE',
          `O adiantamento só tem ${scaledText(remaining, 2)} disponível.`,
          [
            {
              path: 'amount',
              code: 'OVER_ADVANCE',
              message: `Disponível: ${scaledText(remaining, 2)}.`,
            },
          ]
        )
      const inv = await invoiceForPayment(scope, input.invoiceId as string)
      if (!inv || inv.legalEntityId !== r.legal_entity_id || inv.customerId !== r.customer_id)
        fail([
          {
            path: 'invoiceId',
            code: 'NOT_FOUND',
            message: 'Factura inexistente para este cliente e entidade.',
          },
        ])
      if (inv!.currency !== String(r.currency).trim())
        fail([{ path: 'invoiceId', code: 'CURRENCY_MISMATCH', message: 'Factura noutra moeda.' }])
      await applyInvoicePayment(scope, inv!.id, scaledText(amount!, 2))
      await scope.trx.rawQuery(
        `insert into sales_advance_applications (tenant_id, receipt_id, invoice_id, amount, created_by, updated_by) values (?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          id,
          inv!.id,
          scaledText(amount!, 2),
          context.userId,
          context.userId,
        ] as never[]
      )
      await setReceipt(scope, id, { advance_used: scaledText(cents(r.advance_used) + amount!, 2) })
      await audit(scope, {
        action: 'sales_receipt.advance_applied',
        entityType: 'sales_receipt',
        entityId: id,
        metadata: { invoice: inv!.number, amount: scaledText(amount!, 2) },
      })
      return detail(scope, id)
    })
  }
}

/** Acesso aos anexos do recebimento (comprovativo de transferência). */
export async function receiptAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const r = (
    await scope.trx.rawQuery(
      `select legal_entity_id from sales_receipts where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) return null
  const g = rights(await scopesOf(scope), r.legal_entity_id)
  return g.read ? { read: true, write: g.manage || g.confirm } : null
}
