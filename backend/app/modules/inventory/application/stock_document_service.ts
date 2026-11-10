import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope } from '#modules/rbac/index'
import { legalEntityFacts } from '#modules/organization/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import { fitsDecimals, scaled, scaledText, toBase } from '#modules/inventory/domain/catalog'
import {
  CAN,
  checkedIssue,
  DOC_TYPES,
  isLotCode,
  LINE_BUCKETS,
  lineIssues,
  normalizeSerials,
  ORIGINS,
  SERIES_TYPE,
  statusFrom,
  type DocStatus,
  type DocType,
} from '#modules/inventory/domain/documents'
import {
  readableWarehouseIds,
  warehouseAccessFor,
} from '#modules/inventory/application/warehouse_service'
import { postStock, reverseStockPosting } from '#modules/inventory/application/stock_service'

/*
 * Entradas e saídas (8.4). O documento prepara o movimento; o stock só muda na confirmação, sempre por `postStock`
 * (idempotente, com as regras e bloqueios do 8.3). Gerir (`inventory.documents.manage`: criar, editar, conferir,
 * reabrir, anular) e confirmar (`inventory.documents.confirm`: confirmar, fechar saldo, estornar) seguem o âmbito do
 * armazém (entidade legal ou filial) e exigem acesso de operação; consultar segue o acesso aos armazéns.
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

type Need = 'read' | 'manage' | 'confirm'
const PERM: Record<Exclude<Need, 'read'>, string> = {
  manage: 'inventory.documents.manage',
  confirm: 'inventory.documents.confirm',
}

async function rights(scope: TenantScope, warehouseId: string) {
  const a = await warehouseAccessFor(scope, warehouseId)
  if (!a) return null
  const covers = async (perm: string) => {
    const s = await permissionScope(scope, perm)
    return (
      s.tenant ||
      s.legalEntityIds.has(a.legalEntityId) ||
      (!!a.branchId && s.branchIds.has(a.branchId))
    )
  }
  return {
    access: a,
    manage: a.operate && (await covers(PERM.manage)),
    confirm: a.operate && (await covers(PERM.confirm)),
  }
}

async function authorize(scope: TenantScope, warehouseId: string, need: Need) {
  const r = await rights(scope, warehouseId)
  if (!r) throw ApiError.notFound()
  if (need === 'read') return r
  if (!r.access.operate)
    throw ApiError.forbidden('NO_OPERATE', 'Não tem acesso para operar neste armazém.')
  if (!r[need])
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      need === 'manage'
        ? 'Não gere documentos de stock deste armazém.'
        : 'Não confirma documentos de stock deste armazém.'
    )
  return r
}

async function loadDoc(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select *, document_date::text as date_text from stock_documents where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  const d = r.rows[0] as any
  if (!d) throw ApiError.notFound()
  return d
}

const versionCheck = (d: any, expected: number) => {
  if (Number(d.version) !== expected) throw ApiError.versionConflict(Number(d.version))
}
const stateCheck = (d: any, action: keyof typeof CAN) => {
  if (!CAN[action].includes(d.status))
    throw ApiError.conflict('INVALID_STATE', `Não é possível nesta fase (${d.status}).`)
}

interface NormLine {
  productId: string
  variantId: string | null
  uomId: string
  factor: bigint
  quantity: bigint
  baseQuantity: bigint
  locationId: string | null
  bucket: string
  lotCode: string | null
  serials: string[]
  expiryDate: string | null
  unitCost: bigint | null
}

/** Valida e normaliza as linhas contra o catálogo e o armazém. */
async function normalizeLines(
  scope: TenantScope,
  docType: DocType,
  warehouseId: string,
  raw: unknown
): Promise<NormLine[]> {
  const t = scope.context.tenantId
  if (!Array.isArray(raw) || !raw.length)
    fail([
      { path: 'lines', code: 'REQUIRED', message: 'O documento precisa de pelo menos uma linha.' },
    ])
  const input = raw as any[]
  if (input.length > 300)
    fail([{ path: 'lines', code: 'LENGTH', message: 'No máximo 300 linhas por documento.' }])
  const pids = [...new Set(input.map((l) => l?.productId).filter(isUuid))]
  const products = pids.length
    ? await scope.trx.rawQuery(
        `select p.id, p.sku, p.product_type, p.status, p.base_uom_id, p.track_lots, p.track_serials, p.track_expiry,
            exists (select 1 from product_variants v where v.tenant_id = p.tenant_id and v.product_id = p.id) as has_variants,
            bu.decimals as base_decimals
           from products p join uoms bu on bu.tenant_id = p.tenant_id and bu.id = p.base_uom_id
          where p.tenant_id = ? and p.id = any(?::uuid[])`,
        [t, pids] as never[]
      )
    : { rows: [] }
  const pmap = new Map((products.rows as any[]).map((p) => [p.id as string, p]))
  const conv = pids.length
    ? await scope.trx.rawQuery(
        `select c.product_id, c.uom_id, c.factor::text as factor from product_uom_conversions c
          where c.tenant_id = ? and c.product_id = any(?::uuid[])`,
        [t, pids] as never[]
      )
    : { rows: [] }
  const factors = new Map(
    (conv.rows as any[]).map((c) => [`${c.product_id}|${c.uom_id}`, dec(c.factor)])
  )
  const uids = [...new Set(input.map((l) => l?.uomId).filter(isUuid))]
  const uoms = uids.length
    ? await scope.trx.rawQuery(
        'select id, code, decimals from uoms where tenant_id = ? and id = any(?::uuid[])',
        [t, uids] as never[]
      )
    : { rows: [] }
  const umap = new Map((uoms.rows as any[]).map((u) => [u.id as string, u]))
  const vids = [...new Set(input.map((l) => l?.variantId).filter(isUuid))]
  const variants = vids.length
    ? await scope.trx.rawQuery(
        'select id, product_id, status from product_variants where tenant_id = ? and id = any(?::uuid[])',
        [t, vids] as never[]
      )
    : { rows: [] }
  const vmap = new Map((variants.rows as any[]).map((v) => [v.id as string, v]))
  const locs = await scope.trx.rawQuery(
    'select id, path_code, holds_stock, status from warehouse_locations where tenant_id = ? and warehouse_id = ?',
    [t, warehouseId]
  )
  const lmap = new Map((locs.rows as any[]).map((l) => [l.id as string, l]))

  const issues: ErrorDetail[] = []
  const out: NormLine[] = []
  input.forEach((l, i) => {
    const at = `lines.${i}`
    const add = (path: string, code: string, message: string) =>
      issues.push({ path: `${at}.${path}`, code, message })
    const p = isUuid(l?.productId) ? pmap.get(l.productId) : null
    if (!p) return add('productId', 'NOT_FOUND', 'Produto não encontrado.')
    if (p.product_type !== 'STOCKABLE')
      return add('productId', 'NOT_STOCKABLE', `${p.sku} não é armazenável: não movimenta stock.`)
    if (docType === 'RECEIPT' && p.status !== 'ACTIVE')
      add('productId', 'INACTIVE', `${p.sku} não está activo: não recebe stock.`)
    let variantId: string | null = null
    if (l?.variantId) {
      const v = isUuid(l.variantId) ? vmap.get(l.variantId) : null
      if (!v || v.product_id !== p.id)
        add('variantId', 'NOT_FOUND', 'A variante não é deste produto.')
      else variantId = v.id
    } else if (p.has_variants)
      add('variantId', 'REQUIRED', `${p.sku} tem variantes: escolha a variante.`)
    const uom = isUuid(l?.uomId) ? umap.get(l.uomId) : null
    let factor: bigint | null = null
    if (!uom) add('uomId', 'NOT_FOUND', 'Unidade não encontrada.')
    else if (uom.id === p.base_uom_id) factor = 1_000_000n
    else {
      factor = factors.get(`${p.id}|${uom.id}`) ?? null
      if (factor === null)
        add('uomId', 'NO_CONVERSION', `${p.sku} não tem conversão para ${uom.code}.`)
    }
    const quantity = scaled(l?.quantity, SCALE)
    let base = 0n
    if (quantity === null || quantity === 0n)
      add('quantity', 'INVALID', 'Quantidade positiva, até 6 casas decimais.')
    else if (uom && !fitsDecimals(quantity, Number(uom.decimals)))
      add('quantity', 'DECIMALS', `${uom.code} aceita ${uom.decimals} casas decimais.`)
    else if (factor !== null) {
      base = toBase(quantity, factor)
      if (!fitsDecimals(base, Number(p.base_decimals)))
        add(
          'quantity',
          'BASE_DECIMALS',
          `Em unidades base dá ${txt(base)}, com casas a mais para a unidade base.`
        )
    }
    let locationId: string | null = null
    if (l?.locationId) {
      const loc = isUuid(l.locationId) ? lmap.get(l.locationId) : null
      if (!loc) add('locationId', 'NOT_FOUND', 'A localização não é deste armazém.')
      else if (!loc.holds_stock)
        add('locationId', 'NOT_HOLDING', `${loc.path_code} não guarda stock.`)
      else if (docType === 'RECEIPT' && loc.status !== 'ACTIVE')
        add('locationId', 'INACTIVE', `${loc.path_code} está inactiva.`)
      else locationId = loc.id
    }
    const bucket = l?.bucket ?? 'UNRESTRICTED'
    if (!LINE_BUCKETS.includes(bucket)) add('bucket', 'INVALID', 'Estado do stock inválido.')
    const lotCode = l?.lotCode ? String(l.lotCode).trim() : null
    if (lotCode && !isLotCode(lotCode))
      add('lotCode', 'INVALID', 'Lote: letras, dígitos, . _ / -, até 40.')
    const serials = normalizeSerials(l?.serials)
    if (serials === null) add('serials', 'INVALID', 'Números de série sem vazios nem repetidos.')
    const expiryDate = l?.expiryDate ? String(l.expiryDate) : null
    if (expiryDate && !DATE.test(expiryDate)) add('expiryDate', 'INVALID', 'Data inválida.')
    let unitCost: bigint | null = null
    if (l?.unitCost !== null && l?.unitCost !== undefined && l?.unitCost !== '') {
      unitCost = scaled(l.unitCost, SCALE)
      if (unitCost === null) add('unitCost', 'INVALID', 'Custo unitário ≥ 0, até 6 casas.')
    }
    issues.push(
      ...lineIssues(
        {
          docType,
          trackLots: Boolean(p.track_lots),
          trackSerials: Boolean(p.track_serials),
          trackExpiry: Boolean(p.track_expiry),
          lotCode,
          serials: serials ?? [],
          expiryDate,
          baseQuantity: base,
          unitCost,
        },
        at
      )
    )
    out.push({
      productId: p.id,
      variantId,
      uomId: uom?.id,
      factor: factor ?? 0n,
      quantity: quantity ?? 0n,
      baseQuantity: base,
      locationId,
      bucket,
      lotCode,
      serials: serials ?? [],
      expiryDate,
      unitCost,
    })
  })
  // Números de série únicos no documento.
  const seen = new Map<string, number>()
  out.forEach((l, i) =>
    l.serials.forEach((s) => {
      const k = `${l.productId}|${s.toUpperCase()}`
      if (seen.has(k) && seen.get(k) !== i)
        issues.push({
          path: `lines.${i}.serials`,
          code: 'SERIAL_DUPLICATE',
          message: `Série ${s} repetida.`,
        })
      seen.set(k, i)
    })
  )
  fail(issues)
  return out
}

function normalizeHeader(docType: DocType, raw: any) {
  const issues: ErrorDetail[] = []
  const origin = raw?.origin
  if (!ORIGINS[docType].includes(origin))
    issues.push({
      path: 'origin',
      code: 'INVALID',
      message: `Origem inválida para ${docType === 'RECEIPT' ? 'uma entrada' : 'uma saída'}.`,
    })
  const documentDate = raw?.documentDate ?? today()
  if (!DATE.test(documentDate) || Number.isNaN(Date.parse(documentDate)))
    issues.push({ path: 'documentDate', code: 'INVALID', message: 'Data inválida.' })
  else if (documentDate > today())
    issues.push({
      path: 'documentDate',
      code: 'FUTURE',
      message: 'A data do documento não pode ser futura.',
    })
  fail(issues)
  return {
    origin,
    documentDate,
    originRef: text(raw?.originRef, 60),
    counterparty: text(raw?.counterparty, 160),
    notes: text(raw?.notes, 500),
  }
}

async function insertLines(
  scope: TenantScope,
  docId: string,
  warehouseId: string,
  lines: NormLine[]
) {
  const { tenantId, userId } = scope.context
  const values: unknown[] = []
  lines.forEach((l, i) =>
    values.push(
      tenantId,
      docId,
      i + 1,
      l.productId,
      l.variantId,
      l.uomId,
      txt(l.factor),
      txt(l.quantity),
      txt(l.baseQuantity),
      warehouseId,
      l.locationId,
      l.bucket,
      l.lotCode,
      l.serials.length ? JSON.stringify(l.serials) : null,
      l.expiryDate,
      l.unitCost === null ? null : txt(l.unitCost),
      userId,
      userId
    )
  )
  await scope.trx.rawQuery(
    `insert into stock_document_lines (tenant_id, document_id, line_no, product_id, variant_id, uom_id, factor, quantity,
        base_quantity, warehouse_id, location_id, bucket, lot_code, serials, expiry_date, unit_cost, created_by, updated_by)
     values ${lines.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)').join(', ')}`,
    values as never[]
  )
}

async function documentView(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  const h = await scope.trx.rawQuery(
    `select d.*, d.document_date::text as date_text, w.code as warehouse_code, w.name as warehouse_name,
        le.code as le_code, uc.full_name as checked_by_name, ux.full_name as created_by_name
       from stock_documents d
       join warehouses w on w.tenant_id = d.tenant_id and w.id = d.warehouse_id
       join legal_entities le on le.tenant_id = d.tenant_id and le.id = d.legal_entity_id
       left join users uc on uc.id = d.checked_by
       left join users ux on ux.id = d.created_by
      where d.tenant_id = ? and d.id = ?`,
    [t, id]
  )
  const d = h.rows[0] as any
  if (!d) throw ApiError.notFound()
  const ls = await scope.trx.rawQuery(
    `select l.*, l.expiry_date::text as expiry_text, p.sku, p.name as product_name, p.track_serials,
        v.sku as variant_sku, u.code as uom_code, bu.code as base_uom_code, loc.path_code
       from stock_document_lines l
       join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       join uoms u on u.tenant_id = l.tenant_id and u.id = l.uom_id
       join uoms bu on bu.tenant_id = p.tenant_id and bu.id = p.base_uom_id
       left join product_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
       left join warehouse_locations loc on loc.tenant_id = l.tenant_id and loc.id = l.location_id
      where l.tenant_id = ? and l.document_id = ? order by l.line_no`,
    [t, id]
  )
  const cs = await scope.trx.rawQuery(
    `select c.*, u.full_name as created_by_name, r.full_name as reversed_by_name from stock_document_confirmations c
       left join users u on u.id = c.created_by left join users r on r.id = c.reversed_by
      where c.tenant_id = ? and c.document_id = ? order by c.seq`,
    [t, id]
  )
  const cl = await scope.trx.rawQuery(
    `select cl.confirmation_id, cl.line_id, cl.quantity::text as quantity, cl.base_quantity::text as base_quantity
       from stock_document_confirmation_lines cl
       join stock_document_confirmations c on c.tenant_id = cl.tenant_id and c.id = cl.confirmation_id
      where cl.tenant_id = ? and c.document_id = ?`,
    [t, id]
  )
  const r = await rights(scope, d.warehouse_id)
  return {
    id: d.id as string,
    version: Number(d.version),
    docType: d.doc_type as DocType,
    number: (d.number as string) ?? null,
    status: d.status as DocStatus,
    documentDate: d.date_text as string,
    warehouse: {
      id: d.warehouse_id as string,
      code: d.warehouse_code as string,
      name: d.warehouse_name,
    },
    legalEntity: { id: d.legal_entity_id as string, code: d.le_code as string },
    origin: d.origin as string,
    originRef: (d.origin_ref as string) ?? null,
    counterparty: (d.counterparty as string) ?? null,
    notes: (d.notes as string) ?? null,
    currency: (d.currency as string) ?? null,
    checkedBy: (d.checked_by_name as string) ?? null,
    checkedAt: d.checked_at,
    completedAt: d.completed_at,
    closedShort: Boolean(d.closed_short),
    closeReason: (d.close_reason as string) ?? null,
    cancelReason: (d.cancel_reason as string) ?? null,
    createdBy: (d.created_by_name as string) ?? null,
    createdAt: d.created_at,
    can: { manage: !!r?.manage, confirm: !!r?.confirm },
    lines: (ls.rows as any[]).map((l) => {
      const q = dec(l.quantity)
      const c = dec(l.confirmed_quantity)
      return {
        id: l.id as string,
        lineNo: Number(l.line_no),
        product: {
          id: l.product_id as string,
          sku: l.sku as string,
          name: l.product_name as string,
        },
        variant: l.variant_id ? { id: l.variant_id as string, sku: l.variant_sku as string } : null,
        uom: { id: l.uom_id as string, code: l.uom_code as string },
        baseUom: l.base_uom_code as string,
        factor: txt(dec(l.factor)),
        quantity: txt(q),
        baseQuantity: txt(dec(l.base_quantity)),
        location: l.location_id
          ? { id: l.location_id as string, pathCode: l.path_code as string }
          : null,
        bucket: l.bucket as string,
        lotCode: (l.lot_code as string) ?? null,
        serials: (l.serials as string[]) ?? [],
        expiryDate: (l.expiry_text as string) ?? null,
        unitCost: l.unit_cost === null ? null : txt(dec(l.unit_cost)),
        trackSerials: Boolean(l.track_serials),
        checkedQuantity: l.checked_quantity === null ? null : txt(dec(l.checked_quantity)),
        differenceReason: (l.difference_reason as string) ?? null,
        confirmedQuantity: txt(c),
        remainingQuantity: txt(q - c),
      }
    }),
    confirmations: (cs.rows as any[]).map((c) => ({
      id: c.id as string,
      seq: Number(c.seq),
      postingId: c.posting_id as string,
      reversalPostingId: (c.reversal_posting_id as string) ?? null,
      createdAt: c.created_at,
      createdBy: (c.created_by_name as string) ?? null,
      reversedAt: c.reversed_at,
      reversedBy: (c.reversed_by_name as string) ?? null,
      reverseReason: (c.reverse_reason as string) ?? null,
      lines: (cl.rows as any[])
        .filter((x) => x.confirmation_id === c.id)
        .map((x) => ({
          lineId: x.line_id as string,
          quantity: txt(dec(x.quantity)),
          baseQuantity: txt(dec(x.base_quantity)),
        })),
    })),
  }
}

async function lineRows(scope: TenantScope, docId: string) {
  const r = await scope.trx.rawQuery(
    `select l.*, p.track_serials from stock_document_lines l
       join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where l.tenant_id = ? and l.document_id = ? order by l.line_no for update of l`,
    [scope.context.tenantId, docId]
  )
  return r.rows as any[]
}

async function confirmationCount(scope: TenantScope, docId: string) {
  const r = await scope.trx.rawQuery(
    'select count(*)::int as n from stock_document_confirmations where tenant_id = ? and document_id = ?',
    [scope.context.tenantId, docId]
  )
  return (r.rows[0] as { n: number }).n
}

async function touch(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update stock_documents set ${keys.map((k) => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}
       updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

/** Série activa da entidade legal para o tipo, em vigor na data (a da filial do armazém primeiro). */
async function seriesFor(scope: TenantScope, d: any) {
  const r = await scope.trx.rawQuery(
    `select s.id from document_series s
       join warehouses w on w.tenant_id = s.tenant_id and w.id = ?
      where s.tenant_id = ? and s.legal_entity_id = ? and s.document_type = ? and s.status = 'ACTIVE'
        and (s.valid_from is null or s.valid_from <= ?::date) and (s.valid_to is null or s.valid_to >= ?::date)
        and (s.branch_id is null or s.branch_id = w.branch_id)
      order by (s.branch_id is not null) desc, s.code limit 1`,
    [
      d.warehouse_id,
      scope.context.tenantId,
      d.legal_entity_id,
      SERIES_TYPE[d.doc_type as DocType],
      d.date_text,
      d.date_text,
    ] as never[]
  )
  const s = r.rows[0] as { id: string } | undefined
  if (!s)
    throw ApiError.conflict(
      'NO_SERIES',
      `Sem série documental ${SERIES_TYPE[d.doc_type as DocType]} activa para esta entidade legal nesta data: crie-a em Séries documentais.`
    )
  return s.id
}

export class StockDocumentService {
  list(
    context: TenantContext,
    f: {
      docType?: string
      status?: string
      warehouseId?: string
      q?: string
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const ids = await readableWarehouseIds(scope)
      if (!ids.length) return { items: [], total: 0 }
      const where = ['d.tenant_id = ?', 'd.warehouse_id = any(?::uuid[])']
      const params: unknown[] = [context.tenantId, ids]
      for (const [k, col] of [
        ['docType', 'd.doc_type'],
        ['status', 'd.status'],
        ['warehouseId', 'd.warehouse_id'],
      ] as const)
        if (f[k]) {
          where.push(`${col} = ?`)
          params.push(f[k])
        }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(
          `(lower(coalesce(d.number, '')) like ? or lower(coalesce(d.origin_ref, '')) like ? or lower(coalesce(d.counterparty, '')) like ?)`
        )
        params.push(like, like, like)
      }
      const cl = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `select d.*, d.document_date::text as date_text, w.code as warehouse_code,
            (select count(*)::int from stock_document_lines l where l.tenant_id = d.tenant_id and l.document_id = d.id) as line_count
           from stock_documents d join warehouses w on w.tenant_id = d.tenant_id and w.id = d.warehouse_id
          where ${cl} order by d.document_date desc, d.created_at desc limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from stock_documents d where ${cl}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map((d) => ({
          id: d.id as string,
          docType: d.doc_type as DocType,
          number: (d.number as string) ?? null,
          status: d.status as DocStatus,
          documentDate: d.date_text as string,
          warehouse: { id: d.warehouse_id as string, code: d.warehouse_code as string },
          origin: d.origin as string,
          originRef: (d.origin_ref as string) ?? null,
          counterparty: (d.counterparty as string) ?? null,
          lineCount: Number(d.line_count),
          closedShort: Boolean(d.closed_short),
        })),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const d = await loadDoc(scope, id)
      await authorize(scope, d.warehouse_id, 'read')
      return documentView(scope, id)
    })
  }

  create(context: TenantContext, raw: any) {
    return runInTenant(context, async (scope) => {
      const docType = raw?.docType
      if (!DOC_TYPES.includes(docType))
        fail([{ path: 'docType', code: 'INVALID', message: 'Tipo: entrada ou saída.' }])
      if (!isUuid(raw?.warehouseId))
        fail([{ path: 'warehouseId', code: 'REQUIRED', message: 'Escolha o armazém.' }])
      const r = await authorize(scope, raw.warehouseId, 'manage')
      if (docType === 'RECEIPT' && r.access.status !== 'ACTIVE')
        fail([{ path: 'warehouseId', code: 'INACTIVE', message: 'O armazém está inactivo.' }])
      const head = normalizeHeader(docType, raw)
      const lines = await normalizeLines(scope, docType, raw.warehouseId, raw?.lines)
      const le = await legalEntityFacts(scope, r.access.legalEntityId)
      const currency = lines.some((l) => l.unitCost !== null)
        ? (le?.functionalCurrency ?? null)
        : null
      const ins = await scope.trx.rawQuery(
        `insert into stock_documents (tenant_id, doc_type, warehouse_id, legal_entity_id, document_date, origin,
            origin_ref, counterparty, notes, currency, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          docType,
          raw.warehouseId,
          r.access.legalEntityId,
          head.documentDate,
          head.origin,
          head.originRef,
          head.counterparty,
          head.notes,
          currency,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await insertLines(scope, id, raw.warehouseId, lines)
      await audit(scope, {
        action: 'inventory.document.created',
        entityType: 'stock_document',
        entityId: id,
        metadata: {
          docType,
          warehouseId: raw.warehouseId,
          origin: head.origin,
          lines: lines.length,
        },
      })
      return documentView(scope, id)
    })
  }

  /** Rascunho: cabeçalho (sem tipo nem armazém) e linhas (substituídas). */
  update(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const d = await loadDoc(scope, id, true)
      await authorize(scope, d.warehouse_id, 'manage')
      versionCheck(d, expectedVersion)
      stateCheck(d, 'edit')
      if (await confirmationCount(scope, id))
        throw ApiError.conflict('INVALID_STATE', 'Documento com confirmações: não se edita.')
      const head = normalizeHeader(d.doc_type, {
        ...raw,
        documentDate: raw?.documentDate ?? d.date_text,
      })
      const lines = await normalizeLines(scope, d.doc_type, d.warehouse_id, raw?.lines)
      const le = await legalEntityFacts(scope, d.legal_entity_id)
      await scope.trx.rawQuery(
        'delete from stock_document_lines where tenant_id = ? and document_id = ?',
        [context.tenantId, id]
      )
      await insertLines(scope, id, d.warehouse_id, lines)
      await touch(scope, id, {
        document_date: head.documentDate,
        origin: head.origin,
        origin_ref: head.originRef,
        counterparty: head.counterparty,
        notes: head.notes,
        currency: lines.some((l) => l.unitCost !== null) ? (le?.functionalCurrency ?? null) : null,
      })
      await audit(scope, {
        action: 'inventory.document.updated',
        entityType: 'stock_document',
        entityId: id,
        metadata: { lines: lines.length },
      })
      return documentView(scope, id)
    })
  }

  /** Conferência: quantidades contadas desta ronda (as linhas não indicadas ficam a zero). */
  check(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const d = await loadDoc(scope, id, true)
      await authorize(scope, d.warehouse_id, 'manage')
      versionCheck(d, expectedVersion)
      stateCheck(d, 'check')
      const lines = await lineRows(scope, id)
      const given = new Map<string, any>()
      for (const x of Array.isArray(raw?.lines) ? raw.lines : [])
        if (isUuid(x?.lineId)) given.set(x.lineId, x)
      const issues: ErrorDetail[] = []
      for (const k of given.keys())
        if (!lines.some((l) => l.id === k))
          issues.push({
            path: 'lines',
            code: 'NOT_FOUND',
            message: 'Linha que não é deste documento.',
          })
      const updates: { id: string; checked: bigint; reason: string | null }[] = []
      lines.forEach((l, i) => {
        const g = given.get(l.id)
        const checked = g ? scaled(g.checkedQuantity, SCALE) : 0n
        const remaining = dec(l.quantity) - dec(l.confirmed_quantity)
        if (checked === null)
          return issues.push({
            path: `lines.${i}.checkedQuantity`,
            code: 'INVALID',
            message: 'Quantidade conferida inválida.',
          })
        const msg = checkedIssue(checked, remaining, Boolean(l.track_serials))
        if (msg) issues.push({ path: `lines.${i}.checkedQuantity`, code: 'INVALID', message: msg })
        updates.push({ id: l.id, checked, reason: text(g?.differenceReason, 200) })
      })
      fail(issues)
      if (!updates.some((u) => u.checked > 0n))
        fail([
          { path: 'lines', code: 'NOTHING_CHECKED', message: 'Confira pelo menos uma quantidade.' },
        ])
      for (const u of updates)
        await scope.trx.rawQuery(
          `update stock_document_lines set checked_quantity = ?, difference_reason = ?, updated_at = now(),
             updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
          [txt(u.checked), u.reason, context.userId, context.tenantId, u.id] as never[]
        )
      await touch(scope, id, {
        status: 'CHECKED',
        checked_by: context.userId,
        checked_at: new Date(),
      })
      await audit(scope, {
        action: 'inventory.document.checked',
        entityType: 'stock_document',
        entityId: id,
        metadata: {
          lines: updates.filter((u) => u.checked > 0n).length,
          short: updates.filter(
            (u, i) => u.checked < dec(lines[i].quantity) - dec(lines[i].confirmed_quantity)
          ).length,
        },
      })
      return documentView(scope, id)
    })
  }

  /** Volta da conferência: limpa as quantidades conferidas. */
  reopen(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const d = await loadDoc(scope, id, true)
      await authorize(scope, d.warehouse_id, 'manage')
      versionCheck(d, expectedVersion)
      stateCheck(d, 'reopen')
      const lines = await lineRows(scope, id)
      await scope.trx.rawQuery(
        `update stock_document_lines set checked_quantity = null, updated_at = now(), version = version + 1
          where tenant_id = ? and document_id = ?`,
        [context.tenantId, id]
      )
      const status = statusFrom(
        lines.map((l) => ({ quantity: dec(l.quantity), confirmed: dec(l.confirmed_quantity) })),
        (await confirmationCount(scope, id)) > 0
      )
      await touch(scope, id, { status, checked_by: null, checked_at: null })
      await audit(scope, {
        action: 'inventory.document.reopened',
        entityType: 'stock_document',
        entityId: id,
      })
      return documentView(scope, id)
    })
  }

  /** Confirma as quantidades conferidas: lança o stock, numera (na primeira) e actualiza o estado. */
  confirm(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const key = raw?.idempotencyKey
      if (typeof key !== 'string' || !/^[A-Za-z0-9:._-]{8,80}$/.test(key))
        fail([
          { path: 'idempotencyKey', code: 'INVALID', message: 'Chave de idempotência inválida.' },
        ])
      const d = await loadDoc(scope, id, true)
      await authorize(scope, d.warehouse_id, 'confirm')
      const done = await scope.trx.rawQuery(
        'select id from stock_document_confirmations where tenant_id = ? and document_id = ? and idempotency_key = ?',
        [context.tenantId, id, key]
      )
      if (done.rows.length) return documentView(scope, id) // Repetição do mesmo pedido.
      versionCheck(d, expectedVersion)
      stateCheck(d, 'confirm')
      const lines = await lineRows(scope, id)
      const prior = await scope.trx.rawQuery(
        `select cl.line_id, sum(cl.base_quantity)::text as base from stock_document_confirmation_lines cl
           join stock_document_confirmations c on c.tenant_id = cl.tenant_id and c.id = cl.confirmation_id
          where cl.tenant_id = ? and c.document_id = ? and c.reversal_posting_id is null group by cl.line_id`,
        [context.tenantId, id]
      )
      const priorBase = new Map(
        (prior.rows as any[]).map((x) => [x.line_id as string, dec(x.base)])
      )
      const moves = lines
        .filter((l) => l.checked_quantity !== null && dec(l.checked_quantity) > 0n)
        .map((l) => {
          const checked = dec(l.checked_quantity)
          const remaining = dec(l.quantity) - dec(l.confirmed_quantity)
          // A última parte leva o resto exacto da quantidade base (sem desvios de arredondamento).
          const base =
            checked === remaining
              ? dec(l.base_quantity) - (priorBase.get(l.id) ?? 0n)
              : toBase(checked, dec(l.factor))
          return { l, checked, base }
        })
      if (!moves.length)
        fail([{ path: 'lines', code: 'NOTHING_CHECKED', message: 'Nada conferido.' }])
      let number = d.number as string | null
      let seriesId = d.series_id as string | null
      if (!number) {
        seriesId = await seriesFor(scope, d)
        number = (await reserveDocumentNumber(scope, seriesId, d.date_text)).formatted
      }
      const sign = d.doc_type === 'RECEIPT' ? '' : '-'
      const posted = await postStock(scope, {
        type: d.doc_type,
        idempotencyKey: `doc-${id}-${key}`,
        sourceType: 'STOCK_DOCUMENT',
        sourceId: id,
        sourceRef: number,
        reason: d.origin,
        lines: moves.map(({ l, base }) => ({
          warehouseId: d.warehouse_id,
          locationId: l.location_id,
          productId: l.product_id,
          variantId: l.variant_id,
          bucket: l.bucket,
          quantity: `${sign}${txt(base)}`,
        })),
      })
      const seq = (await confirmationCount(scope, id)) + 1
      const c = await scope.trx.rawQuery(
        `insert into stock_document_confirmations (tenant_id, document_id, seq, idempotency_key, posting_id,
            created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?) returning id`,
        [context.tenantId, id, seq, key, posted.posting.id, context.userId, context.userId]
      )
      const cid = (c.rows[0] as { id: string }).id
      for (const m of moves) {
        await scope.trx.rawQuery(
          `insert into stock_document_confirmation_lines (tenant_id, confirmation_id, line_id, quantity, base_quantity,
              created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            cid,
            m.l.id,
            txt(m.checked),
            txt(m.base),
            context.userId,
            context.userId,
          ]
        )
        await scope.trx.rawQuery(
          `update stock_document_lines set confirmed_quantity = confirmed_quantity + ?, checked_quantity = null,
             updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
          [txt(m.checked), context.tenantId, m.l.id] as never[]
        )
      }
      await scope.trx.rawQuery(
        `update stock_document_lines set checked_quantity = null where tenant_id = ? and document_id = ?
           and checked_quantity is not null`,
        [context.tenantId, id]
      )
      const after = await lineRows(scope, id)
      const status = statusFrom(
        after.map((l) => ({ quantity: dec(l.quantity), confirmed: dec(l.confirmed_quantity) })),
        true
      )
      await touch(scope, id, {
        status,
        series_id: seriesId,
        number,
        completed_at: status === 'COMPLETED' ? new Date() : null,
      })
      await audit(scope, {
        action: 'inventory.document.confirmed',
        entityType: 'stock_document',
        entityId: id,
        metadata: { number, seq, postingId: posted.posting.id, lines: moves.length, status },
      })
      return documentView(scope, id)
    })
  }

  /** Fecha o saldo por confirmar (com motivo): o documento fica concluído com o que foi confirmado. */
  close(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const d = await loadDoc(scope, id, true)
      await authorize(scope, d.warehouse_id, 'confirm')
      versionCheck(d, expectedVersion)
      stateCheck(d, 'close')
      await touch(scope, id, {
        status: 'COMPLETED',
        closed_short: true,
        close_reason: reason,
        completed_at: new Date(),
      })
      await audit(scope, {
        action: 'inventory.document.closed',
        entityType: 'stock_document',
        entityId: id,
        metadata: { reason },
      })
      return documentView(scope, id)
    })
  }

  /** Anula um documento sem confirmações. */
  cancel(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const d = await loadDoc(scope, id, true)
      await authorize(scope, d.warehouse_id, 'manage')
      versionCheck(d, expectedVersion)
      stateCheck(d, 'cancel')
      if (await confirmationCount(scope, id))
        throw ApiError.conflict(
          'HAS_CONFIRMATIONS',
          'Já há stock confirmado: estorne as confirmações ou feche o saldo.'
        )
      await scope.trx.rawQuery(
        'update stock_document_lines set checked_quantity = null where tenant_id = ? and document_id = ?',
        [context.tenantId, id]
      )
      await touch(scope, id, {
        status: 'CANCELLED',
        cancel_reason: reason,
        checked_by: null,
        checked_at: null,
      })
      await audit(scope, {
        action: 'inventory.document.cancelled',
        entityType: 'stock_document',
        entityId: id,
        metadata: { reason },
      })
      return documentView(scope, id)
    })
  }

  /** Estorna uma confirmação: lançamento inverso; as quantidades voltam a estar por confirmar. */
  reverse(context: TenantContext, confirmationId: string, raw: any) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      const key = raw?.idempotencyKey
      const issues: ErrorDetail[] = []
      if (!reason)
        issues.push({ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo do estorno.' })
      if (typeof key !== 'string' || !/^[A-Za-z0-9:._-]{8,80}$/.test(key))
        issues.push({
          path: 'idempotencyKey',
          code: 'INVALID',
          message: 'Chave de idempotência inválida.',
        })
      fail(issues)
      if (!isUuid(confirmationId)) throw ApiError.notFound()
      const cr = await scope.trx.rawQuery(
        'select * from stock_document_confirmations where tenant_id = ? and id = ?',
        [context.tenantId, confirmationId]
      )
      const c = cr.rows[0] as any
      if (!c) throw ApiError.notFound()
      const d = await loadDoc(scope, c.document_id, true)
      await authorize(scope, d.warehouse_id, 'confirm')
      if (c.reversal_posting_id) {
        // Repetição do mesmo estorno devolve o documento; outro pedido é recusado.
        const again = await scope.trx.rawQuery(
          'select 1 from stock_postings where tenant_id = ? and id = ? and idempotency_key = ?',
          [context.tenantId, c.reversal_posting_id, `rev-${confirmationId}-${key}`]
        )
        if (again.rows.length) return documentView(scope, d.id)
        throw ApiError.conflict('ALREADY_REVERSED', 'Esta confirmação já foi estornada.')
      }
      const rev = await reverseStockPosting(scope, c.posting_id, {
        idempotencyKey: `rev-${confirmationId}-${key}`,
        reason: reason!,
      })
      await scope.trx.rawQuery(
        `update stock_document_confirmations set reversal_posting_id = ?, reversed_at = now(), reversed_by = ?,
           reverse_reason = ?, updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
        [
          rev.posting.id,
          context.userId,
          reason,
          context.userId,
          context.tenantId,
          confirmationId,
        ] as never[]
      )
      const cl = await scope.trx.rawQuery(
        'select line_id, quantity::text as quantity from stock_document_confirmation_lines where tenant_id = ? and confirmation_id = ?',
        [context.tenantId, confirmationId]
      )
      for (const x of cl.rows as any[])
        await scope.trx.rawQuery(
          `update stock_document_lines set confirmed_quantity = confirmed_quantity - ?, updated_at = now(),
             version = version + 1 where tenant_id = ? and id = ?`,
          [x.quantity, context.tenantId, x.line_id]
        )
      const after = await lineRows(scope, d.id)
      const status =
        d.status === 'CHECKED'
          ? 'CHECKED'
          : statusFrom(
              after.map((l) => ({
                quantity: dec(l.quantity),
                confirmed: dec(l.confirmed_quantity),
              })),
              true
            )
      await touch(scope, d.id, {
        status,
        closed_short: false,
        close_reason: null,
        completed_at: status === 'COMPLETED' ? d.completed_at : null,
      })
      await audit(scope, {
        action: 'inventory.document.reversed',
        entityType: 'stock_document',
        entityId: d.id,
        metadata: { confirmationId, seq: Number(c.seq), reversalPostingId: rev.posting.id, reason },
      })
      return documentView(scope, d.id)
    })
  }
}
