import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import { fitsDecimals, scaled, scaledText } from '#modules/inventory/domain/catalog'
import {
  approvalIssues,
  COUNT_CAN,
  COUNT_REASONS,
  COUNT_SERIES_TYPE,
  countDifference,
  MAX_COUNT_LINES,
  seesBook,
  splitAdjustment,
  type CountStatus,
} from '#modules/inventory/domain/counts'
import {
  readableWarehouseIds,
  warehouseAccessFor,
} from '#modules/inventory/application/warehouse_service'
import { postStock, type PostStockLineInput } from '#modules/inventory/application/stock_service'

/*
 * Contagens físicas e ajustes (8.7). Planear, iniciar (snapshot), contar, submeter, justificar e pedir recontagem
 * (`inventory.counts.manage`: no âmbito do armazém, com acesso de operação) e aprovar o ajuste
 * (`inventory.counts.approve`: no âmbito do armazém; quem contou não aprova). Numa contagem cega, quem só conta não vê
 * a quantidade do sistema. O ajuste entra no stock só por `postStock` (tipo ADJUSTMENT), na aprovação.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const SCALE = 6
const dec = (v: unknown) => {
  const s = String(v ?? '0')
  const neg = s.startsWith('-')
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.')
  const n = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
  return neg ? -n : n
}
const txt = (v: bigint) => scaledText(v, SCALE)
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
const DATE = /^\d{4}-\d{2}-\d{2}$/
const today = () => new Date().toISOString().slice(0, 10)
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
/** Lançamentos de ajuste com no máximo 500 linhas cada (limite do motor de stock). */
const POSTING_CHUNK = 500

const covers = (s: PermissionScope, a: { legalEntityId: string; branchId: string | null }) =>
  s.tenant || s.legalEntityIds.has(a.legalEntityId) || (!!a.branchId && s.branchIds.has(a.branchId))

/** Direitos no armazém: gerir (com acesso de operação) e aprovar (com acesso de consulta). */
async function warehouseRights(scope: TenantScope, warehouseId: string) {
  const a = await warehouseAccessFor(scope, warehouseId)
  if (!a || !a.read) return { manage: false, approve: false, read: false }
  const manage = a.operate && covers(await permissionScope(scope, 'inventory.counts.manage'), a)
  const approve = covers(await permissionScope(scope, 'inventory.counts.approve'), a)
  return { manage, approve, read: manage || approve }
}

async function counted(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    'select 1 from stock_count_entries where tenant_id = ? and count_id = ? and created_by = ? limit 1',
    [scope.context.tenantId, id, scope.context.userId]
  )
  return r.rows.length > 0
}

async function loadCount(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select * from stock_counts where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  const x = r.rows[0] as any
  if (!x) throw ApiError.notFound()
  return x
}

async function authorized(
  scope: TenantScope,
  id: string,
  need: 'read' | 'manage' | 'approve',
  lock = false
) {
  const c = await loadCount(scope, id, lock)
  const g = await warehouseRights(scope, c.warehouse_id)
  if (!g.read) throw ApiError.notFound()
  if (need !== 'read' && !g[need])
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      need === 'manage'
        ? 'Não gere contagens deste armazém.'
        : 'Não aprova contagens deste armazém.'
    )
  return { c, g }
}

const versionCheck = (c: any, expected: number) => {
  if (Number(c.version) !== expected) throw ApiError.versionConflict(Number(c.version))
}
const stateCheck = (c: any, action: keyof typeof COUNT_CAN) => {
  if (!COUNT_CAN[action].includes(c.status))
    throw ApiError.conflict('INVALID_STATE', `Não é possível nesta fase (${c.status}).`)
}

async function touch(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update stock_counts set ${keys.map((k) => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}
       updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function lineRows(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    `select * from stock_count_lines where tenant_id = ? and count_id = ? order by line_no for update`,
    [scope.context.tenantId, id]
  )
  return r.rows as any[]
}

/** Físico actual de cada saldo (localização/produto/variante) do armazém indicado. */
async function physicalNow(
  scope: TenantScope,
  warehouseId: string,
  keys: {
    location_id: string | null
    product_id: string
    variant_id: string | null
    lot_id?: string | null
  }[]
) {
  const out = new Map<string, { unrestricted: bigint; blocked: bigint; quarantine: bigint }>()
  if (!keys.length) return out
  const pids = [...new Set(keys.map((k) => k.product_id))]
  const r = await scope.trx.rawQuery(
    `select location_id, product_id, variant_id, lot_id, qty_unrestricted, qty_blocked, qty_quarantine from stock_balances
      where tenant_id = ? and warehouse_id = ? and product_id = any(?::uuid[])`,
    [scope.context.tenantId, warehouseId, pids] as never[]
  )
  for (const b of r.rows as any[])
    out.set(keyOf(b), {
      unrestricted: dec(b.qty_unrestricted),
      blocked: dec(b.qty_blocked),
      quarantine: dec(b.qty_quarantine),
    })
  return out
}
/** Saldo contado: localização, produto, variante e lote (8.8). */
const keyOf = (l: {
  location_id: string | null
  product_id: string
  variant_id: string | null
  lot_id?: string | null
}) => `${l.location_id ?? ''}|${l.product_id}|${l.variant_id ?? ''}|${l.lot_id ?? ''}`
const physical = (q?: { unrestricted: bigint; blocked: bigint; quarantine: bigint }) =>
  q ? q.unrestricted + q.blocked + q.quarantine : 0n

/** Locais do plano: a zona escolhida e tudo o que está abaixo dela. */
const SUBTREE = `with recursive sub as (
    select id from warehouse_locations where tenant_id = ? and id = ?
    union all select l.id from warehouse_locations l join sub on l.parent_id = sub.id where l.tenant_id = ?)
  select id from sub`
const CATEGORY_TREE = `with recursive sub as (
    select id from product_categories where tenant_id = ? and id = ?
    union all select c.id from product_categories c join sub on c.parent_id = sub.id where c.tenant_id = ?)
  select id from sub`

/** Armazéns onde o membro pode planear contagens (activos, com acesso de operação e permissão no âmbito). */
async function manageableWarehouses(scope: TenantScope) {
  const ids = await readableWarehouseIds(scope)
  const out: string[] = []
  for (const id of ids) if ((await warehouseRights(scope, id)).manage) out.push(id)
  if (!out.length) return []
  const r = await scope.trx.rawQuery(
    `select id, code, name, legal_entity_id from warehouses
      where tenant_id = ? and status = 'ACTIVE' and id = any(?::uuid[]) order by code`,
    [scope.context.tenantId, out] as never[]
  )
  return (r.rows as any[]).map((w) => ({
    id: w.id as string,
    code: w.code as string,
    name: w.name as string,
    legalEntityId: w.legal_entity_id as string,
  }))
}

/** Plano: armazém (só na criação), zona e categoria opcionais, contagem cega, data prevista e descrição. */
async function plan(scope: TenantScope, raw: any, current: any | null) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  const warehouseId = current?.warehouse_id ?? raw?.warehouseId
  const wh = isUuid(warehouseId)
    ? (await manageableWarehouses(scope)).find((w) => w.id === warehouseId)
    : null
  if (!current && !wh)
    issues.push({
      path: 'warehouseId',
      code: 'NOT_FOUND',
      message: 'Armazém activo onde gere contagens.',
    })
  let locationId: string | null = null
  if (raw?.locationId) {
    const l = isUuid(raw.locationId)
      ? ((
          await scope.trx.rawQuery(
            'select id from warehouse_locations where tenant_id = ? and warehouse_id = ? and id = ?',
            [t, warehouseId ?? ZERO_UUID, raw.locationId]
          )
        ).rows[0] as any)
      : null
    if (!l)
      issues.push({
        path: 'locationId',
        code: 'NOT_FOUND',
        message: 'A zona não é deste armazém.',
      })
    else locationId = l.id
  }
  let categoryId: string | null = null
  if (raw?.categoryId) {
    const c = isUuid(raw.categoryId)
      ? ((
          await scope.trx.rawQuery(
            'select id from product_categories where tenant_id = ? and id = ?',
            [t, raw.categoryId]
          )
        ).rows[0] as any)
      : null
    if (!c)
      issues.push({ path: 'categoryId', code: 'NOT_FOUND', message: 'Categoria não encontrada.' })
    else categoryId = c.id
  }
  const description = text(raw?.description, 200)
  if (!description)
    issues.push({ path: 'description', code: 'REQUIRED', message: 'Descreva a contagem.' })
  const plannedDate = raw?.plannedDate || null
  if (plannedDate && (!DATE.test(plannedDate) || Number.isNaN(Date.parse(plannedDate))))
    issues.push({ path: 'plannedDate', code: 'INVALID', message: 'Data inválida.' })
  fail(issues)
  return {
    warehouseId: warehouseId as string,
    legalEntityId: (current?.legal_entity_id ?? wh?.legalEntityId) as string,
    locationId,
    categoryId,
    blind: raw?.blind === undefined ? true : raw.blind === true,
    plannedDate,
    description: description!,
    notes: text(raw?.notes, 500),
  }
}

/** Outra contagem em curso no mesmo armazém que já conta algum destes saldos. */
async function overlapCheck(scope: TenantScope, c: any) {
  const r = await scope.trx.rawQuery(
    `select o.number from stock_count_lines a
       join stock_count_lines b on b.tenant_id = a.tenant_id and b.count_id <> a.count_id and b.product_id = a.product_id
        and b.location_id is not distinct from a.location_id and b.variant_id is not distinct from a.variant_id
        and b.lot_id is not distinct from a.lot_id
       join stock_counts o on o.tenant_id = b.tenant_id and o.id = b.count_id
      where a.tenant_id = ? and a.count_id = ? and o.warehouse_id = ? and o.status in ('COUNTING', 'REVIEW')
      limit 1`,
    [scope.context.tenantId, c.id, c.warehouse_id]
  )
  const o = r.rows[0] as { number: string } | undefined
  if (o)
    throw ApiError.conflict(
      'COUNT_OVERLAP',
      `A contagem ${o.number} em curso já conta saldos deste plano: termine-a ou restrinja o plano.`
    )
}
const warehouseLock = (scope: TenantScope, warehouseId: string) =>
  scope.trx.rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `count:${scope.context.tenantId}:${warehouseId}`,
  ])

async function view(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  const h = await scope.trx.rawQuery(
    `select c.*, c.planned_date::text as planned_text, w.code as wh_code, w.name as wh_name, le.code as le_code,
        loc.path_code as zone_path, cat.code as cat_code, cat.name as cat_name,
        su.full_name as starter_name, bu.full_name as submitter_name, au.full_name as approver_name
       from stock_counts c
       join warehouses w on w.tenant_id = c.tenant_id and w.id = c.warehouse_id
       join legal_entities le on le.tenant_id = c.tenant_id and le.id = c.legal_entity_id
       left join warehouse_locations loc on loc.tenant_id = c.tenant_id and loc.id = c.location_id
       left join product_categories cat on cat.tenant_id = c.tenant_id and cat.id = c.category_id
       left join users su on su.id = c.started_by
       left join users bu on bu.id = c.submitted_by
       left join users au on au.id = c.approved_by
      where c.tenant_id = ? and c.id = ?`,
    [t, id]
  )
  const x = h.rows[0] as any
  if (!x) throw ApiError.notFound()
  const g = await warehouseRights(scope, x.warehouse_id)
  const iCounted = await counted(scope, id)
  const book = seesBook({ blind: x.blind, status: x.status }, g.approve)
  const ls = await scope.trx.rawQuery(
    `select l.*, p.sku, p.name as product_name, v.sku as variant_sku, u.code as uom_code, u.decimals,
        loc.path_code, lt.code as lot_code, lt.expiry_date::text as lot_expiry, p.track_lots, p.track_serials,
        (select count(*)::int from stock_count_entries e where e.tenant_id = l.tenant_id and e.line_id = l.id) as entry_count
       from stock_count_lines l
       left join stock_lots lt on lt.tenant_id = l.tenant_id and lt.id = l.lot_id
       join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
       left join product_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
       left join warehouse_locations loc on loc.tenant_id = l.tenant_id and loc.id = l.location_id
      where l.tenant_id = ? and l.count_id = ? order by l.line_no`,
    [t, id]
  )
  const lines = ls.rows as any[]
  const live =
    book && ['COUNTING', 'REVIEW'].includes(x.status)
      ? await physicalNow(scope, x.warehouse_id, lines)
      : null
  const posts = await scope.trx.rawQuery(
    `select cp.seq, cp.posting_id from stock_count_postings cp where cp.tenant_id = ? and cp.count_id = ? order by cp.seq`,
    [t, id]
  )
  let withDiff = 0
  let countedLines = 0
  const items = lines.map((l) => {
    const snapshot = dec(l.snapshot_quantity)
    const countedQ = l.counted_quantity === null ? null : dec(l.counted_quantity)
    const diff = countDifference({ snapshot, counted: countedQ })
    if (countedQ !== null) countedLines++
    if (diff !== null && diff !== 0n) withDiff++
    return {
      id: l.id as string,
      lineNo: Number(l.line_no),
      location: l.location_id
        ? { id: l.location_id as string, pathCode: l.path_code as string }
        : null,
      product: { id: l.product_id as string, sku: l.sku as string, name: l.product_name as string },
      variant: l.variant_id ? { id: l.variant_id as string, sku: l.variant_sku as string } : null,
      lot: l.lot_id
        ? {
            id: l.lot_id as string,
            code: l.lot_code as string,
            expiryDate: (l.lot_expiry as string) ?? null,
          }
        : null,
      tracksLots: Boolean(l.track_lots),
      tracksSerials: Boolean(l.track_serials),
      uom: l.uom_code as string,
      decimals: Number(l.decimals),
      countedQuantity: countedQ === null ? null : txt(countedQ),
      round: Number(l.round),
      recountRequested: l.recount_requested as boolean,
      recountReason: (l.recount_reason as string) ?? null,
      addedDuringCount: l.added_during_count as boolean,
      entries: Number(l.entry_count),
      // Quantidades do sistema: só para quem as pode ver (contagem cega).
      snapshotQuantity: book ? txt(snapshot) : null,
      difference: book && diff !== null ? txt(diff) : null,
      movedSinceSnapshot: live ? txt(physical(live.get(keyOf(l))) - snapshot) : null,
      reasonCode: (l.reason_code as string) ?? null,
      justification: (l.justification as string) ?? null,
    }
  })
  return {
    id: x.id as string,
    version: Number(x.version),
    number: (x.number as string) ?? null,
    status: x.status as CountStatus,
    description: x.description as string,
    blind: x.blind as boolean,
    warehouse: {
      id: x.warehouse_id as string,
      code: x.wh_code as string,
      name: x.wh_name as string,
    },
    legalEntity: { id: x.legal_entity_id as string, code: x.le_code as string },
    location: x.location_id
      ? { id: x.location_id as string, pathCode: x.zone_path as string }
      : null,
    category: x.category_id
      ? { id: x.category_id as string, code: x.cat_code as string, name: x.cat_name as string }
      : null,
    plannedDate: (x.planned_text as string) ?? null,
    notes: (x.notes as string) ?? null,
    started: x.started_at ? { by: x.starter_name as string, at: x.started_at } : null,
    submitted: x.submitted_at ? { by: x.submitter_name as string, at: x.submitted_at } : null,
    approved: x.approved_at ? { by: x.approver_name as string, at: x.approved_at } : null,
    cancelReason: (x.cancel_reason as string) ?? null,
    createdAt: x.created_at,
    can: {
      manage: g.manage,
      approve: g.approve && !iCounted,
      review: g.approve,
      seeBook: book,
      counted: iCounted,
    },
    summary: {
      lines: items.length,
      counted: countedLines,
      withDifference: book ? withDiff : null,
    },
    postings: (posts.rows as any[]).map((p) => ({
      seq: Number(p.seq),
      postingId: p.posting_id as string,
    })),
    lines: items,
  }
}

export class CountService {
  /** Opções do plano: armazéns onde o membro gere contagens (com as zonas) e categorias. */
  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const whs = await manageableWarehouses(scope)
      const locs = whs.length
        ? await scope.trx.rawQuery(
            `select id, warehouse_id, path_code, name from warehouse_locations
              where tenant_id = ? and warehouse_id = any(?::uuid[]) and status = 'ACTIVE' order by path_code`,
            [context.tenantId, whs.map((w) => w.id)] as never[]
          )
        : { rows: [] }
      const cats = await scope.trx.rawQuery(
        `select id, code, name from product_categories where tenant_id = ? and status = 'ACTIVE' order by code`,
        [context.tenantId]
      )
      return {
        warehouses: whs.map((w) => ({
          ...w,
          locations: (locs.rows as any[])
            .filter((l) => l.warehouse_id === w.id)
            .map((l) => ({
              id: l.id as string,
              pathCode: l.path_code as string,
              name: l.name as string,
            })),
        })),
        categories: cats.rows as { id: string; code: string; name: string }[],
        reasons: [...COUNT_REASONS],
      }
    })
  }

  list(
    context: TenantContext,
    f: { status?: string; warehouseId?: string; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const ids: string[] = []
      for (const id of await readableWarehouseIds(scope))
        if ((await warehouseRights(scope, id)).read) ids.push(id)
      if (!ids.length) return { items: [], total: 0 }
      const where = ['c.tenant_id = ?', 'c.warehouse_id = any(?::uuid[])']
      const params: unknown[] = [context.tenantId, ids]
      for (const [k, col] of [
        ['status', 'c.status'],
        ['warehouseId', 'c.warehouse_id'],
      ] as const)
        if (f[k]) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
        where.push(`(lower(coalesce(c.number, '')) like ? or lower(c.description) like ?)`)
        params.push(like, like)
      }
      const cl = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `select c.*, c.planned_date::text as planned_text, w.code as wh_code, loc.path_code as zone_path,
            (select count(*)::int from stock_count_lines l where l.tenant_id = c.tenant_id and l.count_id = c.id) as line_count,
            (select count(*)::int from stock_count_lines l where l.tenant_id = c.tenant_id and l.count_id = c.id
               and l.counted_quantity is not null) as counted_count
           from stock_counts c
           join warehouses w on w.tenant_id = c.tenant_id and w.id = c.warehouse_id
           left join warehouse_locations loc on loc.tenant_id = c.tenant_id and loc.id = c.location_id
          where ${cl} order by c.created_at desc limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from stock_counts c where ${cl}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map((c) => ({
          id: c.id as string,
          number: (c.number as string) ?? null,
          status: c.status as CountStatus,
          description: c.description as string,
          blind: c.blind as boolean,
          warehouse: { id: c.warehouse_id as string, code: c.wh_code as string },
          zone: (c.zone_path as string) ?? null,
          plannedDate: (c.planned_text as string) ?? null,
          lineCount: Number(c.line_count),
          countedCount: Number(c.counted_count),
        })),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      await authorized(scope, id, 'read')
      return view(scope, id)
    })
  }

  create(context: TenantContext, raw: any) {
    return runInTenant(context, async (scope) => {
      const p = await plan(scope, raw, null)
      const ins = await scope.trx.rawQuery(
        `insert into stock_counts (tenant_id, warehouse_id, legal_entity_id, description, blind, location_id, category_id,
            planned_date, notes, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          p.warehouseId,
          p.legalEntityId,
          p.description,
          p.blind,
          p.locationId,
          p.categoryId,
          p.plannedDate,
          p.notes,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await audit(scope, {
        action: 'inventory.count.created',
        entityType: 'stock_count',
        entityId: id,
        metadata: {
          warehouseId: p.warehouseId,
          locationId: p.locationId,
          categoryId: p.categoryId,
          blind: p.blind,
        },
      })
      return view(scope, id)
    })
  }

  update(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, expectedVersion)
      stateCheck(c, 'edit')
      const p = await plan(scope, raw, c)
      await touch(scope, id, {
        description: p.description,
        blind: p.blind,
        location_id: p.locationId,
        category_id: p.categoryId,
        planned_date: p.plannedDate,
        notes: p.notes,
      })
      await audit(scope, {
        action: 'inventory.count.updated',
        entityType: 'stock_count',
        entityId: id,
        metadata: { locationId: p.locationId, categoryId: p.categoryId, blind: p.blind },
      })
      return view(scope, id)
    })
  }

  /** Início: número da série e snapshot do físico de cada saldo no âmbito do plano. */
  start(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, expectedVersion)
      stateCheck(c, 'start')
      await warehouseLock(scope, c.warehouse_id)
      const where = [
        'b.tenant_id = ?',
        'b.warehouse_id = ?',
        '(b.qty_unrestricted + b.qty_blocked + b.qty_quarantine) <> 0',
      ]
      const params: unknown[] = [t, c.warehouse_id]
      if (c.location_id) {
        where.push(`b.location_id in (${SUBTREE})`)
        params.push(t, c.location_id, t)
      }
      if (c.category_id) {
        where.push(`p.category_id in (${CATEGORY_TREE})`)
        params.push(t, c.category_id, t)
      }
      const snap = await scope.trx.rawQuery(
        `select b.location_id, b.product_id, b.variant_id, b.lot_id,
            (b.qty_unrestricted + b.qty_blocked + b.qty_quarantine) as phys
           from stock_balances b
           join products p on p.tenant_id = b.tenant_id and p.id = b.product_id
           left join warehouse_locations loc on loc.tenant_id = b.tenant_id and loc.id = b.location_id
           left join product_variants v on v.tenant_id = b.tenant_id and v.id = b.variant_id
           left join stock_lots lt on lt.tenant_id = b.tenant_id and lt.id = b.lot_id
          where ${where.join(' and ')}
          order by loc.path_code nulls first, p.sku, v.sku nulls first, lt.expiry_date nulls last, lt.code`,
        params as never[]
      )
      const rows = snap.rows as any[]
      if (rows.length > MAX_COUNT_LINES)
        throw ApiError.conflict(
          'COUNT_TOO_LARGE',
          `O plano abrange ${rows.length} saldos (máximo ${MAX_COUNT_LINES}): restrinja por zona ou categoria.`
        )
      const s = await scope.trx.rawQuery(
        `select s.id from document_series s join warehouses w on w.tenant_id = s.tenant_id and w.id = ?
          where s.tenant_id = ? and s.legal_entity_id = ? and s.document_type = ? and s.status = 'ACTIVE'
            and (s.valid_from is null or s.valid_from <= ?::date) and (s.valid_to is null or s.valid_to >= ?::date)
            and (s.branch_id is null or s.branch_id = w.branch_id)
          order by (s.branch_id is not null) desc, s.code limit 1`,
        [c.warehouse_id, t, c.legal_entity_id, COUNT_SERIES_TYPE, today(), today()] as never[]
      )
      const series = s.rows[0] as { id: string } | undefined
      if (!series)
        throw ApiError.conflict(
          'NO_SERIES',
          `Sem série documental ${COUNT_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
        )
      const number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200)
        const values: unknown[] = []
        chunk.forEach((b, j) =>
          values.push(
            t,
            id,
            i + j + 1,
            c.warehouse_id,
            b.location_id,
            b.product_id,
            b.variant_id,
            b.lot_id,
            txt(dec(b.phys)),
            context.userId,
            context.userId
          )
        )
        await scope.trx.rawQuery(
          `insert into stock_count_lines (tenant_id, count_id, line_no, warehouse_id, location_id, product_id, variant_id,
              lot_id, snapshot_quantity, snapshot_at, created_by, updated_by)
           values ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, now(), ?, ?)').join(', ')}`,
          values as never[]
        )
      }
      await overlapCheck(scope, c)
      await touch(scope, id, {
        status: 'COUNTING',
        series_id: series.id,
        number,
        started_by: context.userId,
        started_at: new Date(),
      })
      await audit(scope, {
        action: 'inventory.count.started',
        entityType: 'stock_count',
        entityId: id,
        metadata: { number, lines: rows.length },
      })
      return view(scope, id)
    })
  }

  /** Regista quantidades contadas (pode ser feito por partes; cada registo fica no histórico). */
  count(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, expectedVersion)
      stateCheck(c, 'count')
      const lines = await lineRows(scope, id)
      const dmap = await scope.trx.rawQuery(
        `select p.id, u.decimals from products p join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
          where p.tenant_id = ? and p.id = any(?::uuid[])`,
        [context.tenantId, [...new Set(lines.map((l) => l.product_id))]] as never[]
      )
      const decimals = new Map(
        (dmap.rows as any[]).map((r) => [r.id as string, Number(r.decimals)])
      )
      const given = new Map<string, any>()
      for (const x of Array.isArray(raw?.lines) ? raw.lines : [])
        if (isUuid(x?.lineId)) given.set(x.lineId, x)
      const issues: ErrorDetail[] = []
      const ups: { l: any; q: bigint }[] = []
      lines.forEach((l, i) => {
        const g = given.get(l.id)
        if (!g) return
        given.delete(l.id)
        const q = scaled(g.quantity, SCALE)
        if (q === null)
          return issues.push({
            path: `lines.${i}.quantity`,
            code: 'INVALID',
            message: 'Quantidade contada: zero ou positiva (unidade base), até 6 casas.',
          })
        if (!fitsDecimals(q, decimals.get(l.product_id) ?? 0))
          return issues.push({
            path: `lines.${i}.quantity`,
            code: 'DECIMALS',
            message: `A unidade base aceita ${decimals.get(l.product_id)} casas decimais.`,
          })
        ups.push({ l, q })
      })
      if (given.size)
        issues.push({
          path: 'lines',
          code: 'NOT_FOUND',
          message: 'Linha que não é desta contagem.',
        })
      fail(issues)
      if (!ups.length)
        fail([
          { path: 'lines', code: 'NOTHING_COUNTED', message: 'Indique as quantidades contadas.' },
        ])
      for (const { l, q } of ups) {
        await scope.trx.rawQuery(
          `insert into stock_count_entries (tenant_id, count_id, line_id, round, quantity, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [context.tenantId, id, l.id, l.round, txt(q), context.userId, context.userId] as never[]
        )
        await scope.trx.rawQuery(
          `update stock_count_lines set counted_quantity = ?, recount_requested = false, updated_at = now(),
              updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
          [txt(q), context.userId, context.tenantId, l.id] as never[]
        )
      }
      await touch(scope, id, {})
      await audit(scope, {
        action: 'inventory.count.counted',
        entityType: 'stock_count',
        entityId: id,
        metadata: { lines: ups.length },
      })
      return view(scope, id)
    })
  }

  /** Artigo encontrado fora do snapshot: nova linha com o físico actual do sistema como snapshot. */
  addLine(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const t = context.tenantId
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, expectedVersion)
      stateCheck(c, 'addLine')
      const issues: ErrorDetail[] = []
      const p = isUuid(raw?.productId)
        ? ((
            await scope.trx.rawQuery(
              `select p.id, p.sku, p.product_type, p.track_lots,
                  exists (select 1 from product_variants v where v.tenant_id = p.tenant_id and v.product_id = p.id) as has_variants
                 from products p where p.tenant_id = ? and p.id = ?`,
              [t, raw.productId]
            )
          ).rows[0] as any)
        : null
      if (!p)
        issues.push({ path: 'productId', code: 'NOT_FOUND', message: 'Produto não encontrado.' })
      else if (p.product_type !== 'STOCKABLE')
        issues.push({
          path: 'productId',
          code: 'NOT_STOCKABLE',
          message: `${p.sku} não é armazenável.`,
        })
      let variantId: string | null = null
      if (p && raw?.variantId) {
        const v = isUuid(raw.variantId)
          ? (
              await scope.trx.rawQuery(
                'select id from product_variants where tenant_id = ? and product_id = ? and id = ?',
                [t, p.id, raw.variantId]
              )
            ).rows[0]
          : null
        if (!v)
          issues.push({
            path: 'variantId',
            code: 'NOT_FOUND',
            message: 'A variante não é deste produto.',
          })
        else variantId = raw.variantId
      } else if (p?.has_variants)
        issues.push({
          path: 'variantId',
          code: 'REQUIRED',
          message: `${p.sku} tem variantes: escolha a variante.`,
        })
      let locationId: string | null = null
      if (raw?.locationId) {
        const l = isUuid(raw.locationId)
          ? ((
              await scope.trx.rawQuery(
                `select id, holds_stock, ${c.location_id ? `(id in (${SUBTREE}))` : 'true'} as in_plan
                   from warehouse_locations where tenant_id = ? and warehouse_id = ? and id = ?`,
                [
                  ...(c.location_id ? [t, c.location_id, t] : []),
                  t,
                  c.warehouse_id,
                  raw.locationId,
                ] as never[]
              )
            ).rows[0] as any)
          : null
        if (!l)
          issues.push({
            path: 'locationId',
            code: 'NOT_FOUND',
            message: 'A localização não é deste armazém.',
          })
        else if (!l.holds_stock)
          issues.push({
            path: 'locationId',
            code: 'NOT_HOLDING',
            message: 'Esta localização não guarda stock.',
          })
        else if (!l.in_plan)
          issues.push({
            path: 'locationId',
            code: 'OUT_OF_PLAN',
            message: 'A localização está fora da zona do plano.',
          })
        else locationId = l.id
      } else if (c.location_id)
        issues.push({
          path: 'locationId',
          code: 'REQUIRED',
          message: 'Indique a localização (zona do plano).',
        })
      // Lote (8.8): um lote existente deste produto/variante; um lote novo entra no ajuste pelo código.
      let lotId: string | null = null
      if (p?.track_lots) {
        if (raw?.lotId) {
          const lt = isUuid(raw.lotId)
            ? (
                await scope.trx.rawQuery(
                  'select id from stock_lots where tenant_id = ? and product_id = ? and variant_id is not distinct from ? and id = ?',
                  [t, p.id, variantId, raw.lotId] as never[]
                )
              ).rows[0]
            : null
          if (!lt)
            issues.push({
              path: 'lotId',
              code: 'NOT_FOUND',
              message: 'O lote não é deste produto.',
            })
          else lotId = raw.lotId
        } else
          issues.push({
            path: 'lotId',
            code: 'REQUIRED',
            message: `${p.sku} controla lotes: escolha o lote (registe um lote novo por uma entrada).`,
          })
      } else if (raw?.lotId)
        issues.push({
          path: 'lotId',
          code: 'NOT_TRACKED',
          message: 'Este produto não controla lotes.',
        })
      fail(issues)
      await warehouseLock(scope, c.warehouse_id)
      const dup = await scope.trx.rawQuery(
        `select line_no from stock_count_lines where tenant_id = ? and count_id = ? and product_id = ?
            and location_id is not distinct from ? and variant_id is not distinct from ?
            and lot_id is not distinct from ?`,
        [t, id, p.id, locationId, variantId, lotId] as never[]
      )
      if (dup.rows.length)
        throw ApiError.conflict(
          'LINE_EXISTS',
          `Este saldo já está na linha ${(dup.rows[0] as any).line_no}.`
        )
      const key = {
        location_id: locationId,
        product_id: p.id,
        variant_id: variantId,
        lot_id: lotId,
      }
      const now = await physicalNow(scope, c.warehouse_id, [key])
      const snapshot = physical(now.get(keyOf(key)))
      const next = await scope.trx.rawQuery(
        'select coalesce(max(line_no), 0) + 1 as n from stock_count_lines where tenant_id = ? and count_id = ?',
        [t, id]
      )
      const ins = await scope.trx.rawQuery(
        `insert into stock_count_lines (tenant_id, count_id, line_no, warehouse_id, location_id, product_id, variant_id,
            lot_id, snapshot_quantity, snapshot_at, added_during_count, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, now(), true, ?, ?) returning id`,
        [
          t,
          id,
          Number((next.rows[0] as any).n),
          c.warehouse_id,
          locationId,
          p.id,
          variantId,
          lotId,
          txt(snapshot),
          context.userId,
          context.userId,
        ] as never[]
      )
      await overlapCheck(scope, c)
      await touch(scope, id, {})
      await audit(scope, {
        action: 'inventory.count.line_added',
        entityType: 'stock_count',
        entityId: id,
        metadata: { lineId: (ins.rows[0] as any).id, productId: p.id, locationId },
      })
      return view(scope, id)
    })
  }

  /** Fim da contagem: todas as linhas contadas → revisão. */
  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'manage', true)
      versionCheck(c, expectedVersion)
      stateCheck(c, 'submit')
      const missing = (await lineRows(scope, id)).filter((l) => l.counted_quantity === null)
      if (missing.length)
        fail([
          {
            path: 'lines',
            code: 'NOT_COUNTED',
            message: `Faltam contar ${missing.length} linha(s): ${missing
              .slice(0, 10)
              .map((l) => l.line_no)
              .join(', ')}.`,
          },
        ])
      await touch(scope, id, {
        status: 'REVIEW',
        submitted_by: context.userId,
        submitted_at: new Date(),
      })
      await audit(scope, {
        action: 'inventory.count.submitted',
        entityType: 'stock_count',
        entityId: id,
      })
      return view(scope, id)
    })
  }

  /**
   * Justificação das diferenças (motivo + texto). Numa contagem cega só quem vê o sistema (quem aprova) justifica;
   * numa aberta, também quem gere.
   */
  justify(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { c, g } = await authorized(scope, id, 'read', true)
      if (!(g.approve || (g.manage && !c.blind)))
        throw ApiError.forbidden(
          'OUT_OF_SCOPE',
          c.blind
            ? 'Contagem cega: as diferenças são justificadas por quem aprova.'
            : 'Não gere contagens deste armazém.'
        )
      versionCheck(c, expectedVersion)
      stateCheck(c, 'justify')
      const lines = await lineRows(scope, id)
      const given = new Map<string, any>()
      for (const x of Array.isArray(raw?.lines) ? raw.lines : [])
        if (isUuid(x?.lineId)) given.set(x.lineId, x)
      const issues: ErrorDetail[] = []
      const ups: { l: any; code: string | null; why: string | null }[] = []
      lines.forEach((l, i) => {
        const x = given.get(l.id)
        if (!x) return
        given.delete(l.id)
        const code = x.reasonCode || null
        const why = text(x.justification, 300)
        if (code === null && why === null) return ups.push({ l, code: null, why: null })
        if (!COUNT_REASONS.includes(code))
          return issues.push({
            path: `lines.${i}.reasonCode`,
            code: 'INVALID',
            message: 'Motivo inválido.',
          })
        if (!why)
          return issues.push({
            path: `lines.${i}.justification`,
            code: 'REQUIRED',
            message: 'Explique a diferença.',
          })
        if (dec(l.counted_quantity) === dec(l.snapshot_quantity))
          return issues.push({
            path: `lines.${i}.reasonCode`,
            code: 'NO_DIFFERENCE',
            message: 'Esta linha não tem diferença.',
          })
        ups.push({ l, code, why })
      })
      if (given.size)
        issues.push({
          path: 'lines',
          code: 'NOT_FOUND',
          message: 'Linha que não é desta contagem.',
        })
      fail(issues)
      if (!ups.some((u) => u.code !== null))
        fail([{ path: 'lines', code: 'REQUIRED', message: 'Indique o motivo e a explicação.' }])
      for (const u of ups)
        await scope.trx.rawQuery(
          `update stock_count_lines set reason_code = ?, justification = ?, updated_at = now(), updated_by = ?,
              version = version + 1 where tenant_id = ? and id = ?`,
          [u.code, u.why, context.userId, context.tenantId, u.l.id] as never[]
        )
      await touch(scope, id, {})
      await audit(scope, {
        action: 'inventory.count.justified',
        entityType: 'stock_count',
        entityId: id,
        metadata: { lines: ups.map((u) => ({ lineNo: Number(u.l.line_no), reasonCode: u.code })) },
      })
      return view(scope, id)
    })
  }

  /**
   * Recontagem de linhas (quem aprova, com motivo): nova volta, sem quantidade, e snapshot renovado com o físico actual
   * (quem reconta conta o stock de agora). A contagem volta a "em contagem".
   */
  recount(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const { c } = await authorized(scope, id, 'approve', true)
      versionCheck(c, expectedVersion)
      stateCheck(c, 'recount')
      const wanted = new Set(
        (Array.isArray(raw?.lineIds) ? raw.lineIds : []).filter((x: unknown) => isUuid(x))
      )
      const lines = (await lineRows(scope, id)).filter((l) => wanted.has(l.id))
      if (!lines.length || lines.length !== wanted.size)
        fail([
          {
            path: 'lineIds',
            code: 'REQUIRED',
            message: 'Escolha as linhas desta contagem a recontar.',
          },
        ])
      const now = await physicalNow(scope, c.warehouse_id, lines)
      for (const l of lines)
        await scope.trx.rawQuery(
          `update stock_count_lines set round = round + 1, counted_quantity = null, recount_requested = true,
              recount_reason = ?, reason_code = null, justification = null, snapshot_quantity = ?, snapshot_at = now(),
              updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
          [
            reason,
            txt(physical(now.get(keyOf(l)))),
            context.userId,
            context.tenantId,
            l.id,
          ] as never[]
        )
      await touch(scope, id, { status: 'COUNTING', submitted_by: null, submitted_at: null })
      await audit(scope, {
        action: 'inventory.count.recount_requested',
        entityType: 'stock_count',
        entityId: id,
        metadata: { reason, lines: lines.map((l) => Number(l.line_no)) },
      })
      return view(scope, id)
    })
  }

  /**
   * Aprovação: com tudo contado e as diferenças justificadas, lança o ajuste (`contado − snapshot` por saldo) e fecha
   * a contagem. Quem registou contagens não aprova.
   */
  approve(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { c } = await authorized(scope, id, 'approve', true)
      versionCheck(c, expectedVersion)
      stateCheck(c, 'approve')
      if (await counted(scope, id))
        throw ApiError.forbidden('SELF_APPROVAL', 'Quem contou não pode aprovar o ajuste.')
      const lines = await lineRows(scope, id)
      const pending = approvalIssues(
        lines.map((l) => ({
          lineNo: Number(l.line_no),
          snapshot: dec(l.snapshot_quantity),
          counted: l.counted_quantity === null ? null : dec(l.counted_quantity),
          reasonCode: l.reason_code,
          justification: l.justification,
        }))
      )
      if (pending.length)
        fail(
          pending.slice(0, 20).map((p) => ({
            path: `lines.${p.lineNo}`,
            code: p.code,
            message:
              p.code === 'NOT_COUNTED'
                ? `Linha ${p.lineNo}: por contar.`
                : `Linha ${p.lineNo}: diferença sem motivo e justificação.`,
          }))
        )
      const diffs = lines
        .map((l) => ({ l, d: dec(l.counted_quantity) - dec(l.snapshot_quantity) }))
        .filter((x) => x.d !== 0n)
      // Séries (8.8): o ajuste não sabe que unidades faltam ou sobram — regulariza-se por documento com as séries.
      const serialRows = diffs.length
        ? await scope.trx.rawQuery(
            'select id from products where tenant_id = ? and track_serials and id = any(?::uuid[])',
            [context.tenantId, [...new Set(diffs.map((x) => x.l.product_id))]] as never[]
          )
        : { rows: [] }
      const serialIds = new Set((serialRows.rows as any[]).map((x) => x.id as string))
      const serialIssues = diffs
        .filter((x) => serialIds.has(x.l.product_id))
        .map((x) => ({
          path: `lines.${x.l.line_no}`,
          code: 'SERIALS_REQUIRED',
          message: `Linha ${x.l.line_no}: produto com séries — regularize a diferença com uma entrada ou saída que indique as séries.`,
        }))
      fail(serialIssues)
      const now = await physicalNow(
        scope,
        c.warehouse_id,
        diffs.map((x) => x.l)
      )
      const posting: PostStockLineInput[] = []
      const issues: ErrorDetail[] = []
      for (const { l, d } of diffs) {
        const split = splitAdjustment(
          d,
          now.get(keyOf(l)) ?? { unrestricted: 0n, blocked: 0n, quarantine: 0n }
        )
        if (split.shortfall > 0n)
          issues.push({
            path: `lines.${l.line_no}`,
            code: 'INSUFFICIENT_STOCK',
            message: `Linha ${l.line_no}: o stock saiu depois do snapshot e falta ${txt(split.shortfall)} para o ajuste — peça recontagem.`,
          })
        for (const part of split.parts)
          posting.push({
            warehouseId: c.warehouse_id,
            locationId: l.location_id,
            productId: l.product_id,
            variantId: l.variant_id,
            lotId: l.lot_id ?? null,
            bucket: part.bucket,
            quantity: txt(part.quantity),
          })
      }
      fail(issues)
      for (let i = 0, seq = 1; i < posting.length; i += POSTING_CHUNK, seq++) {
        const posted = await postStock(scope, {
          type: 'ADJUSTMENT',
          idempotencyKey: `count-${id}-adjust-${seq}`,
          sourceType: 'STOCK_COUNT',
          sourceId: id,
          sourceRef: c.number,
          reason: `Contagem ${c.number}: ${c.description}`.slice(0, 300),
          lines: posting.slice(i, i + POSTING_CHUNK),
          // A autorização (aprovação no âmbito do armazém) foi verificada aqui.
          checkAccess: false,
        })
        await scope.trx.rawQuery(
          `insert into stock_count_postings (tenant_id, count_id, seq, posting_id, created_by, updated_by)
           values (?, ?, ?, ?, ?, ?)`,
          [context.tenantId, id, seq, posted.posting.id, context.userId, context.userId] as never[]
        )
      }
      await touch(scope, id, {
        status: 'APPROVED',
        approved_by: context.userId,
        approved_at: new Date(),
      })
      await audit(scope, {
        action: 'inventory.count.approved',
        entityType: 'stock_count',
        entityId: id,
        metadata: {
          number: c.number,
          adjustedLines: diffs.length,
          postings: Math.ceil(posting.length / POSTING_CHUNK),
        },
      })
      return view(scope, id)
    })
  }

  /** Anula sem ajustar (motivo). */
  cancel(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const { c, g } = await authorized(scope, id, 'read', true)
      if (!g.manage && !g.approve)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode anular esta contagem.')
      versionCheck(c, expectedVersion)
      stateCheck(c, 'cancel')
      await touch(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await audit(scope, {
        action: 'inventory.count.cancelled',
        entityType: 'stock_count',
        entityId: id,
        metadata: { reason },
      })
      return view(scope, id)
    })
  }
}
