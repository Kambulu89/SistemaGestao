import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import { fitsDecimals, scaled, scaledText } from '#modules/inventory/domain/catalog'
import {
  coversDepartment,
  issueIssue,
  openQuantity,
  REQUISITION_CAN,
  REQUISITION_SERIES_TYPE,
  statusAfterIssue,
  type RequisitionStatus,
} from '#modules/inventory/domain/requisitions'
import {
  readableWarehouseIds,
  warehouseAccessFor,
} from '#modules/inventory/application/warehouse_service'
import { postStock, type PostStockLineInput } from '#modules/inventory/application/stock_service'

/*
 * Requisições internas (8.6). Pedir (`inventory.requisitions.request`: no âmbito do departamento, ou só as próprias com
 * âmbito "próprio"), aprovar (`inventory.requisitions.approve`: no âmbito do departamento; quem pede não aprova) e
 * atender (`inventory.requisitions.fulfil`: separar, entregar e libertar, no âmbito do armazém, com acesso de operação).
 * O stock muda só por `postStock`: aprovação → reserva (baixa o disponível, não o físico); entrega → sai do livre e
 * consome a reserva; libertação e anulação → liberta a reserva.
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
const KEY = /^[A-Za-z0-9:._-]{8,80}$/
const today = () => new Date().toISOString().slice(0, 10)

interface Scopes {
  request: PermissionScope
  approve: PermissionScope
}
async function scopes(scope: TenantScope): Promise<Scopes> {
  return {
    request: await permissionScope(scope, 'inventory.requisitions.request'),
    approve: await permissionScope(scope, 'inventory.requisitions.approve'),
  }
}
const any = (s: PermissionScope) =>
  s.tenant || s.own || s.legalEntityIds.size > 0 || s.branchIds.size > 0 || s.departmentIds.size > 0

async function departmentFacts(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `select id, code, name, legal_entity_id as "legalEntityId", branch_id as "branchId", status
       from departments where tenant_id = ? and id = ?`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

/** Atender: permissão de atendimento no âmbito do armazém e acesso de operação. */
async function fulfilRight(scope: TenantScope, warehouseId: string) {
  const a = await warehouseAccessFor(scope, warehouseId)
  if (!a || !a.operate) return false
  const s = await permissionScope(scope, 'inventory.requisitions.fulfil')
  return (
    s.tenant ||
    s.legalEntityIds.has(a.legalEntityId) ||
    (!!a.branchId && s.branchIds.has(a.branchId))
  )
}

async function rights(scope: TenantScope, r: any, sc?: Scopes) {
  const s = sc ?? (await scopes(scope))
  const dept = {
    id: r.department_id,
    legalEntityId: r.legal_entity_id,
    branchId: r.dept_branch_id ?? null,
  }
  const mine = r.requested_by_membership_id === scope.context.membershipId
  const request = coversDepartment(s.request, dept) || (mine && any(s.request))
  const approve = coversDepartment(s.approve, dept)
  const fulfil = await fulfilRight(scope, r.warehouse_id)
  return { request, approve, fulfil, mine, read: request || approve || fulfil }
}

async function loadReq(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select r.*, d.branch_id as dept_branch_id from stock_requisitions r
       join departments d on d.tenant_id = r.tenant_id and d.id = r.department_id
      where r.tenant_id = ? and r.id = ?${lock ? ' for update of r' : ''}`,
    [scope.context.tenantId, id]
  )
  const x = r.rows[0] as any
  if (!x) throw ApiError.notFound()
  return x
}

async function authorized(
  scope: TenantScope,
  id: string,
  need: 'read' | 'request' | 'approve' | 'fulfil',
  lock = false
) {
  const r = await loadReq(scope, id, lock)
  const g = await rights(scope, r)
  if (!g.read) throw ApiError.notFound()
  if (need !== 'read' && !g[need])
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      {
        request: 'Não pode alterar requisições deste departamento.',
        approve: 'Não aprova requisições deste departamento.',
        fulfil: 'Não atende requisições deste armazém.',
      }[need]
    )
  return { r, g }
}

const versionCheck = (r: any, expected: number) => {
  if (Number(r.version) !== expected) throw ApiError.versionConflict(Number(r.version))
}
const stateCheck = (r: any, action: keyof typeof REQUISITION_CAN) => {
  if (!REQUISITION_CAN[action].includes(r.status))
    throw ApiError.conflict('INVALID_STATE', `Não é possível nesta fase (${r.status}).`)
}
const keyCheck = (key: unknown) => {
  if (typeof key !== 'string' || !KEY.test(key))
    fail([{ path: 'idempotencyKey', code: 'INVALID', message: 'Chave de idempotência inválida.' }])
  return key as string
}

async function touch(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update stock_requisitions set ${keys.map((k) => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}
       updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function lineRows(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    `select * from stock_requisition_lines where tenant_id = ? and requisition_id = ? order by line_no for update`,
    [scope.context.tenantId, id]
  )
  return r.rows as any[]
}
const flow = (l: any) => ({
  quantity: dec(l.quantity),
  issued: dec(l.issued_quantity),
  released: dec(l.released_quantity),
  picked: l.picked_quantity === null ? null : dec(l.picked_quantity),
})

/** Armazéns de onde se pode requisitar: activos, abertos ou visíveis ao membro. */
async function sourceWarehouses(scope: TenantScope) {
  const ids = await readableWarehouseIds(scope)
  const r = await scope.trx.rawQuery(
    `select w.id, w.code, w.name, w.legal_entity_id, le.code as le_code from warehouses w
       join legal_entities le on le.tenant_id = w.tenant_id and le.id = w.legal_entity_id
      where w.tenant_id = ? and w.status = 'ACTIVE' and (w.access_mode = 'OPEN' or w.id = any(?::uuid[]))
      order by w.code`,
    [scope.context.tenantId, ids] as never[]
  )
  return (r.rows as any[]).map((w) => ({
    id: w.id as string,
    code: w.code as string,
    name: w.name as string,
    legalEntityId: w.legal_entity_id as string,
    legalEntityCode: w.le_code as string,
  }))
}

interface NormLine {
  productId: string
  variantId: string | null
  quantity: bigint
  sourceLocationId: string | null
}

async function normalizeLines(
  scope: TenantScope,
  warehouseId: string,
  raw: unknown
): Promise<NormLine[]> {
  const t = scope.context.tenantId
  if (!Array.isArray(raw) || !raw.length)
    fail([
      { path: 'lines', code: 'REQUIRED', message: 'A requisição precisa de pelo menos uma linha.' },
    ])
  const input = raw as any[]
  if (input.length > 200)
    fail([{ path: 'lines', code: 'LENGTH', message: 'No máximo 200 linhas.' }])
  const pids = [...new Set(input.map((l) => l?.productId).filter(isUuid))]
  const products = pids.length
    ? await scope.trx.rawQuery(
        `select p.id, p.sku, p.product_type, p.status, bu.decimals,
            exists (select 1 from product_variants v where v.tenant_id = p.tenant_id and v.product_id = p.id) as has_variants
           from products p join uoms bu on bu.tenant_id = p.tenant_id and bu.id = p.base_uom_id
          where p.tenant_id = ? and p.id = any(?::uuid[])`,
        [t, pids] as never[]
      )
    : { rows: [] }
  const pmap = new Map((products.rows as any[]).map((p) => [p.id as string, p]))
  const vids = [...new Set(input.map((l) => l?.variantId).filter(isUuid))]
  const variants = vids.length
    ? await scope.trx.rawQuery(
        'select id, product_id from product_variants where tenant_id = ? and id = any(?::uuid[])',
        [t, vids] as never[]
      )
    : { rows: [] }
  const vmap = new Map(
    (variants.rows as any[]).map((v) => [v.id as string, v.product_id as string])
  )
  const locs = await scope.trx.rawQuery(
    'select id, path_code, holds_stock from warehouse_locations where tenant_id = ? and warehouse_id = ?',
    [t, warehouseId]
  )
  const lmap = new Map((locs.rows as any[]).map((l) => [l.id as string, l]))
  const issues: ErrorDetail[] = []
  const out: NormLine[] = []
  input.forEach((l, i) => {
    const add = (path: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${path}`, code, message })
    const p = isUuid(l?.productId) ? pmap.get(l.productId) : null
    if (!p) return add('productId', 'NOT_FOUND', 'Produto não encontrado.')
    if (p.product_type !== 'STOCKABLE')
      return add('productId', 'NOT_STOCKABLE', `${p.sku} não é armazenável.`)
    let variantId: string | null = null
    if (l?.variantId) {
      if (!isUuid(l.variantId) || vmap.get(l.variantId) !== p.id)
        add('variantId', 'NOT_FOUND', 'A variante não é deste produto.')
      else variantId = l.variantId
    } else if (p.has_variants)
      add('variantId', 'REQUIRED', `${p.sku} tem variantes: escolha a variante.`)
    const quantity = scaled(l?.quantity, SCALE)
    if (quantity === null || quantity === 0n)
      add('quantity', 'INVALID', 'Quantidade positiva (unidade base), até 6 casas.')
    else if (!fitsDecimals(quantity, Number(p.decimals)))
      add('quantity', 'DECIMALS', `A unidade base de ${p.sku} aceita ${p.decimals} casas decimais.`)
    let sourceLocationId: string | null = null
    if (l?.sourceLocationId) {
      const loc = isUuid(l.sourceLocationId) ? lmap.get(l.sourceLocationId) : null
      if (!loc) add('sourceLocationId', 'NOT_FOUND', 'A localização não é deste armazém.')
      else if (!loc.holds_stock)
        add('sourceLocationId', 'NOT_HOLDING', `${loc.path_code} não guarda stock.`)
      else sourceLocationId = loc.id
    }
    out.push({ productId: p.id, variantId, quantity: quantity ?? 0n, sourceLocationId })
  })
  fail(issues)
  return out
}

async function insertLines(scope: TenantScope, id: string, warehouseId: string, lines: NormLine[]) {
  const { tenantId, userId } = scope.context
  const values: unknown[] = []
  lines.forEach((l, i) =>
    values.push(
      tenantId,
      id,
      i + 1,
      l.productId,
      l.variantId,
      txt(l.quantity),
      warehouseId,
      l.sourceLocationId,
      userId,
      userId
    )
  )
  await scope.trx.rawQuery(
    `insert into stock_requisition_lines (tenant_id, requisition_id, line_no, product_id, variant_id, quantity,
        warehouse_id, source_location_id, created_by, updated_by)
     values ${lines.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    values as never[]
  )
}

/** Cabeçalho: armazém (só na criação), departamento e centro de custo da mesma entidade legal, finalidade, data. */
async function header(scope: TenantScope, raw: any, current: any | null) {
  const issues: ErrorDetail[] = []
  const warehouseId = current?.warehouse_id ?? raw?.warehouseId
  const wh = isUuid(warehouseId)
    ? (await sourceWarehouses(scope)).find((w) => w.id === warehouseId)
    : null
  if (!current && !wh)
    issues.push({
      path: 'warehouseId',
      code: 'NOT_FOUND',
      message: 'Armazém não encontrado ou inactivo.',
    })
  const legalEntityId = current?.legal_entity_id ?? wh?.legalEntityId
  const dept = await departmentFacts(scope, raw?.departmentId)
  if (!dept || dept.status !== 'ACTIVE')
    issues.push({
      path: 'departmentId',
      code: 'NOT_FOUND',
      message: 'Departamento activo obrigatório.',
    })
  else if (legalEntityId && dept.legalEntityId !== legalEntityId)
    issues.push({
      path: 'departmentId',
      code: 'OTHER_LEGAL_ENTITY',
      message:
        'O departamento é de outra entidade legal: entre entidades use uma transferência intragrupo.',
    })
  let costCenterId: string | null = null
  if (raw?.costCenterId) {
    const c = isUuid(raw.costCenterId)
      ? ((
          await scope.trx.rawQuery(
            'select id, legal_entity_id, status from cost_centers where tenant_id = ? and id = ?',
            [scope.context.tenantId, raw.costCenterId]
          )
        ).rows[0] as any)
      : null
    if (!c || c.status !== 'ACTIVE')
      issues.push({
        path: 'costCenterId',
        code: 'NOT_FOUND',
        message: 'Centro de custo activo não encontrado.',
      })
    else if (legalEntityId && c.legal_entity_id !== legalEntityId)
      issues.push({
        path: 'costCenterId',
        code: 'OTHER_LEGAL_ENTITY',
        message: 'O centro de custo é de outra entidade legal.',
      })
    else costCenterId = c.id
  }
  const purpose = text(raw?.purpose, 300)
  if (!purpose)
    issues.push({ path: 'purpose', code: 'REQUIRED', message: 'Indique para que é preciso.' })
  const neededBy = raw?.neededBy || null
  if (neededBy && (!DATE.test(neededBy) || Number.isNaN(Date.parse(neededBy))))
    issues.push({ path: 'neededBy', code: 'INVALID', message: 'Data inválida.' })
  fail(issues)
  return {
    warehouseId: warehouseId as string,
    legalEntityId: legalEntityId as string,
    dept,
    costCenterId,
    purpose: purpose!,
    neededBy,
    notes: text(raw?.notes, 500),
  }
}

async function view(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  const h = await scope.trx.rawQuery(
    `select r.*, r.needed_by::text as needed_text, d.code as dept_code, d.name as dept_name, d.branch_id as dept_branch_id,
        cc.code as cc_code, cc.name as cc_name, w.code as wh_code, w.name as wh_name, le.code as le_code,
        ru.full_name as requester_name, au.full_name as approver_name, pu.full_name as picker_name
       from stock_requisitions r
       join departments d on d.tenant_id = r.tenant_id and d.id = r.department_id
       join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
       join legal_entities le on le.tenant_id = r.tenant_id and le.id = r.legal_entity_id
       join tenant_memberships rm on rm.tenant_id = r.tenant_id and rm.id = r.requested_by_membership_id
       join users ru on ru.id = rm.user_id
       left join cost_centers cc on cc.tenant_id = r.tenant_id and cc.id = r.cost_center_id
       left join users au on au.id = r.approved_by
       left join users pu on pu.id = r.picked_by
      where r.tenant_id = ? and r.id = ?`,
    [t, id]
  )
  const x = h.rows[0] as any
  if (!x) throw ApiError.notFound()
  const ls = await scope.trx.rawQuery(
    `select l.*, p.sku, p.name as product_name, v.sku as variant_sku, u.code as uom_code, loc.path_code
       from stock_requisition_lines l
       join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
       left join product_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
       left join warehouse_locations loc on loc.tenant_id = l.tenant_id and loc.id = l.source_location_id
      where l.tenant_id = ? and l.requisition_id = ? order by l.line_no`,
    [t, id]
  )
  const ev = await scope.trx.rawQuery(
    `select e.*, u.full_name as created_name,
        (select count(*)::int from stock_requisition_event_lines el where el.tenant_id = e.tenant_id and el.event_id = e.id) as line_count
       from stock_requisition_events e left join users u on u.id = e.created_by
      where e.tenant_id = ? and e.requisition_id = ? order by e.created_at`,
    [t, id]
  )
  const g = await rights(scope, x)
  return {
    id: x.id as string,
    version: Number(x.version),
    number: (x.number as string) ?? null,
    status: x.status as RequisitionStatus,
    warehouse: {
      id: x.warehouse_id as string,
      code: x.wh_code as string,
      name: x.wh_name as string,
    },
    legalEntity: { id: x.legal_entity_id as string, code: x.le_code as string },
    department: {
      id: x.department_id as string,
      code: x.dept_code as string,
      name: x.dept_name as string,
    },
    costCenter: x.cost_center_id
      ? { id: x.cost_center_id as string, code: x.cc_code as string, name: x.cc_name as string }
      : null,
    requestedBy: {
      membershipId: x.requested_by_membership_id as string,
      name: x.requester_name as string,
    },
    purpose: x.purpose as string,
    neededBy: (x.needed_text as string) ?? null,
    notes: (x.notes as string) ?? null,
    submittedAt: x.submitted_at,
    approved: x.approved_at ? { by: x.approver_name as string, at: x.approved_at } : null,
    picked: x.picked_at ? { by: x.picker_name as string, at: x.picked_at } : null,
    completedAt: x.completed_at,
    closeReason: (x.close_reason as string) ?? null,
    rejectReason: (x.reject_reason as string) ?? null,
    cancelReason: (x.cancel_reason as string) ?? null,
    createdAt: x.created_at,
    can: { request: g.request, approve: g.approve && !g.mine, fulfil: g.fulfil, mine: g.mine },
    lines: (ls.rows as any[]).map((l) => {
      const f = flow(l)
      return {
        id: l.id as string,
        lineNo: Number(l.line_no),
        product: {
          id: l.product_id as string,
          sku: l.sku as string,
          name: l.product_name as string,
        },
        variant: l.variant_id ? { id: l.variant_id as string, sku: l.variant_sku as string } : null,
        uom: l.uom_code as string,
        quantity: txt(f.quantity),
        sourceLocation: l.source_location_id
          ? { id: l.source_location_id as string, pathCode: l.path_code as string }
          : null,
        pickedQuantity: f.picked === null ? null : txt(f.picked),
        issuedQuantity: txt(f.issued),
        releasedQuantity: txt(f.released),
        openQuantity: txt(openQuantity(f)),
      }
    }),
    events: (ev.rows as any[]).map((e) => ({
      id: e.id as string,
      kind: e.kind as string,
      postingId: e.posting_id as string,
      reason: (e.reason as string) ?? null,
      lineCount: Number(e.line_count),
      createdAt: e.created_at,
      createdBy: (e.created_name as string) ?? null,
    })),
  }
}

async function post(
  scope: TenantScope,
  r: any,
  kind: 'RESERVE' | 'ISSUE' | 'RELEASE',
  key: string,
  lines: PostStockLineInput[],
  eventLines: { lineId: string; quantity: bigint }[],
  reason: string | null
) {
  const posted = await postStock(scope, {
    type: ({ RESERVE: 'RESERVATION', ISSUE: 'ISSUE', RELEASE: 'RELEASE' } as const)[kind],
    idempotencyKey: `req-${r.id}-${key}`,
    sourceType: 'INTERNAL_REQUISITION',
    sourceId: r.id,
    sourceRef: r.number,
    reason: reason ?? r.purpose,
    lines,
    // A autorização de cada passo foi verificada aqui (quem aprova pode não operar o armazém).
    checkAccess: false,
  })
  const e = await scope.trx.rawQuery(
    `insert into stock_requisition_events (tenant_id, requisition_id, kind, idempotency_key, posting_id, reason, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
    [
      scope.context.tenantId,
      r.id,
      kind,
      key,
      posted.posting.id,
      reason,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
  const eid = (e.rows[0] as { id: string }).id
  for (const l of eventLines)
    await scope.trx.rawQuery(
      `insert into stock_requisition_event_lines (tenant_id, event_id, line_id, quantity, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        eid,
        l.lineId,
        txt(l.quantity),
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
}

async function eventDone(scope: TenantScope, id: string, key: string) {
  const r = await scope.trx.rawQuery(
    'select 1 from stock_requisition_events where tenant_id = ? and requisition_id = ? and idempotency_key = ?',
    [scope.context.tenantId, id, key]
  )
  return r.rows.length > 0
}

const reserveLine = (r: any, l: any, q: bigint): PostStockLineInput => ({
  warehouseId: r.warehouse_id,
  locationId: null,
  productId: l.product_id,
  variantId: l.variant_id,
  bucket: 'RESERVED',
  quantity: txt(q),
})

/** Liberta o que está em aberto em todas as linhas (reserva) e regista a quantidade libertada. */
async function releaseOpen(scope: TenantScope, r: any, key: string, reason: string) {
  const lines = (await lineRows(scope, r.id))
    .map((l) => ({ l, q: openQuantity(flow(l)) }))
    .filter((x) => x.q > 0n)
  if (!lines.length) return 0
  await post(
    scope,
    r,
    'RELEASE',
    key,
    lines.map(({ l, q }) => ({ ...reserveLine(r, l, q), quantity: `-${txt(q)}` })),
    lines.map(({ l, q }) => ({ lineId: l.id, quantity: q })),
    reason
  )
  for (const { l, q } of lines)
    await scope.trx.rawQuery(
      'update stock_requisition_lines set released_quantity = released_quantity + ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?',
      [txt(q), scope.context.tenantId, l.id] as never[]
    )
  return lines.length
}

export class RequisitionService {
  /** Opções do formulário: armazéns, departamentos para que o membro pode requisitar e centros de custo activos. */
  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopes(scope)
      const d = await scope.trx.rawQuery(
        `select id, code, name, legal_entity_id as "legalEntityId", branch_id as "branchId" from departments
          where tenant_id = ? and status = 'ACTIVE' order by code`,
        [context.tenantId]
      )
      const c = await scope.trx.rawQuery(
        `select id, code, name, legal_entity_id as "legalEntityId" from cost_centers
          where tenant_id = ? and status = 'ACTIVE' order by code`,
        [context.tenantId]
      )
      return {
        warehouses: await sourceWarehouses(scope),
        departments: (d.rows as any[])
          .filter((x) => s.request.own || coversDepartment(s.request, x))
          .map((x) => ({ id: x.id, code: x.code, name: x.name, legalEntityId: x.legalEntityId })),
        costCenters: c.rows as { id: string; code: string; name: string; legalEntityId: string }[],
      }
    })
  }

  list(
    context: TenantContext,
    f: {
      status?: string
      warehouseId?: string
      departmentId?: string
      q?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopes(scope)
      // Armazéns que o membro atende (âmbito de atendimento + acesso de operação).
      const fulfil: string[] = []
      for (const id of await readableWarehouseIds(scope))
        if (await fulfilRight(scope, id)) fulfil.push(id)
      const parts: string[] = []
      const params: unknown[] = []
      const union = (k: 'legalEntityIds' | 'branchIds' | 'departmentIds') => [
        ...new Set([...s.request[k], ...s.approve[k]]),
      ]
      if (s.request.tenant || s.approve.tenant) parts.push('true')
      else {
        for (const [k, col] of [
          ['legalEntityIds', 'r.legal_entity_id'],
          ['branchIds', 'd.branch_id'],
          ['departmentIds', 'r.department_id'],
        ] as const) {
          const v = union(k)
          if (v.length) {
            parts.push(`${col} = any(?::uuid[])`)
            params.push(v)
          }
        }
        if (any(s.request)) {
          parts.push('r.requested_by_membership_id = ?')
          params.push(context.membershipId)
        }
      }
      if (fulfil.length) {
        parts.push('r.warehouse_id = any(?::uuid[])')
        params.push(fulfil)
      }
      if (!parts.length) return { items: [], total: 0 }
      const where = ['r.tenant_id = ?', `(${parts.join(' or ')})`]
      const all: unknown[] = [context.tenantId, ...params]
      for (const [k, col] of [
        ['status', 'r.status'],
        ['warehouseId', 'r.warehouse_id'],
        ['departmentId', 'r.department_id'],
      ] as const)
        if (f[k]) {
          where.push(`${col} = ?`)
          all.push(f[k])
        }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(`(lower(coalesce(r.number, '')) like ? or lower(r.purpose) like ?)`)
        all.push(like, like)
      }
      const cl = where.join(' and ')
      const from = `from stock_requisitions r join departments d on d.tenant_id = r.tenant_id and d.id = r.department_id`
      const rows = await scope.trx.rawQuery(
        `select r.*, r.needed_by::text as needed_text, d.code as dept_code, w.code as wh_code, u.full_name as requester_name,
            (select count(*)::int from stock_requisition_lines l where l.tenant_id = r.tenant_id and l.requisition_id = r.id) as line_count
           ${from}
           join warehouses w on w.tenant_id = r.tenant_id and w.id = r.warehouse_id
           join tenant_memberships m on m.tenant_id = r.tenant_id and m.id = r.requested_by_membership_id
           join users u on u.id = m.user_id
          where ${cl} order by r.created_at desc limit ? offset ?`,
        [...all, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n ${from} where ${cl}`,
        all as never[]
      )
      return {
        items: (rows.rows as any[]).map((r) => ({
          id: r.id as string,
          number: (r.number as string) ?? null,
          status: r.status as RequisitionStatus,
          warehouse: { id: r.warehouse_id as string, code: r.wh_code as string },
          department: { id: r.department_id as string, code: r.dept_code as string },
          requestedBy: { name: r.requester_name as string },
          purpose: r.purpose as string,
          neededBy: (r.needed_text as string) ?? null,
          lineCount: Number(r.line_count),
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
      const h = await header(scope, raw, null)
      const s = await scopes(scope)
      if (!coversDepartment(s.request, h.dept) && !s.request.own)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode requisitar para este departamento.')
      const lines = await normalizeLines(scope, h.warehouseId, raw?.lines)
      const ins = await scope.trx.rawQuery(
        `insert into stock_requisitions (tenant_id, warehouse_id, legal_entity_id, department_id, cost_center_id,
            requested_by_membership_id, purpose, needed_by, notes, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          h.warehouseId,
          h.legalEntityId,
          h.dept.id,
          h.costCenterId,
          context.membershipId,
          h.purpose,
          h.neededBy,
          h.notes,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await insertLines(scope, id, h.warehouseId, lines)
      await audit(scope, {
        action: 'inventory.requisition.created',
        entityType: 'stock_requisition',
        entityId: id,
        metadata: {
          warehouseId: h.warehouseId,
          departmentId: h.dept.id,
          costCenterId: h.costCenterId,
          lines: lines.length,
        },
      })
      return view(scope, id)
    })
  }

  update(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'request', true)
      versionCheck(r, expectedVersion)
      stateCheck(r, 'edit')
      const h = await header(scope, raw, r)
      const lines = await normalizeLines(scope, r.warehouse_id, raw?.lines)
      await scope.trx.rawQuery(
        'delete from stock_requisition_lines where tenant_id = ? and requisition_id = ?',
        [context.tenantId, id]
      )
      await insertLines(scope, id, r.warehouse_id, lines)
      await touch(scope, id, {
        department_id: h.dept.id,
        cost_center_id: h.costCenterId,
        purpose: h.purpose,
        needed_by: h.neededBy,
        notes: h.notes,
      })
      await audit(scope, {
        action: 'inventory.requisition.updated',
        entityType: 'stock_requisition',
        entityId: id,
        metadata: { lines: lines.length },
      })
      return view(scope, id)
    })
  }

  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'request', true)
      versionCheck(r, expectedVersion)
      stateCheck(r, 'submit')
      await touch(scope, id, { status: 'REQUESTED', submitted_at: new Date() })
      await audit(scope, {
        action: 'inventory.requisition.submitted',
        entityType: 'stock_requisition',
        entityId: id,
      })
      return view(scope, id)
    })
  }

  /** Aprovação: número da série da entidade e reserva das quantidades no armazém. */
  approve(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { r, g } = await authorized(scope, id, 'approve', true)
      versionCheck(r, expectedVersion)
      stateCheck(r, 'approve')
      if (g.mine)
        throw ApiError.forbidden('SELF_APPROVAL', 'Quem pede a requisição não a pode aprovar.')
      const s = await scope.trx.rawQuery(
        `select s.id from document_series s join warehouses w on w.tenant_id = s.tenant_id and w.id = ?
          where s.tenant_id = ? and s.legal_entity_id = ? and s.document_type = ? and s.status = 'ACTIVE'
            and (s.valid_from is null or s.valid_from <= ?::date) and (s.valid_to is null or s.valid_to >= ?::date)
            and (s.branch_id is null or s.branch_id = w.branch_id)
          order by (s.branch_id is not null) desc, s.code limit 1`,
        [
          r.warehouse_id,
          context.tenantId,
          r.legal_entity_id,
          REQUISITION_SERIES_TYPE,
          today(),
          today(),
        ] as never[]
      )
      const series = s.rows[0] as { id: string } | undefined
      if (!series)
        throw ApiError.conflict(
          'NO_SERIES',
          `Sem série documental ${REQUISITION_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
        )
      r.number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      const lines = await lineRows(scope, id)
      await post(
        scope,
        r,
        'RESERVE',
        'reserve',
        lines.map((l) => reserveLine(r, l, dec(l.quantity))),
        lines.map((l) => ({ lineId: l.id, quantity: dec(l.quantity) })),
        null
      )
      await touch(scope, id, {
        status: 'APPROVED',
        series_id: series.id,
        number: r.number,
        approved_by: context.userId,
        approved_at: new Date(),
      })
      await audit(scope, {
        action: 'inventory.requisition.approved',
        entityType: 'stock_requisition',
        entityId: id,
        metadata: { number: r.number },
      })
      return view(scope, id)
    })
  }

  reject(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const { r } = await authorized(scope, id, 'approve', true)
      versionCheck(r, expectedVersion)
      stateCheck(r, 'reject')
      await touch(scope, id, { status: 'REJECTED', reject_reason: reason })
      await audit(scope, {
        action: 'inventory.requisition.rejected',
        entityType: 'stock_requisition',
        entityId: id,
        metadata: { reason },
      })
      return view(scope, id)
    })
  }

  pick(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const { r } = await authorized(scope, id, 'fulfil', true)
      versionCheck(r, expectedVersion)
      stateCheck(r, 'pick')
      const lines = await lineRows(scope, id)
      const given = new Map<string, any>()
      for (const x of Array.isArray(raw?.lines) ? raw.lines : [])
        if (isUuid(x?.lineId)) given.set(x.lineId, x)
      const issues: ErrorDetail[] = []
      const ups: { id: string; q: bigint }[] = []
      lines.forEach((l, i) => {
        const g = given.get(l.id)
        if (!g) return
        const q = scaled(g.pickedQuantity, SCALE)
        const f = flow(l)
        if (q === null || q > f.quantity - f.released || q < f.issued)
          return issues.push({
            path: `lines.${i}.pickedQuantity`,
            code: 'INVALID',
            message: 'Separado entre o já entregue e o pedido (menos o libertado).',
          })
        ups.push({ id: l.id, q })
      })
      fail(issues)
      if (!ups.length)
        fail([
          { path: 'lines', code: 'NOTHING_PICKED', message: 'Indique as quantidades separadas.' },
        ])
      for (const u of ups)
        await scope.trx.rawQuery(
          'update stock_requisition_lines set picked_quantity = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?',
          [txt(u.q), context.tenantId, u.id] as never[]
        )
      await touch(scope, id, {
        status: r.status === 'PARTIAL' ? 'PARTIAL' : 'PICKED',
        picked_by: context.userId,
        picked_at: new Date(),
      })
      await audit(scope, {
        action: 'inventory.requisition.picked',
        entityType: 'stock_requisition',
        entityId: id,
        metadata: { lines: ups.length },
      })
      return view(scope, id)
    })
  }

  /** Entrega (consumo): sai do stock livre e consome a reserva. */
  issue(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const key = keyCheck(raw?.idempotencyKey)
      const { r } = await authorized(scope, id, 'fulfil', true)
      if (await eventDone(scope, id, `issue-${key}`)) return view(scope, id)
      versionCheck(r, expectedVersion)
      stateCheck(r, 'issue')
      const lines = await lineRows(scope, id)
      const given = new Map<string, any>()
      for (const x of Array.isArray(raw?.lines) ? raw.lines : [])
        if (isUuid(x?.lineId)) given.set(x.lineId, x)
      const issues: ErrorDetail[] = []
      const out: { l: any; q: bigint; loc: string | null }[] = []
      const locs = await scope.trx.rawQuery(
        'select id, holds_stock from warehouse_locations where tenant_id = ? and warehouse_id = ?',
        [context.tenantId, r.warehouse_id]
      )
      const lmap = new Map((locs.rows as any[]).map((x) => [x.id as string, x]))
      lines.forEach((l, i) => {
        const g = given.get(l.id)
        if (!g) return
        const q = scaled(g.quantity, SCALE)
        if (q === null)
          return issues.push({
            path: `lines.${i}.quantity`,
            code: 'INVALID',
            message: 'Quantidade inválida.',
          })
        if (q === 0n) return
        const msg = issueIssue(q, flow(l))
        if (msg) return issues.push({ path: `lines.${i}.quantity`, code: 'INVALID', message: msg })
        // Quem atende escolhe de onde sai (por omissão, a localização da linha).
        let loc: string | null = l.source_location_id
        if (g.sourceLocationId) {
          const x = isUuid(g.sourceLocationId) ? lmap.get(g.sourceLocationId) : null
          if (!x || !x.holds_stock)
            return issues.push({
              path: `lines.${i}.sourceLocationId`,
              code: 'INVALID',
              message: 'Localização de saída inválida.',
            })
          loc = x.id
        }
        out.push({ l, q, loc })
      })
      fail(issues)
      if (!out.length)
        fail([{ path: 'lines', code: 'NOTHING_ISSUED', message: 'Indique o que foi entregue.' }])
      await post(
        scope,
        r,
        'ISSUE',
        `issue-${key}`,
        out.flatMap(({ l, q, loc }) => [
          {
            warehouseId: r.warehouse_id,
            locationId: loc,
            productId: l.product_id,
            variantId: l.variant_id,
            bucket: 'UNRESTRICTED' as const,
            quantity: `-${txt(q)}`,
          },
          { ...reserveLine(r, l, q), quantity: `-${txt(q)}` },
        ]),
        out.map(({ l, q }) => ({ lineId: l.id, quantity: q })),
        null
      )
      for (const { l, q } of out)
        await scope.trx.rawQuery(
          'update stock_requisition_lines set issued_quantity = issued_quantity + ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?',
          [txt(q), context.tenantId, l.id] as never[]
        )
      const status = statusAfterIssue((await lineRows(scope, id)).map(flow))
      await touch(scope, id, { status, completed_at: status === 'COMPLETED' ? new Date() : null })
      await audit(scope, {
        action: 'inventory.requisition.issued',
        entityType: 'stock_requisition',
        entityId: id,
        metadata: { lines: out.length, status },
      })
      return view(scope, id)
    })
  }

  /** Liberta o que ficou por entregar (motivo); a requisição fica concluída com o que foi entregue. */
  release(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const key = keyCheck(raw?.idempotencyKey)
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const { r } = await authorized(scope, id, 'fulfil', true)
      if (await eventDone(scope, id, `release-${key}`)) return view(scope, id)
      versionCheck(r, expectedVersion)
      stateCheck(r, 'release')
      const n = await releaseOpen(scope, r, `release-${key}`, reason!)
      if (!n)
        fail([{ path: 'lines', code: 'NOTHING_OPEN', message: 'Nada em aberto para libertar.' }])
      await touch(scope, id, {
        status: 'COMPLETED',
        completed_at: new Date(),
        close_reason: reason,
      })
      await audit(scope, {
        action: 'inventory.requisition.released',
        entityType: 'stock_requisition',
        entityId: id,
        metadata: { reason, lines: n },
      })
      return view(scope, id)
    })
  }

  /** Anula antes de qualquer entrega (quem pede, quem aprova ou quem atende); liberta a reserva se já havia. */
  cancel(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const { r, g } = await authorized(scope, id, 'read', true)
      if (!g.request && !g.approve && !g.fulfil)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode anular esta requisição.')
      versionCheck(r, expectedVersion)
      stateCheck(r, 'cancel')
      const lines = await lineRows(scope, id)
      if (lines.some((l) => dec(l.issued_quantity) > 0n))
        throw ApiError.conflict(
          'HAS_ISSUES',
          'Já houve entregas: liberte o resto em vez de anular.'
        )
      if (r.number) await releaseOpen(scope, r, 'cancel', reason!)
      await touch(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await audit(scope, {
        action: 'inventory.requisition.cancelled',
        entityType: 'stock_requisition',
        entityId: id,
        metadata: { reason },
      })
      return view(scope, id)
    })
  }
}

/**
 * Reservas activas: o reservado de cada armazém/produto/variante por origem (requisições, transferências e, depois,
 * vendas), derivado dos movimentos — coincide sempre com a coluna "Reservado" dos saldos.
 */
export async function activeReservations(
  context: TenantContext,
  f: {
    warehouseId?: string
    productId?: string
    sourceType?: string
    limit: number
    offset: number
  }
) {
  return runInTenant(context, async (scope) => {
    let ids = await readableWarehouseIds(scope)
    if (f.warehouseId) ids = ids.filter((i) => i === f.warehouseId)
    if (!ids.length) return { items: [], total: 0 }
    const where = ['m.tenant_id = ?', 'm.bucket = ?', 'm.warehouse_id = any(?::uuid[])']
    const params: unknown[] = [context.tenantId, 'RESERVED', ids]
    if (f.productId) {
      where.push('m.product_id = ?')
      params.push(f.productId)
    }
    if (f.sourceType) {
      where.push('s.source_type = ?')
      params.push(f.sourceType)
    }
    const base = `select s.source_type, s.source_id, m.warehouse_id, m.product_id, m.variant_id, sum(m.quantity) as qty,
        max(s.source_ref) as source_ref, max(m.occurred_at) as last_at
       from stock_movements m join stock_postings s on s.tenant_id = m.tenant_id and s.id = m.posting_id
      where ${where.join(' and ')}
      group by s.source_type, s.source_id, m.warehouse_id, m.product_id, m.variant_id having sum(m.quantity) <> 0`
    const rows = await scope.trx.rawQuery(
      `select g.*, w.code as wh_code, p.sku, p.name as product_name, v.sku as variant_sku, u.code as uom_code
         from (${base}) g
         join warehouses w on w.tenant_id = ? and w.id = g.warehouse_id
         join products p on p.tenant_id = ? and p.id = g.product_id
         join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
         left join product_variants v on v.tenant_id = ? and v.id = g.variant_id
        order by g.last_at desc limit ? offset ?`,
      [
        ...params,
        context.tenantId,
        context.tenantId,
        context.tenantId,
        f.limit,
        f.offset,
      ] as never[]
    )
    const count = await scope.trx.rawQuery(
      `select count(*)::int as n from (${base}) g`,
      params as never[]
    )
    return {
      items: (rows.rows as any[]).map((x) => ({
        source: {
          type: x.source_type as string,
          id: (x.source_id as string) ?? null,
          ref: (x.source_ref as string) ?? null,
        },
        warehouse: { id: x.warehouse_id as string, code: x.wh_code as string },
        product: {
          id: x.product_id as string,
          sku: x.sku as string,
          name: x.product_name as string,
        },
        variant: x.variant_id ? { id: x.variant_id as string, sku: x.variant_sku as string } : null,
        uom: x.uom_code as string,
        quantity: txt(dec(x.qty)),
        lastAt: x.last_at,
      })),
      total: (count.rows[0] as { n: number }).n,
    }
  })
}
