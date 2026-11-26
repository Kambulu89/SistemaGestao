import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { rateOn } from '#modules/settings/index'
import { dbScaled, divRound, scaledText } from '#modules/sales/domain/pricing'
import {
  aging,
  agingBucket,
  daysOverdue,
  normalizeActivity,
  normalizePromise,
  promiseStatus,
} from '#modules/sales/domain/collections'

/*
 * Cobranças (10.10). Não há módulo Finanças (Prompt 11): as contas a receber são um CONTRATO de leitura calculado dos
 * documentos de venda (facturas emitidas, recibos e notas) — `customerReceivables` e `creditExposure` — que o módulo
 * Finanças passará a servir. Aqui regista-se só a actividade de cobrança (promessas e contactos). Permissões no âmbito
 * da entidade legal: `sales.collections.read` (consultar) e `.manage` (promessas e contactos).
 */

const today = () => new Date().toISOString().slice(0, 10)
const money = (v: unknown) => scaledText(dbScaled(v ?? '0', 2), 2)
const cents = (v: unknown) => dbScaled(v ?? '0', 2)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const OPEN = `(i.payable_total + i.debited_total - i.credited_total - i.paid_total)`

async function scopesOf(scope: TenantScope) {
  return {
    read: await permissionScope(scope, 'sales.collections.read'),
    manage: await permissionScope(scope, 'sales.collections.manage'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
/** Entidades visíveis (null = todas). */
function visible(g: { read: PermissionScope; manage: PermissionScope }) {
  if (g.read.tenant || g.manage.tenant) return null
  return new Set([...g.read.legalEntityIds, ...g.manage.legalEntityIds])
}
const leFilter = (col: string, les: Set<string> | null, params: unknown[]) => {
  if (!les) return ''
  if (!les.size) return ' and false'
  params.push(...les)
  return ` and ${col} in (${[...les].map(() => '?').join(', ')})`
}

/**
 * CONTRATO de contas a receber de um cliente (calculado dos documentos): facturas com valor em dívida (vencimento,
 * atraso, antiguidade), adiantamentos e crédito de notas por usar, e o resumo por entidade e moeda.
 */
export async function customerReceivables(
  scope: TenantScope,
  customerId: string,
  les: Set<string> | null = null,
  asOf = today()
) {
  const t = scope.context.tenantId
  const p1: unknown[] = [t, customerId]
  const invoices = (
    await scope.trx.rawQuery(
      `select i.id, i.number, i.legal_entity_id, i.currency, i.invoice_date::text as d, i.due_date::text as due,
              i.payable_total, i.debited_total, i.credited_total, i.paid_total, ${OPEN} as open, le.code as le_code
         from sales_invoices i join legal_entities le on le.tenant_id = i.tenant_id and le.id = i.legal_entity_id
        where i.tenant_id = ? and i.customer_id = ? and i.status in ('ISSUED','CORRECTED') and ${OPEN} > 0
              ${leFilter('i.legal_entity_id', les, p1)}
        order by i.due_date, i.number`,
      p1 as never[]
    )
  ).rows as any[]
  const p2: unknown[] = [t, customerId]
  const advances = (
    await scope.trx.rawQuery(
      `select r.id, r.number, r.legal_entity_id, r.currency, r.advance_total - r.advance_used as remaining
         from sales_receipts r where r.tenant_id = ? and r.customer_id = ? and r.status = 'CONFIRMED'
          and r.advance_total > r.advance_used ${leFilter('r.legal_entity_id', les, p2)} order by r.confirmed_at`,
      p2 as never[]
    )
  ).rows as any[]
  const p3: unknown[] = [t, customerId]
  const credits = (
    await scope.trx.rawQuery(
      `select n.id, n.number, n.legal_entity_id, n.currency,
              n.payable_total - n.applied_total - n.refunded_total
                - coalesce((select sum(f.amount) from sales_refunds f where f.tenant_id = n.tenant_id and f.note_id = n.id and f.status = 'PENDING'), 0) as available
         from sales_notes n where n.tenant_id = ? and n.customer_id = ? and n.kind = 'CREDIT' and n.status = 'ISSUED'
          and n.applied_total + n.refunded_total < n.payable_total ${leFilter('n.legal_entity_id', les, p3)}
        order by n.issued_at`,
      p3 as never[]
    )
  ).rows as any[]
  const key = (le: string, cur: string) => `${le}|${String(cur).trim()}`
  const groups = new Map<
    string,
    {
      legalEntityId: string
      currency: string
      items: { dueDate: string; open: bigint }[]
      advances: bigint
      credits: bigint
    }
  >()
  const group = (le: string, cur: string) => {
    const k = key(le, cur)
    if (!groups.has(k))
      groups.set(k, {
        legalEntityId: le,
        currency: String(cur).trim(),
        items: [],
        advances: 0n,
        credits: 0n,
      })
    return groups.get(k)!
  }
  for (const i of invoices)
    group(i.legal_entity_id, i.currency).items.push({ dueDate: i.due, open: cents(i.open) })
  for (const a of advances) group(a.legal_entity_id, a.currency).advances += cents(a.remaining)
  for (const c of credits)
    if (cents(c.available) > 0n) group(c.legal_entity_id, c.currency).credits += cents(c.available)
  const summary = [...groups.values()].map((g) => {
    const open = g.items.reduce((s, x) => s + x.open, 0n)
    const buckets = aging(g.items, asOf)
    const overdue = open - buckets.CURRENT
    return {
      legalEntityId: g.legalEntityId,
      currency: g.currency,
      open: scaledText(open, 2),
      overdue: scaledText(overdue, 2),
      aging: Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, scaledText(v, 2)])),
      advances: scaledText(g.advances, 2),
      credits: scaledText(g.credits, 2),
      net: scaledText(open - g.advances - g.credits, 2),
    }
  })
  return {
    asOf,
    summary,
    invoices: invoices.map((i) => ({
      id: i.id as string,
      number: i.number as string,
      legalEntity: { id: i.legal_entity_id as string, code: i.le_code as string },
      currency: String(i.currency).trim(),
      invoiceDate: i.d as string,
      dueDate: i.due as string,
      daysOverdue: daysOverdue(i.due, asOf),
      bucket: agingBucket(i.due, asOf),
      payable: money(i.payable_total),
      adjusted: scaledText(
        cents(i.payable_total) + cents(i.debited_total) - cents(i.credited_total),
        2
      ),
      paid: money(i.paid_total),
      open: money(i.open),
    })),
    advances: advances.map((a) => ({
      receiptId: a.id as string,
      number: a.number as string,
      legalEntityId: a.legal_entity_id as string,
      currency: String(a.currency).trim(),
      remaining: money(a.remaining),
    })),
    credits: credits
      .filter((c) => cents(c.available) > 0n)
      .map((c) => ({
        noteId: c.id as string,
        number: c.number as string,
        legalEntityId: c.legal_entity_id as string,
        currency: String(c.currency).trim(),
        available: money(c.available),
      })),
  }
}

/**
 * CONTRATO de exposição para o limite de crédito, na moeda do cliente: contas a receber líquidas (em dívida − adiantamentos
 * − crédito de notas) + encomendas confirmadas por facturar (sem `exceptOrderId`). Moedas sem câmbio à data ficam de fora
 * e são indicadas.
 */
export async function creditExposure(
  scope: TenantScope,
  customerId: string,
  date: string,
  exceptOrderId: string | null = null
) {
  const c = (
    await scope.trx.rawQuery(
      `select currency, credit_limit from customers where tenant_id = ? and id = ?`,
      [scope.context.tenantId, customerId]
    )
  ).rows[0] as any
  const cur = String(c.currency).trim()
  const missing: string[] = []
  const toCustomer = async (amount: bigint, from: string) => {
    if (from === cur || amount === 0n) return amount
    const r = await rateOn(scope, from, cur, date)
    if (!r) {
      missing.push(from)
      return 0n
    }
    return divRound(amount * dbScaled(r.rate, 10), 10n ** 10n)
  }
  const orders = (
    await scope.trx.rawQuery(
      `select so.currency, round(sum(l.gross_amount * (l.quantity - l.invoiced_qty - l.closed_qty) / l.quantity), 2)::text as open
         from sales_orders so join sales_order_lines l on l.tenant_id = so.tenant_id and l.order_id = so.id
        where so.tenant_id = ? and so.customer_id = ? and so.status = 'CONFIRMED' and so.id <> ?
        group by so.currency`,
      [scope.context.tenantId, customerId, exceptOrderId ?? '00000000-0000-0000-0000-000000000000']
    )
  ).rows as any[]
  let openOrders = 0n
  for (const r of orders) openOrders += await toCustomer(cents(r.open), String(r.currency).trim())
  const ar = await customerReceivables(scope, customerId, null, date)
  let receivables = 0n
  for (const s of ar.summary) receivables += await toCustomer(dbScaled(s.net, 2), s.currency)
  return {
    currency: cur,
    limit: c.credit_limit === null ? null : cents(c.credit_limit),
    openOrders,
    receivables,
    missingRates: [...new Set(missing)],
  }
}

/** Recebido depois da promessa: nas facturas indicadas, ou do cliente na entidade e moeda (cêntimos). */
async function paidSince(scope: TenantScope, p: any) {
  const t = scope.context.tenantId
  const ids = (p.invoice_ids as string[]) ?? []
  if (ids.length) {
    const r = (
      await scope.trx.rawQuery(
        `select coalesce((select sum(a.amount) from sales_receipt_allocations a join sales_receipts r on r.tenant_id = a.tenant_id and r.id = a.receipt_id
                           where a.tenant_id = ? and a.invoice_id = any(?::uuid[]) and r.status = 'CONFIRMED' and r.confirmed_at >= ?), 0)
              + coalesce((select sum(x.amount) from sales_advance_applications x
                           where x.tenant_id = ? and x.invoice_id = any(?::uuid[]) and x.created_at >= ?), 0) as paid`,
        [t, ids, p.created_at, t, ids, p.created_at] as never[]
      )
    ).rows[0] as any
    return cents(r.paid)
  }
  const r = (
    await scope.trx.rawQuery(
      `select coalesce(sum(amount), 0) as paid from sales_receipts where tenant_id = ? and customer_id = ? and legal_entity_id = ?
          and currency = ? and status = 'CONFIRMED' and confirmed_at >= ?`,
      [t, p.customer_id, p.legal_entity_id, p.currency, p.created_at] as never[]
    )
  ).rows[0] as any
  return cents(r.paid)
}

async function promiseView(scope: TenantScope, p: any, asOf: string) {
  const paid = await paidSince(scope, p)
  return {
    id: p.id as string,
    version: Number(p.version),
    legalEntityId: p.legal_entity_id as string,
    currency: String(p.currency).trim(),
    amount: money(p.amount),
    promisedDate: p.pdate as string,
    invoiceIds: (p.invoice_ids as string[]) ?? [],
    contactName: (p.contact_name as string) ?? null,
    notes: (p.notes as string) ?? null,
    paidSince: scaledText(paid > cents(p.amount) ? cents(p.amount) : paid, 2),
    status: promiseStatus({
      cancelled: !!p.cancelled,
      amount: cents(p.amount),
      paidSince: paid,
      promisedDate: p.pdate,
      today: asOf,
    }),
    cancelReason: (p.cancel_reason as string) ?? null,
    createdAt: new Date(p.created_at).toISOString(),
    createdBy: (p.full_name as string) ?? null,
  }
}

async function customerCheck(scope: TenantScope, customerId: string) {
  if (!isUuid(customerId)) throw ApiError.notFound()
  const c = (
    await scope.trx.rawQuery(
      `select c.*, p.code, p.name, p.id as partner_id from customers c join business_partners p on p.tenant_id = c.tenant_id and p.id = c.partner_id
        where c.tenant_id = ? and c.id = ?`,
      [scope.context.tenantId, customerId]
    )
  ).rows[0] as any
  if (!c) throw ApiError.notFound()
  return c
}

export class CollectionService {
  /** Lista de cobrança: por cliente, entidade e moeda, o em dívida, o vencido e a antiguidade, com o seguimento. */
  worklist(
    context: TenantContext,
    f: { q?: string; legalEntityId?: string; overdue?: boolean; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const g = await scopesOf(scope)
      const les = visible(g)
      if (les && !les.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar cobranças.')
      const asOf = today()
      const params: unknown[] = [asOf, asOf, asOf, asOf, asOf, asOf, context.tenantId]
      let where = leFilter('i.legal_entity_id', les, params)
      if (f.legalEntityId && isUuid(f.legalEntityId)) {
        where += ' and i.legal_entity_id = ?'
        params.push(f.legalEntityId)
      }
      if (f.q) {
        where += ' and (lower(bp.code) like ? or lower(bp.name) like ?)'
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`
        params.push(like, like)
      }
      const having = f.overdue ? `having sum(${OPEN}) filter (where i.due_date < ?::date) > 0` : ''
      if (f.overdue) params.push(asOf)
      const base = `from sales_invoices i join customers c on c.tenant_id = i.tenant_id and c.id = i.customer_id
          join business_partners bp on bp.tenant_id = c.tenant_id and bp.id = c.partner_id
          join legal_entities le on le.tenant_id = i.tenant_id and le.id = i.legal_entity_id
         where i.tenant_id = ? and i.status in ('ISSUED','CORRECTED') and ${OPEN} > 0 ${where}
         group by i.customer_id, i.legal_entity_id, i.currency, bp.code, bp.name, le.code, c.credit_limit, c.currency, c.status
         ${having}`
      const rows = (
        await scope.trx.rawQuery(
          `select i.customer_id, i.legal_entity_id, i.currency, bp.code, bp.name, le.code as le_code, c.credit_limit,
                  c.currency as cus_currency, c.status as cus_status,
                  sum(${OPEN}) as open,
                  coalesce(sum(${OPEN}) filter (where i.due_date < ?::date), 0) as overdue,
                  coalesce(sum(${OPEN}) filter (where ?::date - i.due_date between 1 and 30), 0) as d1_30,
                  coalesce(sum(${OPEN}) filter (where ?::date - i.due_date between 31 and 60), 0) as d31_60,
                  coalesce(sum(${OPEN}) filter (where ?::date - i.due_date between 61 and 90), 0) as d61_90,
                  coalesce(sum(${OPEN}) filter (where ?::date - i.due_date > 90), 0) as d90_plus,
                  min(i.due_date)::text as oldest, count(*)::int as invoices,
                  max(?::date - i.due_date)::int as max_days
             ${base} order by overdue desc, open desc, bp.code limit ? offset ?`,
          [...params, f.limit, f.offset] as never[]
        )
      ).rows as any[]
      const total = Number(
        (
          (
            await scope.trx.rawQuery(
              `select count(*)::int as n from (select 1 ${base}) x`,
              params.slice(6) as never[]
            )
          ).rows[0] as any
        ).n
      )
      const items = []
      for (const r of rows) {
        const last = (
          await scope.trx.rawQuery(
            `select created_at, kind, outcome, next_action_date::text as nad from collection_activities
              where tenant_id = ? and customer_id = ? and legal_entity_id = ? order by created_at desc limit 1`,
            [context.tenantId, r.customer_id, r.legal_entity_id]
          )
        ).rows[0] as any
        const promises = (
          await scope.trx.rawQuery(
            `select *, promised_date::text as pdate from collection_promises
              where tenant_id = ? and customer_id = ? and legal_entity_id = ? and currency = ? and not cancelled`,
            [context.tenantId, r.customer_id, r.legal_entity_id, r.currency]
          )
        ).rows as any[]
        const statuses = []
        for (const p of promises) statuses.push((await promiseView(scope, p, asOf)).status)
        items.push({
          customer: {
            id: r.customer_id as string,
            code: r.code as string,
            name: r.name as string,
            status: r.cus_status as string,
          },
          legalEntity: { id: r.legal_entity_id as string, code: r.le_code as string },
          currency: String(r.currency).trim(),
          open: money(r.open),
          overdue: money(r.overdue),
          aging: {
            CURRENT: scaledText(cents(r.open) - cents(r.overdue), 2),
            D1_30: money(r.d1_30),
            D31_60: money(r.d31_60),
            D61_90: money(r.d61_90),
            D90_PLUS: money(r.d90_plus),
          },
          oldestDueDate: r.oldest as string,
          maxDaysOverdue: Math.max(0, Number(r.max_days)),
          invoices: Number(r.invoices),
          creditLimit: r.credit_limit === null ? null : money(r.credit_limit),
          lastActivity: last
            ? {
                at: new Date(last.created_at).toISOString(),
                kind: last.kind as string,
                outcome: last.outcome as string,
              }
            : null,
          nextActionDate: (last?.nad as string) ?? null,
          openPromises: statuses.filter((s) => s === 'OPEN').length,
          brokenPromises: statuses.filter((s) => s === 'BROKEN').length,
        })
      }
      return { items, total }
    })
  }

  /** Extracto de cobrança de um cliente: contas a receber, limite e exposição, promessas, contactos. */
  statement(context: TenantContext, customerId: string) {
    return runInTenant(context, async (scope) => {
      const g = await scopesOf(scope)
      const les = visible(g)
      if (les && !les.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode consultar cobranças.')
      const c = await customerCheck(scope, customerId)
      const asOf = today()
      const ar = await customerReceivables(scope, customerId, les, asOf)
      const exposure = await creditExposure(scope, customerId, asOf)
      const t = context.tenantId
      const p1: unknown[] = [t, customerId]
      const promises = (
        await scope.trx.rawQuery(
          `select cp.*, cp.promised_date::text as pdate, u.full_name from collection_promises cp left join users u on u.id = cp.created_by
            where cp.tenant_id = ? and cp.customer_id = ? ${leFilter('cp.legal_entity_id', les, p1)} order by cp.created_at desc`,
          p1 as never[]
        )
      ).rows as any[]
      const p2: unknown[] = [t, customerId]
      const activities = (
        await scope.trx.rawQuery(
          `select a.*, a.next_action_date::text as nad, u.full_name from collection_activities a left join users u on u.id = a.created_by
            where a.tenant_id = ? and a.customer_id = ? ${leFilter('a.legal_entity_id', les, p2)} order by a.created_at desc limit 200`,
          p2 as never[]
        )
      ).rows as any[]
      const contacts = (
        await scope.trx.rawQuery(
          `select name, role, email, phone from business_partner_contacts where tenant_id = ? and partner_id = ? order by name`,
          [t, c.partner_id]
        )
      ).rows as any[]
      const entities = (
        (
          await scope.trx.rawQuery(
            `select id, code, status from legal_entities where tenant_id = ? order by code`,
            [t]
          )
        ).rows as any[]
      ).filter((l) => l.status === 'ACTIVE' && (!les || les.has(l.id)))
      const pv = []
      for (const p of promises) pv.push(await promiseView(scope, p, asOf))
      const limit = exposure.limit
      const used = exposure.receivables + exposure.openOrders
      return {
        customer: {
          id: c.id as string,
          code: c.code as string,
          name: c.name as string,
          status: c.status as string,
          currency: String(c.currency).trim(),
          paymentTermsDays: Number(c.payment_terms_days),
        },
        contacts: contacts.map((x) => ({
          name: x.name as string,
          role: (x.role as string) ?? null,
          email: (x.email as string) ?? null,
          phone: (x.phone as string) ?? null,
        })),
        credit: {
          currency: exposure.currency,
          limit: limit === null ? null : scaledText(limit, 2),
          receivables: scaledText(exposure.receivables, 2),
          openOrders: scaledText(exposure.openOrders, 2),
          exposure: scaledText(used, 2),
          available: limit === null ? null : scaledText(limit - used, 2),
          exceeded: limit !== null && used > limit,
          missingRates: exposure.missingRates,
        },
        receivables: ar,
        promises: pv,
        activities: activities.map((a) => ({
          id: a.id as string,
          legalEntityId: a.legal_entity_id as string,
          kind: a.kind as string,
          contactName: (a.contact_name as string) ?? null,
          outcome: a.outcome as string,
          notes: a.notes as string,
          nextActionDate: (a.nad as string) ?? null,
          promiseId: (a.promise_id as string) ?? null,
          at: new Date(a.created_at).toISOString(),
          by: (a.full_name as string) ?? null,
        })),
        legalEntities: entities.map((l) => ({
          id: l.id as string,
          code: l.code as string,
          canManage: covers(g.manage, l.id),
        })),
      }
    })
  }

  /** Registar uma promessa de pagamento (não é pagamento: não altera saldos). */
  createPromise(context: TenantContext, customerId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const asOf = today()
      const { v, issues } = normalizePromise(input, asOf)
      fail(issues)
      const c = await customerCheck(scope, customerId)
      if (!covers((await scopesOf(scope)).manage, v.legalEntityId))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere cobranças desta entidade.')
      const currency =
        typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency)
          ? input.currency
          : String(c.currency).trim()
      const ar = await customerReceivables(scope, customerId, new Set([v.legalEntityId]), asOf)
      const owed = ar.invoices.filter((i) => i.currency === currency)
      if (!owed.length)
        throw ApiError.conflict(
          'NOTHING_OWED',
          'O cliente não tem valores em dívida nesta entidade e moeda.'
        )
      let cap = owed.reduce((s, i) => s + cents(i.open), 0n)
      if (v.invoiceIds.length) {
        const bad = v.invoiceIds.filter((id) => !owed.some((i) => i.id === id))
        if (bad.length)
          fail([
            {
              path: 'invoiceIds',
              code: 'NOT_OPEN',
              message: 'Só facturas em dívida deste cliente, entidade e moeda.',
            },
          ])
        cap = owed
          .filter((i) => v.invoiceIds.includes(i.id))
          .reduce((s, i) => s + cents(i.open), 0n)
      }
      if (v.amount > cap)
        throw new ApiError(
          409,
          'OVER_PROMISE',
          `Só há ${scaledText(cap, 2)} em dívida para prometer.`,
          [{ path: 'amount', code: 'OVER_PROMISE', message: `Máximo ${scaledText(cap, 2)}.` }]
        )
      const ins = await scope.trx.rawQuery(
        `insert into collection_promises (tenant_id, legal_entity_id, customer_id, currency, amount, promised_date, invoice_ids,
           contact_name, notes, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?::uuid[], ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          v.legalEntityId,
          customerId,
          currency,
          scaledText(v.amount, 2),
          v.promisedDate,
          v.invoiceIds,
          v.contactName,
          v.notes,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as any).id as string
      await audit(scope, {
        action: 'collection.promise_created',
        entityType: 'customer',
        entityId: customerId,
        metadata: { promiseId: id, amount: scaledText(v.amount, 2), promisedDate: v.promisedDate },
      })
      const p = (
        await scope.trx.rawQuery(
          `select *, promised_date::text as pdate from collection_promises where tenant_id = ? and id = ?`,
          [context.tenantId, id]
        )
      ).rows[0]
      return promiseView(scope, p, asOf)
    })
  }

  cancelPromise(context: TenantContext, promiseId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(promiseId)) throw ApiError.notFound()
      const p = (
        await scope.trx.rawQuery(
          `select *, promised_date::text as pdate from collection_promises where tenant_id = ? and id = ? for update`,
          [context.tenantId, promiseId]
        )
      ).rows[0] as any
      if (!p) throw ApiError.notFound()
      const g = await scopesOf(scope)
      if (!covers(g.read, p.legal_entity_id) && !covers(g.manage, p.legal_entity_id))
        throw ApiError.notFound()
      if (!covers(g.manage, p.legal_entity_id))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere cobranças desta entidade.')
      if (Number(input.expectedVersion) !== Number(p.version))
        throw ApiError.versionConflict(Number(p.version))
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      if (reason.length < 3 || reason.length > 500)
        fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo (3 a 500).' }])
      const current = await promiseView(scope, p, today())
      if (current.status !== 'OPEN')
        throw ApiError.conflict('INVALID_STATE', 'Só se anula uma promessa em aberto.')
      await scope.trx.rawQuery(
        `update collection_promises set cancelled = true, cancel_reason = ?, version = version + 1, updated_at = now(), updated_by = ?
          where tenant_id = ? and id = ?`,
        [reason, context.userId, context.tenantId, promiseId]
      )
      await audit(scope, {
        action: 'collection.promise_cancelled',
        entityType: 'customer',
        entityId: p.customer_id,
        metadata: { promiseId, reason },
      })
      return promiseView(
        scope,
        { ...p, cancelled: true, cancel_reason: reason, version: Number(p.version) + 1 },
        today()
      )
    })
  }

  /** Registar um contacto de cobrança (só de acréscimo). */
  addActivity(context: TenantContext, customerId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { v, issues } = normalizeActivity(input, today())
      fail(issues)
      await customerCheck(scope, customerId)
      if (!covers((await scopesOf(scope)).manage, v.legalEntityId))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere cobranças desta entidade.')
      if (v.promiseId) {
        const p = (
          await scope.trx.rawQuery(
            `select customer_id, legal_entity_id from collection_promises where tenant_id = ? and id = ?`,
            [context.tenantId, v.promiseId]
          )
        ).rows[0] as any
        if (!p || p.customer_id !== customerId || p.legal_entity_id !== v.legalEntityId)
          fail([
            { path: 'promiseId', code: 'NOT_FOUND', message: 'Promessa deste cliente e entidade.' },
          ])
      }
      const ins = await scope.trx.rawQuery(
        `insert into collection_activities (tenant_id, legal_entity_id, customer_id, kind, contact_name, outcome, notes,
           next_action_date, promise_id, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          v.legalEntityId,
          customerId,
          v.kind,
          v.contactName,
          v.outcome,
          v.notes,
          v.nextActionDate,
          v.promiseId,
          context.userId,
          context.userId,
        ] as never[]
      )
      await audit(scope, {
        action: 'collection.activity_logged',
        entityType: 'customer',
        entityId: customerId,
        metadata: { activityId: (ins.rows[0] as any).id, kind: v.kind, outcome: v.outcome },
      })
      return { id: (ins.rows[0] as any).id as string }
    })
  }
}
