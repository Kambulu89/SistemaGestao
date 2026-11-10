import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { scaledText } from '#modules/inventory/domain/catalog'
import { isExpired, type LotStatus } from '#modules/inventory/domain/lots'
import {
  readableWarehouseIds,
  warehouseAccessFor,
} from '#modules/inventory/application/warehouse_service'
import { postStock, type PostStockLineInput } from '#modules/inventory/application/stock_service'

/*
 * Lotes e séries (8.8): consulta e rastreabilidade (de onde veio, onde está, para onde foi), bloqueio/desbloqueio e
 * recolha. Bloquear (ou recolher) move o stock livre do lote para "bloqueado" com um lançamento de mudança de estado
 * — deixa de contar como disponível e não sai por FEFO —; desbloquear devolve o que esse bloqueio moveu. Uma recolha é
 * definitiva. Gerir lotes exige `inventory.lots.manage` no âmbito de todos os armazéns onde o lote tem stock.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const dec = (v: unknown) => {
  const s = String(v ?? '0')
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
  return neg ? -n : n
}
const txt = (v: bigint) => scaledText(v, 6)
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
const today = () => new Date().toISOString().slice(0, 10)
const anyScope = (s: PermissionScope) =>
  s.tenant || s.own || s.legalEntityIds.size > 0 || s.branchIds.size > 0 || s.departmentIds.size > 0

async function canRead(scope: TenantScope) {
  if (!anyScope(await permissionScope(scope, 'inventory.read'))) throw ApiError.notFound()
}

async function loadLot(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select lt.*, lt.expiry_date::text as expiry_text, lt.manufactured_date::text as made_text, p.sku,
        p.name as product_name, p.track_serials, v.sku as variant_sku, u.code as uom_code
       from stock_lots lt
       join products p on p.tenant_id = lt.tenant_id and p.id = lt.product_id
       join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
       left join product_variants v on v.tenant_id = lt.tenant_id and v.id = lt.variant_id
      where lt.tenant_id = ? and lt.id = ?${lock ? ' for update of lt' : ''}`,
    [scope.context.tenantId, id]
  )
  const x = r.rows[0] as any
  if (!x) throw ApiError.notFound()
  return x
}

/** Gerir o lote: `inventory.lots.manage` em todos os armazéns onde tem stock físico ou em trânsito. */
async function manageCheck(scope: TenantScope, lotId: string) {
  const s = await permissionScope(scope, 'inventory.lots.manage')
  if (!anyScope(s)) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere lotes.')
  const r = await scope.trx.rawQuery(
    `select distinct warehouse_id from stock_balances where tenant_id = ? and lot_id = ?
       and (qty_unrestricted + qty_blocked + qty_quarantine + qty_in_transit) <> 0`,
    [scope.context.tenantId, lotId]
  )
  for (const w of r.rows as any[]) {
    const a = await warehouseAccessFor(scope, w.warehouse_id)
    const ok =
      !!a &&
      (s.tenant ||
        s.legalEntityIds.has(a.legalEntityId) ||
        (!!a.branchId && s.branchIds.has(a.branchId)))
    if (!ok)
      throw ApiError.forbidden(
        'OUT_OF_SCOPE',
        'O lote tem stock em armazéns fora do seu âmbito: quem gere esses armazéns tem de o fazer.'
      )
  }
}

const versionCheck = (x: any, expected: number) => {
  if (Number(x.version) !== expected) throw ApiError.versionConflict(Number(x.version))
}

async function eventCount(scope: TenantScope, lotId: string) {
  const r = await scope.trx.rawQuery(
    'select count(*)::int as n from stock_lot_events where tenant_id = ? and lot_id = ?',
    [scope.context.tenantId, lotId]
  )
  return (r.rows[0] as { n: number }).n
}

/** Move o livre do lote (todos os armazéns) para bloqueado; devolve o lançamento, se houve stock. */
async function blockStock(scope: TenantScope, lot: any, reason: string) {
  const r = await scope.trx.rawQuery(
    `select warehouse_id, location_id, variant_id, qty_unrestricted from stock_balances
      where tenant_id = ? and lot_id = ? and qty_unrestricted > 0`,
    [scope.context.tenantId, lot.id]
  )
  const lines: PostStockLineInput[] = (r.rows as any[]).flatMap((b) => {
    const base = {
      warehouseId: b.warehouse_id as string,
      locationId: (b.location_id as string) ?? null,
      productId: lot.product_id as string,
      variantId: (b.variant_id as string) ?? null,
      lotId: lot.id as string,
    }
    const q = txt(dec(b.qty_unrestricted))
    return [
      { ...base, bucket: 'UNRESTRICTED' as const, quantity: `-${q}` },
      { ...base, bucket: 'BLOCKED' as const, quantity: q },
    ]
  })
  if (!lines.length) return null
  const posted = await postStock(scope, {
    type: 'STATUS_CHANGE',
    idempotencyKey: `lot-${lot.id}-${(await eventCount(scope, lot.id)) + 1}`,
    sourceType: 'STOCK_LOT',
    sourceId: lot.id,
    sourceRef: lot.code,
    reason,
    lines,
    // Autorizado aqui (âmbito de todos os armazéns do lote).
    checkAccess: false,
  })
  return posted.posting.id as string
}

async function addEvent(
  scope: TenantScope,
  lotId: string,
  kind: 'BLOCKED' | 'UNBLOCKED' | 'RECALLED',
  reason: string,
  postingId: string | null
) {
  await scope.trx.rawQuery(
    `insert into stock_lot_events (tenant_id, lot_id, kind, reason, posting_id, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      lotId,
      kind,
      reason,
      postingId,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function setLot(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update stock_lots set ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = now(), updated_by = ?,
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

const lotHead = (x: any) => ({
  id: x.id as string,
  version: Number(x.version),
  code: x.code as string,
  product: { id: x.product_id as string, sku: x.sku as string, name: x.product_name as string },
  variant: x.variant_id ? { id: x.variant_id as string, sku: x.variant_sku as string } : null,
  uom: x.uom_code as string,
  expiryDate: (x.expiry_text as string) ?? null,
  manufacturedDate: (x.made_text as string) ?? null,
  expired: isExpired({ expiryDate: x.expiry_text ?? null }, today()),
  status: x.status as LotStatus,
  blockReason: (x.block_reason as string) ?? null,
  recallReason: (x.recall_reason as string) ?? null,
  recalledAt: x.recalled_at ?? null,
  createdAt: x.created_at,
})

async function view(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  const x = await loadLot(scope, id)
  const ids = await readableWarehouseIds(scope)
  const bal = await scope.trx.rawQuery(
    `select b.*, w.code as wh_code, l.path_code from stock_balances b
       join warehouses w on w.tenant_id = b.tenant_id and w.id = b.warehouse_id
       left join warehouse_locations l on l.tenant_id = b.tenant_id and l.id = b.location_id
      where b.tenant_id = ? and b.lot_id = ? and b.warehouse_id = any(?::uuid[])
        and (b.qty_unrestricted + b.qty_blocked + b.qty_quarantine + b.qty_in_transit) <> 0
      order by w.code, l.path_code nulls first`,
    [t, id, ids] as never[]
  )
  const mov = await scope.trx.rawQuery(
    `select m.*, s.posting_type, s.source_type, s.source_id, s.source_ref, s.reason, w.code as wh_code,
        l.path_code, u.full_name as user_name
       from stock_movements m
       join stock_postings s on s.tenant_id = m.tenant_id and s.id = m.posting_id
       join warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
       left join warehouse_locations l on l.tenant_id = m.tenant_id and l.id = m.location_id
       left join users u on u.id = s.created_by
      where m.tenant_id = ? and m.lot_id = ? and m.warehouse_id = any(?::uuid[])
      order by m.occurred_at, m.posting_id, m.line_no limit 500`,
    [t, id, ids] as never[]
  )
  // Para onde foi: saídas definitivas (consumo, venda, perdas) por origem — a lista de uma recolha.
  const out = await scope.trx.rawQuery(
    `select s.source_type, s.source_id, s.source_ref, s.posting_type, w.code as wh_code,
        -sum(m.quantity) as qty, max(m.occurred_at) as last_at
       from stock_movements m
       join stock_postings s on s.tenant_id = m.tenant_id and s.id = m.posting_id
       join warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
      where m.tenant_id = ? and m.lot_id = ? and m.warehouse_id = any(?::uuid[])
        and s.posting_type in ('ISSUE', 'ADJUSTMENT', 'REVERSAL') and m.bucket in ('UNRESTRICTED','BLOCKED','QUARANTINE')
      group by s.source_type, s.source_id, s.source_ref, s.posting_type, w.code
      having sum(m.quantity) < 0 order by max(m.occurred_at)`,
    [t, id, ids] as never[]
  )
  const ser = await scope.trx.rawQuery(
    `select se.*, w.code as wh_code, l.path_code from stock_serials se
       left join warehouses w on w.tenant_id = se.tenant_id and w.id = se.warehouse_id
       left join warehouse_locations l on l.tenant_id = se.tenant_id and l.id = se.location_id
      where se.tenant_id = ? and se.lot_id = ? order by se.serial limit 500`,
    [t, id]
  )
  const ev = await scope.trx.rawQuery(
    `select e.*, u.full_name as user_name from stock_lot_events e left join users u on u.id = e.created_by
      where e.tenant_id = ? and e.lot_id = ? order by e.created_at`,
    [t, id]
  )
  const manage = anyScope(await permissionScope(scope, 'inventory.lots.manage'))
  return {
    ...lotHead(x),
    can: { manage },
    balances: (bal.rows as any[]).map((b) => ({
      warehouse: { id: b.warehouse_id as string, code: b.wh_code as string },
      location: b.location_id
        ? { id: b.location_id as string, pathCode: b.path_code as string }
        : null,
      unrestricted: txt(dec(b.qty_unrestricted)),
      blocked: txt(dec(b.qty_blocked)),
      quarantine: txt(dec(b.qty_quarantine)),
      inTransit: txt(dec(b.qty_in_transit)),
    })),
    movements: (mov.rows as any[]).map((m) => ({
      postingId: m.posting_id as string,
      type: m.posting_type as string,
      source: {
        type: m.source_type as string,
        id: (m.source_id as string) ?? null,
        ref: (m.source_ref as string) ?? null,
      },
      warehouse: { id: m.warehouse_id as string, code: m.wh_code as string },
      location: m.location_id
        ? { id: m.location_id as string, pathCode: m.path_code as string }
        : null,
      bucket: m.bucket as string,
      quantity: txt(dec(m.quantity)),
      occurredAt: m.occurred_at,
      reason: (m.reason as string) ?? null,
      user: (m.user_name as string) ?? null,
    })),
    destinations: (out.rows as any[]).map((d) => ({
      source: {
        type: d.source_type as string,
        id: (d.source_id as string) ?? null,
        ref: (d.source_ref as string) ?? null,
      },
      postingType: d.posting_type as string,
      warehouse: d.wh_code as string,
      quantity: txt(dec(d.qty)),
      lastAt: d.last_at,
    })),
    serials: (ser.rows as any[]).map((s) => ({
      id: s.id as string,
      serial: s.serial as string,
      status: s.status as string,
      warehouse: s.warehouse_id ? (s.wh_code as string) : null,
      location: (s.path_code as string) ?? null,
      bucket: (s.bucket as string) ?? null,
    })),
    events: (ev.rows as any[]).map((e) => ({
      kind: e.kind as string,
      reason: e.reason as string,
      postingId: (e.posting_id as string) ?? null,
      at: e.created_at,
      by: (e.user_name as string) ?? null,
    })),
  }
}

export class LotService {
  list(
    context: TenantContext,
    f: {
      productId?: string
      status?: string
      q?: string
      expiringWithinDays?: number
      withStock?: boolean
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      await canRead(scope)
      const ids = await readableWarehouseIds(scope)
      const where = ['lt.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (f.productId) {
        where.push('lt.product_id = ?')
        params.push(f.productId)
      }
      if (f.status) {
        where.push('lt.status = ?')
        params.push(f.status)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push('(lower(lt.code) like ? or lower(p.sku) like ? or lower(p.name) like ?)')
        params.push(like, like, like)
      }
      if (f.expiringWithinDays !== undefined) {
        where.push(`lt.expiry_date <= (current_date + ?::int)`)
        params.push(f.expiringWithinDays)
      }
      const stock = `(select coalesce(sum(b.qty_unrestricted + b.qty_blocked + b.qty_quarantine + b.qty_in_transit), 0)
          from stock_balances b where b.tenant_id = lt.tenant_id and b.lot_id = lt.id and b.warehouse_id = any(?::uuid[]))`
      if (f.withStock) {
        where.push(`${stock} > 0`)
        params.push(ids)
      }
      const cl = where.join(' and ')
      const from = `from stock_lots lt join products p on p.tenant_id = lt.tenant_id and p.id = lt.product_id
        join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
        left join product_variants v on v.tenant_id = lt.tenant_id and v.id = lt.variant_id`
      const rows = await scope.trx.rawQuery(
        `select lt.*, lt.expiry_date::text as expiry_text, lt.manufactured_date::text as made_text, p.sku,
            p.name as product_name, v.sku as variant_sku, u.code as uom_code, ${stock} as stock
           ${from} where ${cl} order by lt.expiry_date nulls last, p.sku, lt.code limit ? offset ?`,
        [ids, ...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n ${from} where ${cl}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map((x) => ({ ...lotHead(x), stock: txt(dec(x.stock)) })),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      await canRead(scope)
      return view(scope, id)
    })
  }

  /** Bloqueio (motivo): o livre do lote passa a bloqueado; deixa de sair e de contar como disponível. */
  block(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      await canRead(scope)
      const lot = await loadLot(scope, id, true)
      await manageCheck(scope, id)
      versionCheck(lot, expectedVersion)
      if (lot.status !== 'ACTIVE')
        throw ApiError.conflict('INVALID_STATE', 'Só um lote activo se bloqueia.')
      const postingId = await blockStock(scope, lot, `Bloqueio do lote ${lot.code}: ${reason}`)
      await setLot(scope, id, { status: 'BLOCKED', block_reason: reason })
      await addEvent(scope, id, 'BLOCKED', reason!, postingId)
      await audit(scope, {
        action: 'inventory.lot.blocked',
        entityType: 'stock_lot',
        entityId: id,
        metadata: { code: lot.code, reason, postingId },
      })
      return view(scope, id)
    })
  }

  /** Desbloqueio: devolve ao livre o que o último bloqueio moveu (e ainda está bloqueado). */
  unblock(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      await canRead(scope)
      const t = context.tenantId
      const lot = await loadLot(scope, id, true)
      await manageCheck(scope, id)
      versionCheck(lot, expectedVersion)
      if (lot.status !== 'BLOCKED')
        throw ApiError.conflict('INVALID_STATE', 'Só um lote bloqueado se desbloqueia.')
      const last = await scope.trx.rawQuery(
        `select posting_id from stock_lot_events where tenant_id = ? and lot_id = ? and kind = 'BLOCKED'
          order by created_at desc limit 1`,
        [t, id]
      )
      const pid = (last.rows[0] as any)?.posting_id as string | null
      let postingId: string | null = null
      if (pid) {
        const moved = await scope.trx.rawQuery(
          `select m.warehouse_id, m.location_id, m.variant_id, m.quantity, b.qty_blocked
             from stock_movements m
             join stock_balances b on b.tenant_id = m.tenant_id and b.warehouse_id = m.warehouse_id
              and b.location_id is not distinct from m.location_id and b.product_id = m.product_id
              and b.variant_id is not distinct from m.variant_id and b.lot_id = m.lot_id
            where m.tenant_id = ? and m.posting_id = ? and m.bucket = 'BLOCKED' and m.quantity > 0`,
          [t, pid]
        )
        const lines: PostStockLineInput[] = (moved.rows as any[]).flatMap((m) => {
          const q = dec(m.quantity) < dec(m.qty_blocked) ? dec(m.quantity) : dec(m.qty_blocked)
          if (q <= 0n) return []
          const base = {
            warehouseId: m.warehouse_id as string,
            locationId: (m.location_id as string) ?? null,
            productId: lot.product_id as string,
            variantId: (m.variant_id as string) ?? null,
            lotId: id,
          }
          return [
            { ...base, bucket: 'BLOCKED' as const, quantity: `-${txt(q)}` },
            { ...base, bucket: 'UNRESTRICTED' as const, quantity: txt(q) },
          ]
        })
        if (lines.length) {
          // O estado do lote muda antes do lançamento: um lote bloqueado não recebe no livre.
          await setLot(scope, id, { status: 'ACTIVE', block_reason: null })
          const posted = await postStock(scope, {
            type: 'STATUS_CHANGE',
            idempotencyKey: `lot-${id}-${(await eventCount(scope, id)) + 1}`,
            sourceType: 'STOCK_LOT',
            sourceId: id,
            sourceRef: lot.code,
            reason: `Desbloqueio do lote ${lot.code}: ${reason}`,
            lines,
            checkAccess: false,
          })
          postingId = posted.posting.id
        }
      }
      if (!postingId) await setLot(scope, id, { status: 'ACTIVE', block_reason: null })
      await addEvent(scope, id, 'UNBLOCKED', reason!, postingId)
      await audit(scope, {
        action: 'inventory.lot.unblocked',
        entityType: 'stock_lot',
        entityId: id,
        metadata: { code: lot.code, reason, postingId },
      })
      return view(scope, id)
    })
  }

  /** Recolha (definitiva): bloqueia o stock que ainda está livre e fica a lista de para onde o lote foi. */
  recall(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason)
        fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo da recolha.' }])
      await canRead(scope)
      const lot = await loadLot(scope, id, true)
      await manageCheck(scope, id)
      versionCheck(lot, expectedVersion)
      if (lot.status === 'RECALLED')
        throw ApiError.conflict('INVALID_STATE', 'O lote já está recolhido.')
      const postingId =
        lot.status === 'ACTIVE'
          ? await blockStock(scope, lot, `Recolha do lote ${lot.code}: ${reason}`)
          : null
      await setLot(scope, id, {
        status: 'RECALLED',
        block_reason: null,
        recall_reason: reason,
        recalled_at: new Date(),
        recalled_by: context.userId,
      })
      await addEvent(scope, id, 'RECALLED', reason!, postingId)
      await audit(scope, {
        action: 'inventory.lot.recalled',
        entityType: 'stock_lot',
        entityId: id,
        metadata: { code: lot.code, reason, postingId },
      })
      return view(scope, id)
    })
  }

  /** Séries: pesquisa pelo número (e produto), com onde está agora. */
  serials(
    context: TenantContext,
    f: { q?: string; productId?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      await canRead(scope)
      const where = ['se.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (f.productId) {
        where.push('se.product_id = ?')
        params.push(f.productId)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push('(lower(se.serial) like ? or lower(p.sku) like ?)')
        params.push(like, like)
      }
      const cl = where.join(' and ')
      const from = `from stock_serials se join products p on p.tenant_id = se.tenant_id and p.id = se.product_id
        left join stock_lots lt on lt.tenant_id = se.tenant_id and lt.id = se.lot_id
        left join warehouses w on w.tenant_id = se.tenant_id and w.id = se.warehouse_id
        left join warehouse_locations l on l.tenant_id = se.tenant_id and l.id = se.location_id`
      const rows = await scope.trx.rawQuery(
        `select se.*, p.sku, p.name as product_name, lt.code as lot_code, w.code as wh_code, l.path_code
           ${from} where ${cl} order by se.serial limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n ${from} where ${cl}`,
        params as never[]
      )
      const readable = new Set(await readableWarehouseIds(scope))
      return {
        items: (rows.rows as any[]).map((s) => serialView(s, readable)),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  /** Série: histórico completo (só os movimentos dos armazéns que o membro consulta). */
  serial(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      await canRead(scope)
      if (!isUuid(id)) throw ApiError.notFound()
      const t = context.tenantId
      const r = await scope.trx.rawQuery(
        `select se.*, p.sku, p.name as product_name, lt.code as lot_code, w.code as wh_code, l.path_code
           from stock_serials se join products p on p.tenant_id = se.tenant_id and p.id = se.product_id
           left join stock_lots lt on lt.tenant_id = se.tenant_id and lt.id = se.lot_id
           left join warehouses w on w.tenant_id = se.tenant_id and w.id = se.warehouse_id
           left join warehouse_locations l on l.tenant_id = se.tenant_id and l.id = se.location_id
          where se.tenant_id = ? and se.id = ?`,
        [t, id]
      )
      const s = r.rows[0] as any
      if (!s) throw ApiError.notFound()
      const readable = new Set(await readableWarehouseIds(scope))
      const h = await scope.trx.rawQuery(
        `select sm.*, s.posting_type, s.source_type, s.source_id, s.source_ref, w.code as wh_code, l.path_code,
            lt.code as lot_code
           from stock_serial_movements sm
           join stock_postings s on s.tenant_id = sm.tenant_id and s.id = sm.posting_id
           join warehouses w on w.tenant_id = sm.tenant_id and w.id = sm.warehouse_id
           left join warehouse_locations l on l.tenant_id = sm.tenant_id and l.id = sm.location_id
           left join stock_lots lt on lt.tenant_id = sm.tenant_id and lt.id = sm.lot_id
          where sm.tenant_id = ? and sm.serial_id = ? order by sm.created_at, sm.delta`,
        [t, id]
      )
      return {
        ...serialView(s, readable),
        history: (h.rows as any[])
          .filter((m) => readable.has(m.warehouse_id))
          .map((m) => ({
            postingId: m.posting_id as string,
            type: m.posting_type as string,
            source: {
              type: m.source_type as string,
              id: (m.source_id as string) ?? null,
              ref: (m.source_ref as string) ?? null,
            },
            direction: Number(m.delta) > 0 ? 'IN' : 'OUT',
            warehouse: m.wh_code as string,
            location: (m.path_code as string) ?? null,
            lot: (m.lot_code as string) ?? null,
            bucket: m.bucket as string,
            at: m.created_at,
          })),
      }
    })
  }
}

const serialView = (s: any, readable: Set<string>) => {
  const visible = !s.warehouse_id || readable.has(s.warehouse_id)
  return {
    id: s.id as string,
    serial: s.serial as string,
    product: { id: s.product_id as string, sku: s.sku as string, name: s.product_name as string },
    lot: s.lot_id ? { id: s.lot_id as string, code: s.lot_code as string } : null,
    status: s.status as string,
    // Onde está: só para quem consulta esse armazém.
    warehouse: s.warehouse_id && visible ? (s.wh_code as string) : null,
    location: s.location_id && visible ? (s.path_code as string) : null,
    bucket: visible ? ((s.bucket as string) ?? null) : null,
  }
}
