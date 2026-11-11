import { ApiError } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope } from '#modules/rbac/index'
import { postAccountingEvent } from '#modules/accounting/index'
import {
  ACCOUNTING_SOURCE,
  accountingEvent,
  costAdjustmentEvent,
  eventAmounts,
  NO_CLASS,
  reversalEvent,
  type Direction,
} from '#modules/inventory/domain/integrations'

/*
 * Contabilização do inventário (8.10). Cada lançamento de stock com valor (e cada ajuste de custo) gera, na mesma
 * transacção, um evento por entidade legal e sentido com os montantes por classe contabilística. O evento é enviado ao
 * motor de contabilização (origem `INVENTORY`) num savepoint: sem regra configurada, ou com um lançamento inválido, o
 * evento fica FALHADO com o motivo — a operação de stock não é bloqueada — e repete-se depois (`retry`). Tudo é
 * idempotente: a chave do evento nunca muda e o motor devolve o lançamento já feito.
 */

const cents = (v: unknown) => {
  const s = String(v ?? '0')
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2))
  return neg ? -n : n
}

async function allClasses(scope: TenantScope) {
  const r = await scope.trx.rawQuery(
    `select accounting_class as c from product_categories where tenant_id = ? and accounting_class is not null
     union select accounting_class from products where tenant_id = ? and accounting_class is not null`,
    [scope.context.tenantId, scope.context.tenantId]
  )
  return (r.rows as { c: string }[]).map((x) => x.c)
}

/** Valor por entidade, sentido e classe das entradas do livro de custo de um lançamento ou ajuste. */
async function grouped(scope: TenantScope, column: 'posting_id' | 'adjustment_id', id: string) {
  const r = await scope.trx.rawQuery(
    `select e.legal_entity_id,
            case when e.quantity > 0 or (e.quantity = 0 and e.value > 0) then 'IN' else 'OUT' end as dir,
            coalesce(p.accounting_class, cat.accounting_class, ?) as cls, sum(abs(e.value))::text as v
       from stock_valuation_entries e
       join products p on p.tenant_id = e.tenant_id and p.id = e.product_id
       left join product_categories cat on cat.tenant_id = p.tenant_id and cat.id = p.category_id
      where e.tenant_id = ? and e.${column} = ?
      group by 1, 2, 3`,
    [NO_CLASS, scope.context.tenantId, id] as never[]
  )
  const out = new Map<string, Map<string, bigint>>()
  for (const x of r.rows as any[]) {
    const k = `${x.legal_entity_id}|${x.dir}`
    const m = out.get(k) ?? new Map<string, bigint>()
    m.set(x.cls, (m.get(x.cls) ?? 0n) + cents(x.v))
    out.set(k, m)
  }
  return out
}

async function insertEvent(
  scope: TenantScope,
  e: {
    postingId: string | null
    adjustmentId: string | null
    legalEntityId: string
    direction: Direction
    event: string
    sourceRef: string
    occurredOn: string
    total: bigint
    amounts: Record<string, string>
    costCenterId: string | null
    key: string
  }
) {
  const r = await scope.trx.rawQuery(
    `insert into inventory_accounting_events (tenant_id, posting_id, adjustment_id, legal_entity_id, direction, event,
        source_ref, occurred_on, total, amounts, cost_center_id, idempotency_key, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)
     on conflict (tenant_id, idempotency_key) do nothing returning id`,
    [
      scope.context.tenantId,
      e.postingId,
      e.adjustmentId,
      e.legalEntityId,
      e.direction,
      e.event,
      e.sourceRef.slice(0, 120),
      e.occurredOn,
      `${e.total / 100n}.${(e.total % 100n).toString().padStart(2, '0')}`,
      JSON.stringify(e.amounts),
      e.costCenterId,
      e.key,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  return (r.rows[0] as { id: string } | undefined)?.id ?? null
}

/** Envia um evento ao motor num savepoint; falhar não desfaz a operação de stock. */
async function send(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  const r = await scope.trx.rawQuery(
    `select *, occurred_on::text as day from inventory_accounting_events where tenant_id = ? and id = ? for update`,
    [t, id]
  )
  const x = r.rows[0] as any
  if (!x || x.status === 'POSTED' || x.status === 'DRAFTED') return x?.status as string
  await scope.trx.rawQuery('savepoint inventory_accounting')
  try {
    const res = await postAccountingEvent(scope, {
      legalEntityId: x.legal_entity_id,
      source: ACCOUNTING_SOURCE,
      event: x.event,
      sourceRef: x.source_ref,
      occurredOn: x.day,
      amounts: x.amounts,
      costCenterId: x.cost_center_id,
      description: `Inventário ${x.event} ${x.source_ref}`,
      idempotencyKey: `inv:${x.idempotency_key}`,
    })
    await scope.trx.rawQuery('release savepoint inventory_accounting')
    const status = (res.event as any).status === 'POSTED' ? 'POSTED' : 'DRAFTED'
    await scope.trx.rawQuery(
      `update inventory_accounting_events set status = ?, posting_event_id = ?, error = null, attempts = attempts + 1,
          updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
      [status, (res.event as any).id, scope.context.userId, t, id] as never[]
    )
    return status
  } catch (error) {
    await scope.trx.rawQuery('rollback to savepoint inventory_accounting')
    const msg =
      error instanceof ApiError
        ? ((error.details?.[0] as any)?.message ?? error.message)
        : String((error as Error).message ?? error)
    await scope.trx.rawQuery(
      `update inventory_accounting_events set status = 'FAILED', error = ?, attempts = attempts + 1, updated_at = now(),
          updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
      [String(msg).slice(0, 500), scope.context.userId, t, id] as never[]
    )
    return 'FAILED'
  }
}

/** Depois da valorização de um lançamento de stock: cria e envia os eventos contabilísticos (um por entidade/sentido). */
export async function queuePostingAccounting(scope: TenantScope, postingId: string) {
  const t = scope.context.tenantId
  const p = (
    await scope.trx.rawQuery(
      `select s.*, s.occurred_at::date::text as day, d.origin as doc_origin, rq.cost_center_id as req_cc
         from stock_postings s
         left join stock_documents d on s.source_type = 'STOCK_DOCUMENT' and d.tenant_id = s.tenant_id and d.id = s.source_id
         left join stock_requisitions rq on s.source_type = 'INTERNAL_REQUISITION' and rq.tenant_id = s.tenant_id
           and rq.id = s.source_id
        where s.tenant_id = ? and s.id = ?`,
      [t, postingId]
    )
  ).rows[0] as any
  if (!p) return
  const groups = await grouped(scope, 'posting_id', postingId)
  if (!groups.size) return
  const classes = await allClasses(scope)
  let original: any = null
  if (p.reversal_of_id)
    original = (
      await scope.trx.rawQuery(
        `select s.posting_type, s.source_type, d.origin as doc_origin from stock_postings s
           left join stock_documents d on s.source_type = 'STOCK_DOCUMENT' and d.tenant_id = s.tenant_id and d.id = s.source_id
          where s.tenant_id = ? and s.id = ?`,
        [t, p.reversal_of_id]
      )
    ).rows[0]
  const ids: string[] = []
  for (const [k, byClass] of groups) {
    const [le, dir] = k.split('|') as [string, Direction]
    const { amounts, total } = eventAmounts(byClass, classes)
    if (total <= 0n) continue
    const event = original
      ? reversalEvent(
          accountingEvent({
            type: original.posting_type,
            sourceType: original.source_type,
            documentOrigin: original.doc_origin,
            direction: dir === 'IN' ? 'OUT' : 'IN',
          })
        )
      : accountingEvent({
          type: p.posting_type,
          sourceType: p.source_type,
          documentOrigin: p.doc_origin,
          direction: dir,
        })
    const id = await insertEvent(scope, {
      postingId,
      adjustmentId: null,
      legalEntityId: le,
      direction: dir,
      event,
      sourceRef: p.source_ref ?? `${p.source_type}:${postingId.slice(0, 8)}`,
      occurredOn: p.day,
      total,
      amounts,
      costCenterId: p.req_cc ?? null,
      key: `stock:${postingId}:${le}:${dir}`,
    })
    if (id) ids.push(id)
  }
  for (const id of ids) await send(scope, id)
}

/** Depois de um ajuste de custo: um evento (aumento ou redução do valor do stock). */
export async function queueAdjustmentAccounting(scope: TenantScope, adjustmentId: string) {
  const groups = await grouped(scope, 'adjustment_id', adjustmentId)
  const classes = await allClasses(scope)
  const a = (
    await scope.trx.rawQuery(
      `select reason, created_at::date::text as day from stock_cost_adjustments where tenant_id = ? and id = ?`,
      [scope.context.tenantId, adjustmentId]
    )
  ).rows[0] as any
  for (const [k, byClass] of groups) {
    const [le, dir] = k.split('|') as [string, Direction]
    const { amounts, total } = eventAmounts(byClass, classes)
    if (total <= 0n) continue
    const id = await insertEvent(scope, {
      postingId: null,
      adjustmentId,
      legalEntityId: le,
      direction: dir,
      event: costAdjustmentEvent(dir),
      sourceRef: `AJ:${adjustmentId.slice(0, 8)} ${a.reason}`,
      occurredOn: a.day,
      total,
      amounts,
      costCenterId: null,
      key: `cost:${adjustmentId}:${le}:${dir}`,
    })
    if (id) await send(scope, id)
  }
}

/** Entidades em que o membro tem a permissão ('ALL' no âmbito da empresa). */
async function entities(scope: TenantScope, perm: string) {
  const s = await permissionScope(scope, perm)
  return s.tenant ? ('ALL' as const) : [...s.legalEntityIds]
}

export class InventoryAccountingService {
  /** Eventos contabilísticos do inventário (quem consulta a valorização ou gere a contabilização da entidade). */
  list(
    context: TenantContext,
    f: { status?: string; legalEntityId?: string; event?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const read = await entities(scope, 'inventory.valuation.read')
      const manage = await entities(scope, 'inventory.accounting.manage')
      const les = read === 'ALL' || manage === 'ALL' ? 'ALL' : [...new Set([...read, ...manage])]
      if (les !== 'ALL' && !les.length) return { items: [], total: 0 }
      const where = ['a.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (les !== 'ALL') {
        where.push('a.legal_entity_id = any(?::uuid[])')
        params.push(les)
      }
      for (const [k, col] of [
        ['status', 'a.status'],
        ['legalEntityId', 'a.legal_entity_id'],
        ['event', 'a.event'],
      ] as const)
        if (f[k]) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      const cl = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `select a.*, a.occurred_on::text as day, le.code as le_code, le.functional_currency as currency,
            s.posting_type, s.source_type, s.source_id, pe.entry_id, je.number as entry_number
           from inventory_accounting_events a
           join legal_entities le on le.tenant_id = a.tenant_id and le.id = a.legal_entity_id
           left join stock_postings s on s.tenant_id = a.tenant_id and s.id = a.posting_id
           left join posting_events pe on pe.tenant_id = a.tenant_id and pe.id = a.posting_event_id
           left join journal_entries je on je.tenant_id = a.tenant_id and je.id = pe.entry_id
          where ${cl} order by a.created_at desc limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from inventory_accounting_events a where ${cl}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map((a) => ({
          id: a.id as string,
          legalEntity: { id: a.legal_entity_id as string, code: a.le_code as string },
          event: a.event as string,
          direction: a.direction as Direction,
          sourceRef: a.source_ref as string,
          source: a.posting_id
            ? { type: a.source_type as string, id: (a.source_id as string) ?? null }
            : { type: 'COST_ADJUSTMENT', id: a.adjustment_id as string },
          occurredOn: a.day as string,
          total: a.total as string,
          currency: (a.currency as string) ?? null,
          amounts: a.amounts as Record<string, string>,
          status: a.status as string,
          error: (a.error as string) ?? null,
          attempts: Number(a.attempts),
          entry: a.entry_id
            ? { id: a.entry_id as string, number: (a.entry_number as string) ?? null }
            : null,
          createdAt: a.created_at,
        })),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  /** Volta a enviar os eventos falhados (ou pendentes) — depois de configurar as regras na contabilidade. */
  retry(context: TenantContext, raw: any) {
    return runInTenant(context, async (scope) => {
      const manage = await entities(scope, 'inventory.accounting.manage')
      if (manage !== 'ALL' && !manage.length)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a contabilização do inventário.')
      const ids = Array.isArray(raw?.ids) ? raw.ids.filter((x: unknown) => isUuid(x)) : null
      const where = ['tenant_id = ?', "status in ('FAILED', 'PENDING')"]
      const params: unknown[] = [context.tenantId]
      if (manage !== 'ALL') {
        where.push('legal_entity_id = any(?::uuid[])')
        params.push(manage)
      }
      if (ids) {
        where.push('id = any(?::uuid[])')
        params.push(ids)
      }
      const r = await scope.trx.rawQuery(
        `select id from inventory_accounting_events where ${where.join(' and ')} order by created_at limit 200`,
        params as never[]
      )
      const result = { posted: 0, drafted: 0, failed: 0 }
      for (const x of r.rows as { id: string }[]) {
        const s = await send(scope, x.id)
        if (s === 'POSTED') result.posted++
        else if (s === 'DRAFTED') result.drafted++
        else result.failed++
      }
      await audit(scope, {
        action: 'inventory.accounting.retried',
        entityType: 'inventory_accounting',
        entityId: context.tenantId,
        metadata: { ...result, requested: r.rows.length },
      })
      return result
    })
  }
}
