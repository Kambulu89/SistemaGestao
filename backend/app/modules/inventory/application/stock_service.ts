import { createHash } from 'node:crypto'
import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf, isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope } from '#modules/rbac/index'
import {
  available,
  BUCKETS,
  keyOf,
  PHYSICAL,
  physical,
  postingIssues,
  quantityText,
  reversalLines,
  signedQuantity,
  type BalanceQuantities,
  type Bucket,
  type PostingLine,
  type PostingType,
} from '#modules/inventory/domain/stock'
import {
  readableWarehouseIds,
  warehouseAccessFor,
} from '#modules/inventory/application/warehouse_service'

/*
 * Stock (8.3). O Inventário é o único dono dos movimentos físicos: os outros módulos (e os documentos do 8.4 em
 * diante) pedem lançamentos com `postStock`. Um lançamento é só de acréscimo; os saldos são derivados dos movimentos
 * na base (gatilho) e nunca se escrevem directamente; corrige-se com um estorno (`reverseStockPosting`) ou com um novo
 * lançamento. Cada lançamento tem uma chave de idempotência: repetir o mesmo pedido devolve o lançamento já feito.
 */

export interface PostStockLineInput {
  warehouseId: string
  locationId?: string | null
  productId: string
  variantId?: string | null
  bucket: Bucket
  /** Unidades base, com sinal, até 6 casas (texto). */
  quantity: string
}

export interface PostStockInput {
  type: PostingType
  idempotencyKey: string
  sourceType: string
  sourceId?: string | null
  sourceRef?: string | null
  reason?: string | null
  lines: PostStockLineInput[]
  /** Exige acesso de operação ao armazém (por omissão). Os módulos que integram com o inventário decidem. */
  checkAccess?: boolean
}

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const KEY = /^[A-Za-z0-9:._-]{8,100}$/
const SOURCE = /^[A-Z][A-Z0-9_]{1,29}$/

const zero = (): BalanceQuantities => ({
  unrestricted: 0n,
  blocked: 0n,
  quarantine: 0n,
  reserved: 0n,
  inTransit: 0n,
  expected: 0n,
})
const FIELD: Record<Bucket, keyof BalanceQuantities> = {
  UNRESTRICTED: 'unrestricted',
  BLOCKED: 'blocked',
  QUARANTINE: 'quarantine',
  RESERVED: 'reserved',
  IN_TRANSIT: 'inTransit',
  EXPECTED: 'expected',
}
const big = (v: unknown) => {
  const [i, f = ''] = String(v ?? '0').split('.')
  const neg = i.startsWith('-')
  const n = BigInt(neg ? i.slice(1) : i) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
  return neg ? -n : n
}
const quantities = (r: any): BalanceQuantities => ({
  unrestricted: big(r.qty_unrestricted),
  blocked: big(r.qty_blocked),
  quarantine: big(r.qty_quarantine),
  reserved: big(r.qty_reserved),
  inTransit: big(r.qty_in_transit),
  expected: big(r.qty_expected),
})
const quantitiesView = (q: BalanceQuantities) => ({
  physical: quantityText(physical(q)),
  available: quantityText(available(q)),
  unrestricted: quantityText(q.unrestricted),
  blocked: quantityText(q.blocked),
  quarantine: quantityText(q.quarantine),
  reserved: quantityText(q.reserved),
  inTransit: quantityText(q.inTransit),
  expected: quantityText(q.expected),
})

function normalizeLines(raw: unknown): { lines: PostingLine[]; issues: ErrorDetail[] } {
  const issues: ErrorDetail[] = []
  const lines: PostingLine[] = []
  if (!Array.isArray(raw))
    return { lines, issues: [{ path: 'lines', code: 'REQUIRED', message: 'Indique as linhas.' }] }
  raw.forEach((l: any, i) => {
    const q = signedQuantity(l?.quantity)
    const bad = (path: string, message: string) =>
      issues.push({ path: `lines.${i}.${path}`, code: 'INVALID', message })
    if (!isUuid(l?.warehouseId)) bad('warehouseId', 'Armazém inválido.')
    if (!isUuid(l?.productId)) bad('productId', 'Produto inválido.')
    if (l?.locationId !== null && l?.locationId !== undefined && !isUuid(l.locationId))
      bad('locationId', 'Localização inválida.')
    if (l?.variantId !== null && l?.variantId !== undefined && !isUuid(l.variantId))
      bad('variantId', 'Variante inválida.')
    if (!BUCKETS.includes(l?.bucket)) bad('bucket', 'Estado de stock inválido.')
    if (q === null)
      bad('quantity', 'Quantidade inválida (diferente de zero, até 6 casas decimais).')
    lines.push({
      warehouseId: l?.warehouseId,
      locationId: l?.locationId ?? null,
      productId: l?.productId,
      variantId: l?.variantId ?? null,
      bucket: l?.bucket,
      quantity: q ?? 0n,
    })
  })
  return { lines, issues }
}

const requestHash = (input: object) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex')

/** Armazéns, produtos, variantes e localizações das linhas: existência, acesso, tipo e casas decimais. */
async function checkRefs(scope: TenantScope, lines: PostingLine[], checkAccess: boolean) {
  const { tenantId } = scope.context
  const issues: ErrorDetail[] = []
  const increases = (l: PostingLine) => l.quantity > 0n && l.bucket !== 'RESERVED'
  const warehouses = new Map<string, { status: string }>()
  const ids = [...new Set(lines.map((l) => l.warehouseId))]
  if (checkAccess)
    for (const id of ids) {
      const a = await warehouseAccessFor(scope, id)
      if (!a) throw ApiError.notFound()
      if (!a.operate)
        throw ApiError.forbidden('NO_OPERATE', 'Não tem acesso para operar neste armazém.')
      warehouses.set(id, a)
    }
  else {
    // O módulo que chama autorizou cada passo (ex.: a expedição intragrupo toca o armazém de destino, que quem expede
    // pode não ver); aqui só se confirma que o armazém existe na empresa.
    const r = await scope.trx.rawQuery(
      'select id, status from warehouses where tenant_id = ? and id = any(?::uuid[])',
      [tenantId, ids] as never[]
    )
    for (const w of r.rows as any[]) warehouses.set(w.id, { status: w.status })
    if (warehouses.size !== ids.length) throw ApiError.notFound()
  }
  const products = await scope.trx.rawQuery(
    `select p.id, p.sku, p.product_type, u.decimals,
        exists (select 1 from product_variants v where v.tenant_id = p.tenant_id and v.product_id = p.id) as has_variants
       from products p join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
      where p.tenant_id = ? and p.id = any(?::uuid[])`,
    [tenantId, [...new Set(lines.map((l) => l.productId))]] as never[]
  )
  const pmap = new Map((products.rows as any[]).map((p) => [p.id as string, p]))
  const variantIds = [...new Set(lines.map((l) => l.variantId).filter(Boolean))] as string[]
  const variants = variantIds.length
    ? await scope.trx.rawQuery(
        `select id, product_id from product_variants where tenant_id = ? and id = any(?::uuid[])`,
        [tenantId, variantIds] as never[]
      )
    : { rows: [] }
  const vmap = new Map(
    (variants.rows as any[]).map((v) => [v.id as string, v.product_id as string])
  )
  const locationIds = [...new Set(lines.map((l) => l.locationId).filter(Boolean))] as string[]
  const locations = locationIds.length
    ? await scope.trx.rawQuery(
        `select id, warehouse_id, holds_stock, status, path_code from warehouse_locations
          where tenant_id = ? and id = any(?::uuid[])`,
        [tenantId, locationIds] as never[]
      )
    : { rows: [] }
  const lmap = new Map((locations.rows as any[]).map((l) => [l.id as string, l]))
  lines.forEach((l, i) => {
    const at = (path: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${path}`, code, message })
    const w = warehouses.get(l.warehouseId)!
    if (increases(l) && w.status !== 'ACTIVE')
      at('warehouseId', 'INACTIVE', 'O armazém está inactivo: não recebe stock.')
    const p = pmap.get(l.productId)
    if (!p) return at('productId', 'NOT_FOUND', 'Produto não encontrado.')
    if (p.product_type !== 'STOCKABLE')
      return at('productId', 'NOT_STOCKABLE', `${p.sku} não é armazenável: não movimenta stock.`)
    if (l.variantId) {
      if (vmap.get(l.variantId) !== l.productId)
        at('variantId', 'NOT_FOUND', 'A variante não é deste produto.')
    } else if (p.has_variants)
      at('variantId', 'REQUIRED', `${p.sku} tem variantes: o stock conta-se por variante.`)
    const abs = l.quantity < 0n ? -l.quantity : l.quantity
    if (abs % 10n ** BigInt(6 - Number(p.decimals)) !== 0n)
      at('quantity', 'DECIMALS', `A unidade base de ${p.sku} aceita ${p.decimals} casas decimais.`)
    if (l.locationId) {
      const loc = lmap.get(l.locationId)
      if (!loc || loc.warehouse_id !== l.warehouseId)
        return at('locationId', 'NOT_FOUND', 'A localização não é deste armazém.')
      if (!loc.holds_stock) at('locationId', 'NOT_HOLDING', `${loc.path_code} não guarda stock.`)
      else if (increases(l) && loc.status !== 'ACTIVE')
        at('locationId', 'INACTIVE', `${loc.path_code} está inactiva: não recebe stock.`)
    }
  })
  fail(issues)
  return pmap
}

/**
 * Bloqueia (até ao fim da transacção) cada armazém/produto/variante tocado, por ordem, e verifica os saldos que
 * resultariam: nenhum balde negativo por saldo e reservado ≤ livre no armazém. A base de dados repete a verificação.
 */
async function lockAndCheck(scope: TenantScope, lines: PostingLine[], pmap: Map<string, any>) {
  const { tenantId } = scope.context
  const groups = [
    ...new Set(lines.map((l) => `${l.warehouseId}|${l.productId}|${l.variantId ?? ''}`)),
  ].sort()
  for (const g of groups)
    await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `stock:${tenantId}:${g}`,
    ])
  const rows = await scope.trx.rawQuery(
    `select * from stock_balances b where b.tenant_id = ?
       and (b.warehouse_id::text || '|' || b.product_id::text || '|' || coalesce(b.variant_id::text, '')) = any(?::text[])`,
    [tenantId, groups] as never[]
  )
  const balances = new Map<string, BalanceQuantities>()
  for (const r of rows.rows as any[])
    balances.set(
      keyOf({
        warehouseId: r.warehouse_id,
        locationId: r.location_id,
        productId: r.product_id,
        variantId: r.variant_id,
      }),
      quantities(r)
    )
  for (const l of lines) {
    const k = keyOf(l)
    const b = balances.get(k) ?? zero()
    b[FIELD[l.bucket]] += l.quantity
    balances.set(k, b)
  }
  const issues: ErrorDetail[] = []
  const touched = new Set(lines.map(keyOf))
  for (const [k, b] of balances) {
    if (!touched.has(k)) continue
    for (const bucket of BUCKETS)
      if (b[FIELD[bucket]] < 0n) {
        const [, , productId] = k.split('|')
        const before =
          b[FIELD[bucket]] -
          lines
            .filter((l) => keyOf(l) === k && l.bucket === bucket)
            .reduce((s, l) => s + l.quantity, 0n)
        issues.push({
          path: 'lines',
          code: 'INSUFFICIENT_STOCK',
          message: `Stock insuficiente de ${pmap.get(productId)?.sku ?? 'produto'} (${bucket}): há ${quantityText(before)}.`,
        })
      }
  }
  const free = new Map<string, bigint>()
  for (const [k, b] of balances) {
    const [w, , p, v] = k.split('|')
    const g = `${w}|${p}|${v}`
    free.set(g, (free.get(g) ?? 0n) + b.unrestricted - b.reserved)
  }
  for (const [g, f] of free)
    if (f < 0n)
      issues.push({
        path: 'lines',
        code: 'OVER_RESERVED',
        message: `O reservado de ${pmap.get(g.split('|')[1])?.sku ?? 'produto'} excederia o stock livre do armazém.`,
      })
  if (issues.length) throw new ApiError(409, issues[0].code, issues[0].message, issues)
}

async function insertPosting(
  scope: TenantScope,
  head: {
    type: PostingType
    key: string
    hash: string
    sourceType: string
    sourceId: string | null
    sourceRef: string | null
    reason: string | null
    reversalOf: string | null
  },
  lines: PostingLine[]
) {
  const { tenantId, userId } = scope.context
  let r
  try {
    r = await scope.trx.rawQuery(
      `insert into stock_postings (tenant_id, posting_type, idempotency_key, request_hash, source_type, source_id,
          source_ref, reason, reversal_of_id, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, idempotency_key) do nothing returning id, occurred_at`,
      [
        tenantId,
        head.type,
        head.key,
        head.hash,
        head.sourceType,
        head.sourceId,
        head.sourceRef,
        head.reason,
        head.reversalOf,
        userId,
        userId,
      ] as never[]
    )
  } catch (error) {
    if (constraintOf(error) === 'stock_postings_reversal_unique')
      throw ApiError.conflict('ALREADY_REVERSED', 'Este lançamento já foi estornado.')
    throw error
  }
  const row = r.rows[0] as { id: string; occurred_at: Date } | undefined
  if (!row) return null // Outro pedido com a mesma chave acabou de gravar.
  const values: unknown[] = []
  lines.forEach((l, i) =>
    values.push(
      tenantId,
      row.id,
      i + 1,
      l.warehouseId,
      l.locationId,
      l.productId,
      l.variantId,
      l.bucket,
      quantityText(l.quantity),
      row.occurred_at,
      userId,
      userId
    )
  )
  await scope.trx.rawQuery(
    `insert into stock_movements (tenant_id, posting_id, line_no, warehouse_id, location_id, product_id, variant_id,
        bucket, quantity, occurred_at, created_by, updated_by)
     values ${lines.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    values as never[]
  )
  // A base verifica o reservado ≤ livre no fim da transacção; aqui pede-se já, para o erro vir deste pedido.
  try {
    await scope.trx.rawQuery('set constraints stock_balances_reserved immediate')
    await scope.trx.rawQuery('set constraints stock_balances_reserved deferred')
  } catch (error) {
    if (String((error as Error).message).includes('STOCK_OVER_RESERVED'))
      throw ApiError.conflict('OVER_RESERVED', 'O reservado excederia o stock livre do armazém.')
    throw error
  }
  await audit(scope, {
    action: head.reversalOf ? 'inventory.stock.reversed' : 'inventory.stock.posted',
    entityType: 'stock_posting',
    entityId: row.id,
    metadata: {
      type: head.type,
      sourceType: head.sourceType,
      sourceId: head.sourceId,
      reversalOf: head.reversalOf,
      lines: lines.length,
    },
  })
  return row.id
}

async function existing(scope: TenantScope, key: string) {
  const r = await scope.trx.rawQuery(
    'select id, request_hash from stock_postings where tenant_id = ? and idempotency_key = ?',
    [scope.context.tenantId, key]
  )
  return (r.rows[0] as { id: string; request_hash: string } | undefined) ?? null
}

const replay = (e: { id: string; request_hash: string }, hash: string) => {
  if (e.request_hash !== hash)
    throw ApiError.conflict(
      'IDEMPOTENCY_MISMATCH',
      'Esta chave de idempotência já foi usada num pedido diferente.'
    )
  return e.id
}

/** Repetição: só mostra as linhas dos armazéns que o membro pode consultar. */
const replayView = async (scope: TenantScope, id: string) =>
  postingView(scope, id, new Set(await readableWarehouseIds(scope)))

/** Lança stock (contrato do módulo). Devolve o lançamento e se foi uma repetição de um pedido já feito. */
export async function postStock(scope: TenantScope, input: PostStockInput) {
  const issues: ErrorDetail[] = []
  if (typeof input.idempotencyKey !== 'string' || !KEY.test(input.idempotencyKey))
    issues.push({
      path: 'idempotencyKey',
      code: 'INVALID',
      message: 'Chave de idempotência inválida.',
    })
  if (typeof input.sourceType !== 'string' || !SOURCE.test(input.sourceType))
    issues.push({ path: 'sourceType', code: 'INVALID', message: 'Origem inválida.' })
  if (input.sourceId !== null && input.sourceId !== undefined && !isUuid(input.sourceId))
    issues.push({ path: 'sourceId', code: 'INVALID', message: 'Origem inválida.' })
  const { lines, issues: lineIssues } = normalizeLines(input.lines)
  fail([...issues, ...lineIssues])
  fail(postingIssues(input.type, lines))
  const head = {
    type: input.type,
    key: input.idempotencyKey,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    sourceRef: input.sourceRef?.trim().slice(0, 60) || null,
    reason: input.reason?.trim().slice(0, 300) || null,
    reversalOf: null,
  }
  const hash = requestHash({
    type: head.type,
    sourceType: head.sourceType,
    sourceId: head.sourceId,
    lines: lines.map((l) => ({ ...l, quantity: quantityText(l.quantity) })),
  })
  const before = await existing(scope, head.key)
  if (before) return { posting: await replayView(scope, replay(before, hash)), replayed: true }
  const pmap = await checkRefs(scope, lines, input.checkAccess !== false)
  await lockAndCheck(scope, lines, pmap)
  const id = await insertPosting(scope, { ...head, hash }, lines)
  if (!id) {
    const e = (await existing(scope, head.key))!
    return { posting: await replayView(scope, replay(e, hash)), replayed: true }
  }
  return { posting: await postingView(scope, id), replayed: false }
}

/** Estorna um lançamento: novo lançamento com as quantidades inversas (o original nunca muda). */
export async function reverseStockPosting(
  scope: TenantScope,
  postingId: string,
  input: { idempotencyKey: string; reason: string; checkAccess?: boolean }
) {
  if (typeof input.idempotencyKey !== 'string' || !KEY.test(input.idempotencyKey))
    fail([{ path: 'idempotencyKey', code: 'INVALID', message: 'Chave de idempotência inválida.' }])
  if (!input.reason?.trim())
    fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo do estorno.' }])
  if (!isUuid(postingId)) throw ApiError.notFound()
  const { tenantId } = scope.context
  const h = await scope.trx.rawQuery(
    'select * from stock_postings where tenant_id = ? and id = ?',
    [tenantId, postingId]
  )
  const original = h.rows[0] as any
  if (!original) throw ApiError.notFound()
  const hash = requestHash({ reversalOf: postingId })
  const before = await existing(scope, input.idempotencyKey)
  if (before) return { posting: await replayView(scope, replay(before, hash)), replayed: true }
  if (original.posting_type === 'REVERSAL')
    throw ApiError.conflict(
      'REVERSAL_OF_REVERSAL',
      'Um estorno não se estorna: faça um novo lançamento.'
    )
  const done = await scope.trx.rawQuery(
    'select 1 from stock_postings where tenant_id = ? and reversal_of_id = ?',
    [tenantId, postingId]
  )
  if (done.rows.length)
    throw ApiError.conflict('ALREADY_REVERSED', 'Este lançamento já foi estornado.')
  const m = await scope.trx.rawQuery(
    'select * from stock_movements where tenant_id = ? and posting_id = ? order by line_no',
    [tenantId, postingId]
  )
  const lines = reversalLines(
    (m.rows as any[]).map((r) => ({
      warehouseId: r.warehouse_id,
      locationId: r.location_id,
      productId: r.product_id,
      variantId: r.variant_id,
      bucket: r.bucket,
      quantity: big(r.quantity),
    }))
  )
  const pmap = await checkRefs(scope, lines, input.checkAccess !== false)
  await lockAndCheck(scope, lines, pmap)
  const id = await insertPosting(
    scope,
    {
      type: 'REVERSAL',
      key: input.idempotencyKey,
      hash,
      sourceType: original.source_type,
      sourceId: original.source_id,
      sourceRef: original.source_ref,
      reason: input.reason.trim().slice(0, 300),
      reversalOf: postingId,
    },
    lines
  )
  if (!id) {
    const e = (await existing(scope, input.idempotencyKey))!
    return { posting: await replayView(scope, replay(e, hash)), replayed: true }
  }
  return { posting: await postingView(scope, id), replayed: false }
}

const MOVE_SELECT = `select m.*, p.sku, p.name as product_name, v.sku as variant_sku, w.code as warehouse_code,
    l.path_code, u.code as uom_code
  from stock_movements m
  join products p on p.tenant_id = m.tenant_id and p.id = m.product_id
  join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
  join warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
  left join product_variants v on v.tenant_id = m.tenant_id and v.id = m.variant_id
  left join warehouse_locations l on l.tenant_id = m.tenant_id and l.id = m.location_id`

const lineView = (r: any) => ({
  id: r.id as string,
  lineNo: Number(r.line_no),
  warehouse: { id: r.warehouse_id as string, code: r.warehouse_code as string },
  location: r.location_id ? { id: r.location_id as string, pathCode: r.path_code as string } : null,
  product: { id: r.product_id as string, sku: r.sku as string, name: r.product_name as string },
  variant: r.variant_id ? { id: r.variant_id as string, sku: r.variant_sku as string } : null,
  uom: r.uom_code as string,
  bucket: r.bucket as Bucket,
  quantity: quantityText(big(r.quantity)),
})

async function postingView(scope: TenantScope, id: string, readable?: Set<string>) {
  const { tenantId } = scope.context
  const h = await scope.trx.rawQuery(
    `select s.*, u.full_name as created_by_name, rv.id as reversed_by_id
       from stock_postings s
       left join users u on u.id = s.created_by
       left join stock_postings rv on rv.tenant_id = s.tenant_id and rv.reversal_of_id = s.id
      where s.tenant_id = ? and s.id = ?`,
    [tenantId, id]
  )
  const s = h.rows[0] as any
  if (!s) throw ApiError.notFound()
  const m = await scope.trx.rawQuery(
    `${MOVE_SELECT} where m.tenant_id = ? and m.posting_id = ? order by m.line_no`,
    [tenantId, id]
  )
  const lines = (m.rows as any[])
    .filter((r) => !readable || readable.has(r.warehouse_id))
    .map(lineView)
  if (readable && !lines.length) throw ApiError.notFound()
  return {
    id: s.id as string,
    type: s.posting_type as PostingType,
    idempotencyKey: s.idempotency_key as string,
    source: {
      type: s.source_type as string,
      id: (s.source_id as string) ?? null,
      ref: (s.source_ref as string) ?? null,
    },
    reason: (s.reason as string) ?? null,
    reversalOf: (s.reversal_of_id as string) ?? null,
    reversedBy: (s.reversed_by_id as string) ?? null,
    occurredAt: s.occurred_at,
    createdBy: (s.created_by_name as string) ?? null,
    lines,
  }
}

const STATUS_BUCKETS = ['UNRESTRICTED', 'BLOCKED', 'QUARANTINE'] as const

export class StockService {
  balances(
    context: TenantContext,
    f: {
      warehouseId?: string
      productId?: string
      q?: string
      nonZero?: boolean
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const ids = await readableWarehouseIds(scope)
      if (!ids.length) return { items: [], total: 0 }
      const where = ['b.tenant_id = ?', 'b.warehouse_id = any(?::uuid[])']
      const params: unknown[] = [context.tenantId, ids]
      if (f.warehouseId) {
        where.push('b.warehouse_id = ?')
        params.push(f.warehouseId)
      }
      if (f.productId) {
        where.push('b.product_id = ?')
        params.push(f.productId)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(
          "(lower(p.sku) like ? or lower(p.name) like ? or lower(coalesce(v.sku, '')) like ?)"
        )
        params.push(like, like, like)
      }
      if (f.nonZero !== false)
        where.push(
          '(b.qty_unrestricted <> 0 or b.qty_blocked <> 0 or b.qty_quarantine <> 0 or b.qty_reserved <> 0 or b.qty_in_transit <> 0 or b.qty_expected <> 0)'
        )
      const from = `from stock_balances b
        join products p on p.tenant_id = b.tenant_id and p.id = b.product_id
        join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
        join warehouses w on w.tenant_id = b.tenant_id and w.id = b.warehouse_id
        left join product_variants v on v.tenant_id = b.tenant_id and v.id = b.variant_id
        left join warehouse_locations l on l.tenant_id = b.tenant_id and l.id = b.location_id
        where ${where.join(' and ')}`
      const rows = await scope.trx.rawQuery(
        `select b.*, p.sku, p.name as product_name, u.code as uom_code, u.decimals as uom_decimals, v.sku as variant_sku, w.code as warehouse_code,
            w.name as warehouse_name, l.path_code
         ${from} order by p.sku, v.sku nulls first, w.code, l.path_code nulls first limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[])
      return {
        items: (rows.rows as any[]).map((r) => ({
          id: r.id as string,
          version: Number(r.version),
          warehouse: { id: r.warehouse_id, code: r.warehouse_code, name: r.warehouse_name },
          location: r.location_id ? { id: r.location_id, pathCode: r.path_code } : null,
          product: { id: r.product_id, sku: r.sku, name: r.product_name },
          variant: r.variant_id ? { id: r.variant_id, sku: r.variant_sku } : null,
          uom: r.uom_code as string,
          uomDecimals: Number(r.uom_decimals),
          ...quantitiesView(quantities(r)),
          lastMovementAt: r.last_movement_at,
        })),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  movements(
    context: TenantContext,
    f: {
      warehouseId?: string
      productId?: string
      variantId?: string
      type?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const ids = await readableWarehouseIds(scope)
      if (!ids.length) return { items: [], total: 0 }
      const where = ['m.tenant_id = ?', 'm.warehouse_id = any(?::uuid[])']
      const params: unknown[] = [context.tenantId, ids]
      for (const [k, col] of [
        ['warehouseId', 'm.warehouse_id'],
        ['productId', 'm.product_id'],
        ['variantId', 'm.variant_id'],
        ['type', 's.posting_type'],
      ] as const)
        if (f[k]) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      const cl = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `select x.*, s.posting_type, s.source_type, s.source_ref, s.reason, s.reversal_of_id, us.full_name as user_name
           from (${MOVE_SELECT}) x
           join stock_postings s on s.tenant_id = x.tenant_id and s.id = x.posting_id
           left join users us on us.id = s.created_by
          where ${cl.replaceAll('m.', 'x.')}
          order by x.occurred_at desc, x.posting_id, x.line_no limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from stock_movements m
           join stock_postings s on s.tenant_id = m.tenant_id and s.id = m.posting_id where ${cl}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map((r) => ({
          ...lineView(r),
          postingId: r.posting_id as string,
          type: r.posting_type as PostingType,
          source: { type: r.source_type as string, ref: (r.source_ref as string) ?? null },
          reason: (r.reason as string) ?? null,
          reversalOf: (r.reversal_of_id as string) ?? null,
          occurredAt: r.occurred_at,
          user: (r.user_name as string) ?? null,
        })),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  posting(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(id)) throw ApiError.notFound()
      return postingView(scope, id, new Set(await readableWarehouseIds(scope)))
    })
  }

  /** Livre ↔ bloqueado ↔ quarentena, sem mudar o físico; exige `inventory.stock.manage` no âmbito do armazém. */
  changeStatus(
    context: TenantContext,
    v: {
      warehouseId: string
      locationId?: string | null
      productId: string
      variantId?: string | null
      from: string
      to: string
      quantity: string
      reason: string
      idempotencyKey: string
    }
  ) {
    return runInTenant(context, async (scope) => {
      const issues: ErrorDetail[] = []
      if (!STATUS_BUCKETS.includes(v.from as never))
        issues.push({ path: 'from', code: 'INVALID', message: 'Estado de origem inválido.' })
      if (!STATUS_BUCKETS.includes(v.to as never) || v.to === v.from)
        issues.push({
          path: 'to',
          code: 'INVALID',
          message: 'Escolha um estado de destino diferente.',
        })
      const q = signedQuantity(v.quantity)
      if (q === null || q < 0n)
        issues.push({
          path: 'quantity',
          code: 'INVALID',
          message: 'Quantidade positiva, até 6 casas.',
        })
      if (!v.reason?.trim())
        issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' })
      fail(issues)
      const a = await warehouseAccessFor(scope, v.warehouseId)
      if (!a) throw ApiError.notFound()
      const manage = await permissionScope(scope, 'inventory.stock.manage')
      const covered =
        manage.tenant ||
        manage.legalEntityIds.has(a.legalEntityId) ||
        (!!a.branchId && manage.branchIds.has(a.branchId))
      if (!covered) throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere o stock deste armazém.')
      const base = {
        warehouseId: v.warehouseId,
        locationId: v.locationId ?? null,
        productId: v.productId,
        variantId: v.variantId ?? null,
      }
      const qty = quantityText(q!)
      const r = await postStock(scope, {
        type: 'STATUS_CHANGE',
        idempotencyKey: v.idempotencyKey,
        sourceType: 'STOCK_STATUS',
        reason: v.reason,
        lines: [
          { ...base, bucket: v.from as Bucket, quantity: `-${qty}` },
          { ...base, bucket: v.to as Bucket, quantity: qty },
        ],
      })
      return r.posting
    })
  }

  /** Confere cada saldo com a soma dos movimentos (deve dar sempre zero diferenças). */
  reconciliation(context: TenantContext, f: { warehouseId?: string }) {
    return runInTenant(context, async (scope) => {
      let ids = await readableWarehouseIds(scope)
      if (f.warehouseId) ids = ids.filter((i) => i === f.warehouseId)
      if (!ids.length) return { checked: 0, differences: [] }
      const sums = PHYSICAL.concat(['RESERVED', 'IN_TRANSIT', 'EXPECTED'])
        .map(
          (bk) =>
            `coalesce(sum(quantity) filter (where bucket = '${bk}'), 0) as qty_${bk.toLowerCase()}`
        )
        .join(', ')
      const cols = ['unrestricted', 'blocked', 'quarantine', 'reserved', 'in_transit', 'expected']
      const r = await scope.trx.rawQuery(
        `with m as (
           select warehouse_id, location_id, product_id, variant_id, ${sums}
             from stock_movements where tenant_id = ? and warehouse_id = any(?::uuid[])
            group by warehouse_id, location_id, product_id, variant_id),
         b as (select * from stock_balances where tenant_id = ? and warehouse_id = any(?::uuid[]))
         select coalesce(m.warehouse_id, b.warehouse_id) as warehouse_id,
                coalesce(m.location_id, b.location_id) as location_id,
                coalesce(m.product_id, b.product_id) as product_id,
                coalesce(m.variant_id, b.variant_id) as variant_id,
                ${cols.map((c) => `coalesce(m.qty_${c}, 0) as m_${c}, coalesce(b.qty_${c}, 0) as b_${c}`).join(', ')}
           from m full join b on b.warehouse_id = m.warehouse_id and b.product_id = m.product_id
             and b.location_id is not distinct from m.location_id and b.variant_id is not distinct from m.variant_id`,
        [context.tenantId, ids, context.tenantId, ids] as never[]
      )
      const differences = (r.rows as any[])
        .filter((x) => cols.some((c) => big(x[`m_${c}`]) !== big(x[`b_${c}`])))
        .map((x) => ({
          warehouseId: x.warehouse_id as string,
          locationId: (x.location_id as string) ?? null,
          productId: x.product_id as string,
          variantId: (x.variant_id as string) ?? null,
          movements: Object.fromEntries(cols.map((c) => [c, quantityText(big(x[`m_${c}`]))])),
          balance: Object.fromEntries(cols.map((c) => [c, quantityText(big(x[`b_${c}`]))])),
        }))
      return { checked: r.rows.length, differences }
    })
  }
}
