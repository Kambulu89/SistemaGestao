import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope } from '#modules/rbac/index'
import { reserveDocumentNumber } from '#modules/settings/index'
import { fitsDecimals, scaled, scaledText } from '#modules/inventory/domain/catalog'
import {
  isLotCode,
  LINE_BUCKETS,
  lineIssues,
  normalizeSerials,
} from '#modules/inventory/domain/documents'
import {
  approvalComplete,
  receiveIssue,
  selfApproval,
  statusAfterReceipt,
  toShip,
  TRANSFER_CAN,
  TRANSFER_SERIES_TYPE,
  type TransferStatus,
} from '#modules/inventory/domain/transfers'
import {
  readableWarehouseIds,
  warehouseAccessFor,
} from '#modules/inventory/application/warehouse_service'
import { postStock, type PostStockLineInput } from '#modules/inventory/application/stock_service'

/*
 * Transferências (8.5). Todo o efeito no stock passa por `postStock` (o 8.3 garante saldos, bloqueios e idempotência):
 * aprovação → reserva na origem; expedição → sai da origem e fica em trânsito no destino; recepção → sai do trânsito e
 * entra no destino; perda → sai do trânsito; anulação depois de aprovada → liberta a reserva. Gerir
 * (`inventory.transfers.manage`) e aprovar (`inventory.transfers.approve`) verificam-se no armazém de cada passo
 * (origem: pedir, separar, expedir, aprovar; destino: receber, aceitar, fechar perdas), com acesso de operação.
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

type Perm = 'manage' | 'approve'
const PERM: Record<Perm, string> = {
  manage: 'inventory.transfers.manage',
  approve: 'inventory.transfers.approve',
}

async function rightsOn(scope: TenantScope, warehouseId: string) {
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
    approve: a.operate && (await covers(PERM.approve)),
  }
}

async function need(scope: TenantScope, warehouseId: string, perm: Perm, side: string) {
  const r = await rightsOn(scope, warehouseId)
  if (!r) throw ApiError.forbidden('OUT_OF_SCOPE', `Sem acesso ao armazém de ${side}.`)
  if (!r.access.operate)
    throw ApiError.forbidden('NO_OPERATE', `Não tem acesso para operar no armazém de ${side}.`)
  if (!r[perm])
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      perm === 'manage'
        ? `Não gere transferências no armazém de ${side}.`
        : `Não aprova transferências no armazém de ${side}.`
    )
  return r
}

async function loadTransfer(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select *, requested_date::text as requested_text from stock_transfers where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  const t = r.rows[0] as any
  if (!t) throw ApiError.notFound()
  return t
}

/** Visível a quem vê um dos armazéns (origem ou destino). */
async function visible(scope: TenantScope, t: any) {
  const ids = new Set(await readableWarehouseIds(scope))
  if (!ids.has(t.source_warehouse_id) && !ids.has(t.dest_warehouse_id)) throw ApiError.notFound()
}

const versionCheck = (t: any, expected: number) => {
  if (Number(t.version) !== expected) throw ApiError.versionConflict(Number(t.version))
}
const stateCheck = (t: any, action: keyof typeof TRANSFER_CAN) => {
  if (!TRANSFER_CAN[action].includes(t.status))
    throw ApiError.conflict('INVALID_STATE', `Não é possível nesta fase (${t.status}).`)
}
const keyCheck = (key: unknown) => {
  if (typeof key !== 'string' || !KEY.test(key))
    fail([{ path: 'idempotencyKey', code: 'INVALID', message: 'Chave de idempotência inválida.' }])
  return key as string
}

async function touch(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update stock_transfers set ${keys.map((k) => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}
       updated_at = now(), updated_by = ?, version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function lineRows(scope: TenantScope, id: string) {
  const r = await scope.trx.rawQuery(
    `select l.*, p.track_serials from stock_transfer_lines l
       join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where l.tenant_id = ? and l.transfer_id = ? order by l.line_no for update of l`,
    [scope.context.tenantId, id]
  )
  return r.rows as any[]
}

interface NormLine {
  productId: string
  variantId: string | null
  quantity: bigint
  sourceLocationId: string | null
  sourceBucket: string
  destLocationId: string | null
  lotCode: string | null
  serials: string[]
}

async function locationMap(scope: TenantScope, warehouseId: string) {
  const r = await scope.trx.rawQuery(
    'select id, path_code, holds_stock, status from warehouse_locations where tenant_id = ? and warehouse_id = ?',
    [scope.context.tenantId, warehouseId]
  )
  return new Map((r.rows as any[]).map((l) => [l.id as string, l]))
}

async function normalizeLines(
  scope: TenantScope,
  sourceId: string,
  destId: string,
  raw: unknown
): Promise<NormLine[]> {
  const t = scope.context.tenantId
  if (!Array.isArray(raw) || !raw.length)
    fail([
      {
        path: 'lines',
        code: 'REQUIRED',
        message: 'A transferência precisa de pelo menos uma linha.',
      },
    ])
  const input = raw as any[]
  if (input.length > 300)
    fail([{ path: 'lines', code: 'LENGTH', message: 'No máximo 300 linhas.' }])
  const pids = [...new Set(input.map((l) => l?.productId).filter(isUuid))]
  const products = pids.length
    ? await scope.trx.rawQuery(
        `select p.id, p.sku, p.product_type, p.track_lots, p.track_serials, bu.decimals,
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
  const src = await locationMap(scope, sourceId)
  const dst = await locationMap(scope, destId)
  const issues: ErrorDetail[] = []
  const out: NormLine[] = []
  input.forEach((l, i) => {
    const at = `lines.${i}`
    const add = (path: string, code: string, message: string) =>
      issues.push({ path: `${at}.${path}`, code, message })
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
    const pick = (value: unknown, map: Map<string, any>, path: string, mustBeActive: boolean) => {
      if (!value) return null
      const loc = isUuid(value) ? map.get(value) : null
      if (!loc) {
        add(path, 'NOT_FOUND', 'A localização não é deste armazém.')
        return null
      }
      if (!loc.holds_stock) add(path, 'NOT_HOLDING', `${loc.path_code} não guarda stock.`)
      else if (mustBeActive && loc.status !== 'ACTIVE')
        add(path, 'INACTIVE', `${loc.path_code} está inactiva.`)
      return loc.id as string
    }
    const sourceLocationId = pick(l?.sourceLocationId, src, 'sourceLocationId', false)
    const destLocationId = pick(l?.destLocationId, dst, 'destLocationId', true)
    const sourceBucket = l?.sourceBucket ?? 'UNRESTRICTED'
    if (!LINE_BUCKETS.includes(sourceBucket))
      add('sourceBucket', 'INVALID', 'Estado do stock inválido.')
    const lotCode = l?.lotCode ? String(l.lotCode).trim() : null
    if (lotCode && !isLotCode(lotCode)) add('lotCode', 'INVALID', 'Lote inválido.')
    const serials = normalizeSerials(l?.serials)
    if (serials === null) add('serials', 'INVALID', 'Números de série sem vazios nem repetidos.')
    issues.push(
      ...lineIssues(
        {
          docType: 'ISSUE',
          trackLots: Boolean(p.track_lots),
          trackSerials: Boolean(p.track_serials),
          trackExpiry: false,
          lotCode,
          serials: serials ?? [],
          expiryDate: null,
          baseQuantity: quantity ?? 0n,
          unitCost: null,
        },
        at
      )
    )
    out.push({
      productId: p.id,
      variantId,
      quantity: quantity ?? 0n,
      sourceLocationId,
      sourceBucket,
      destLocationId,
      lotCode,
      serials: serials ?? [],
    })
  })
  fail(issues)
  return out
}

async function insertLines(
  scope: TenantScope,
  t: { id: string; src: string; dst: string },
  lines: NormLine[]
) {
  const { tenantId, userId } = scope.context
  const values: unknown[] = []
  lines.forEach((l, i) =>
    values.push(
      tenantId,
      t.id,
      i + 1,
      l.productId,
      l.variantId,
      txt(l.quantity),
      t.src,
      l.sourceLocationId,
      l.sourceBucket,
      t.dst,
      l.destLocationId,
      l.lotCode,
      l.serials.length ? JSON.stringify(l.serials) : null,
      userId,
      userId
    )
  )
  await scope.trx.rawQuery(
    `insert into stock_transfer_lines (tenant_id, transfer_id, line_no, product_id, variant_id, quantity,
        source_warehouse_id, source_location_id, source_bucket, dest_warehouse_id, dest_location_id, lot_code, serials,
        created_by, updated_by)
     values ${lines.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)').join(', ')}`,
    values as never[]
  )
}

async function headerInput(scope: TenantScope, raw: any, creating: boolean) {
  const issues: ErrorDetail[] = []
  const requestedDate = raw?.requestedDate ?? today()
  if (!DATE.test(requestedDate) || Number.isNaN(Date.parse(requestedDate)))
    issues.push({ path: 'requestedDate', code: 'INVALID', message: 'Data inválida.' })
  else if (requestedDate > today())
    issues.push({
      path: 'requestedDate',
      code: 'FUTURE',
      message: 'A data do pedido não pode ser futura.',
    })
  const expectedDate = raw?.expectedDate || null
  if (expectedDate && (!DATE.test(expectedDate) || expectedDate < requestedDate))
    issues.push({
      path: 'expectedDate',
      code: 'INVALID',
      message: 'A data prevista de chegada não pode ser anterior ao pedido.',
    })
  if (creating) {
    if (!isUuid(raw?.sourceWarehouseId))
      issues.push({
        path: 'sourceWarehouseId',
        code: 'REQUIRED',
        message: 'Escolha o armazém de origem.',
      })
    if (!isUuid(raw?.destWarehouseId))
      issues.push({
        path: 'destWarehouseId',
        code: 'REQUIRED',
        message: 'Escolha o armazém de destino.',
      })
    else if (raw.destWarehouseId === raw.sourceWarehouseId)
      issues.push({
        path: 'destWarehouseId',
        code: 'SAME',
        message: 'Origem e destino têm de ser diferentes.',
      })
  }
  fail(issues)
  void scope
  return {
    requestedDate,
    expectedDate,
    intercompanyRef: text(raw?.intercompanyRef, 60),
    notes: text(raw?.notes, 500),
  }
}

async function transferView(scope: TenantScope, id: string) {
  const t = scope.context.tenantId
  const h = await scope.trx.rawQuery(
    `select x.*, x.requested_date::text as requested_text, x.expected_date::text as expected_text,
        sw.code as src_code, sw.name as src_name, dw.code as dst_code, dw.name as dst_name,
        sl.code as src_le_code, dl.code as dst_le_code,
        u1.full_name as created_name, u2.full_name as approved_name, u3.full_name as accepted_name,
        u4.full_name as picked_name, u5.full_name as dispatched_name, u6.full_name as submitted_name
       from stock_transfers x
       join warehouses sw on sw.tenant_id = x.tenant_id and sw.id = x.source_warehouse_id
       join warehouses dw on dw.tenant_id = x.tenant_id and dw.id = x.dest_warehouse_id
       join legal_entities sl on sl.tenant_id = x.tenant_id and sl.id = x.source_legal_entity_id
       join legal_entities dl on dl.tenant_id = x.tenant_id and dl.id = x.dest_legal_entity_id
       left join users u1 on u1.id = x.created_by left join users u2 on u2.id = x.approved_by
       left join users u3 on u3.id = x.accepted_by left join users u4 on u4.id = x.picked_by
       left join users u5 on u5.id = x.dispatched_by left join users u6 on u6.id = x.submitted_by
      where x.tenant_id = ? and x.id = ?`,
    [t, id]
  )
  const x = h.rows[0] as any
  if (!x) throw ApiError.notFound()
  const ls = await scope.trx.rawQuery(
    `select l.*, p.sku, p.name as product_name, p.track_serials, v.sku as variant_sku, u.code as uom_code,
        sl.path_code as src_path, dl.path_code as dst_path
       from stock_transfer_lines l
       join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       join uoms u on u.tenant_id = p.tenant_id and u.id = p.base_uom_id
       left join product_variants v on v.tenant_id = l.tenant_id and v.id = l.variant_id
       left join warehouse_locations sl on sl.tenant_id = l.tenant_id and sl.id = l.source_location_id
       left join warehouse_locations dl on dl.tenant_id = l.tenant_id and dl.id = l.dest_location_id
      where l.tenant_id = ? and l.transfer_id = ? order by l.line_no`,
    [t, id]
  )
  const ev = await scope.trx.rawQuery(
    `select e.*, u.full_name as created_name,
        (select count(*)::int from stock_transfer_event_lines el where el.tenant_id = e.tenant_id and el.event_id = e.id) as line_count
       from stock_transfer_events e left join users u on u.id = e.created_by
      where e.tenant_id = ? and e.transfer_id = ? order by e.created_at`,
    [t, id]
  )
  const src = await rightsOn(scope, x.source_warehouse_id)
  const dst = await rightsOn(scope, x.dest_warehouse_id)
  return {
    id: x.id as string,
    version: Number(x.version),
    number: (x.number as string) ?? null,
    status: x.status as TransferStatus,
    intercompany: Boolean(x.intercompany),
    intercompanyRef: (x.intercompany_ref as string) ?? null,
    source: {
      warehouse: {
        id: x.source_warehouse_id as string,
        code: x.src_code as string,
        name: x.src_name,
      },
      legalEntity: { id: x.source_legal_entity_id as string, code: x.src_le_code as string },
    },
    dest: {
      warehouse: {
        id: x.dest_warehouse_id as string,
        code: x.dst_code as string,
        name: x.dst_name,
      },
      legalEntity: { id: x.dest_legal_entity_id as string, code: x.dst_le_code as string },
    },
    requestedDate: x.requested_text as string,
    expectedDate: (x.expected_text as string) ?? null,
    notes: (x.notes as string) ?? null,
    carrier: (x.carrier as string) ?? null,
    trackingRef: (x.tracking_ref as string) ?? null,
    createdBy: (x.created_name as string) ?? null,
    submitted: x.submitted_at ? { by: x.submitted_name, at: x.submitted_at } : null,
    approved: x.approved_at ? { by: x.approved_name, at: x.approved_at } : null,
    accepted: x.accepted_at ? { by: x.accepted_name, at: x.accepted_at } : null,
    picked: x.picked_at ? { by: x.picked_name, at: x.picked_at } : null,
    dispatched: x.dispatched_at ? { by: x.dispatched_name, at: x.dispatched_at } : null,
    completedAt: x.completed_at,
    closeReason: (x.close_reason as string) ?? null,
    rejectReason: (x.reject_reason as string) ?? null,
    cancelReason: (x.cancel_reason as string) ?? null,
    can: {
      manageSource: !!src?.manage,
      approveSource: !!src?.approve,
      manageDest: !!dst?.manage,
      approveDest: !!dst?.approve,
      isRequester: x.submitted_by === scope.context.userId || x.created_by === scope.context.userId,
    },
    lines: (ls.rows as any[]).map((l) => {
      const shipped = dec(l.shipped_quantity)
      const received = dec(l.received_quantity)
      const lost = dec(l.lost_quantity)
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
        quantity: txt(dec(l.quantity)),
        sourceLocation: l.source_location_id
          ? { id: l.source_location_id, pathCode: l.src_path }
          : null,
        sourceBucket: l.source_bucket as string,
        destLocation: l.dest_location_id ? { id: l.dest_location_id, pathCode: l.dst_path } : null,
        lotCode: (l.lot_code as string) ?? null,
        serials: (l.serials as string[]) ?? [],
        trackSerials: Boolean(l.track_serials),
        pickedQuantity: l.picked_quantity === null ? null : txt(dec(l.picked_quantity)),
        shippedQuantity: txt(shipped),
        receivedQuantity: txt(received),
        lostQuantity: txt(lost),
        inTransitQuantity: txt(shipped - received - lost),
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

/** Lançamento de stock de um passo da transferência + registo do evento e das suas linhas. */
async function post(
  scope: TenantScope,
  t: any,
  kind: 'RESERVE' | 'RELEASE' | 'DISPATCH' | 'RECEIVE' | 'LOSS',
  key: string,
  lines: PostStockLineInput[],
  eventLines: { lineId: string; quantity: bigint; destLocationId?: string | null }[],
  reason: string | null
) {
  const type = {
    RESERVE: 'RESERVATION',
    RELEASE: 'RELEASE',
    DISPATCH: 'TRANSFER_OUT',
    RECEIVE: 'TRANSFER_IN',
    LOSS: 'TRANSFER_IN',
  }[kind] as never
  const posted = await postStock(scope, {
    type,
    idempotencyKey: `trf-${t.id}-${key}`,
    sourceType: t.intercompany ? 'INTERCOMPANY_TRANSFER' : 'STOCK_TRANSFER',
    sourceId: t.id,
    sourceRef: t.number,
    reason: reason ?? kind,
    lines,
    // A autorização de cada passo é verificada aqui, pelo armazém desse passo (a outra ponta pode não ser do membro).
    checkAccess: false,
  })
  const e = await scope.trx.rawQuery(
    `insert into stock_transfer_events (tenant_id, transfer_id, kind, idempotency_key, posting_id, reason, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
    [
      scope.context.tenantId,
      t.id,
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
      `insert into stock_transfer_event_lines (tenant_id, event_id, line_id, quantity, dest_location_id, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        eid,
        l.lineId,
        txt(l.quantity),
        l.destLocationId ?? null,
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
  return posted.posting.id
}

async function eventDone(scope: TenantScope, id: string, key: string) {
  const r = await scope.trx.rawQuery(
    'select 1 from stock_transfer_events where tenant_id = ? and transfer_id = ? and idempotency_key = ?',
    [scope.context.tenantId, id, key]
  )
  return r.rows.length > 0
}

/** Só o stock livre se reserva (bloqueado e quarentena não contam para o disponível). */
const reservable = (lines: any[]) => lines.filter((l) => l.source_bucket === 'UNRESTRICTED')
const reserveLines = (t: any, lines: any[], sign: '' | '-'): PostStockLineInput[] =>
  reservable(lines).map((l) => ({
    warehouseId: t.source_warehouse_id,
    locationId: null,
    productId: l.product_id,
    variantId: l.variant_id,
    bucket: 'RESERVED',
    quantity: `${sign}${txt(dec(l.quantity))}`,
  }))

/** Aprovação completa: número da série da origem e reserva das quantidades na origem. */
async function completeApproval(scope: TenantScope, t: any) {
  const s = await scope.trx.rawQuery(
    `select s.id from document_series s join warehouses w on w.tenant_id = s.tenant_id and w.id = ?
      where s.tenant_id = ? and s.legal_entity_id = ? and s.document_type = ? and s.status = 'ACTIVE'
        and (s.valid_from is null or s.valid_from <= ?::date) and (s.valid_to is null or s.valid_to >= ?::date)
        and (s.branch_id is null or s.branch_id = w.branch_id)
      order by (s.branch_id is not null) desc, s.code limit 1`,
    [
      t.source_warehouse_id,
      scope.context.tenantId,
      t.source_legal_entity_id,
      TRANSFER_SERIES_TYPE,
      today(),
      today(),
    ] as never[]
  )
  const series = s.rows[0] as { id: string } | undefined
  if (!series)
    throw ApiError.conflict(
      'NO_SERIES',
      `Sem série documental ${TRANSFER_SERIES_TYPE} activa para a entidade legal de origem: crie-a em Séries documentais.`
    )
  const number = (await reserveDocumentNumber(scope, series.id, today())).formatted
  t.number = number
  const lines = reservable(await lineRows(scope, t.id))
  if (lines.length)
    await post(
      scope,
      t,
      'RESERVE',
      'reserve',
      reserveLines(t, lines, ''),
      lines.map((l) => ({ lineId: l.id, quantity: dec(l.quantity) })),
      null
    )
  return { series_id: series.id, number, status: 'APPROVED' }
}

/**
 * Destinos possíveis: armazéns activos da empresa abertos ou visíveis ao membro (um restrito só para quem o vê). Quem
 * pede numa entidade legal pode enviar para outra (intragrupo) sem ter acesso de consulta a esse armazém.
 */
async function destinations(scope: TenantScope) {
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

export class TransferService {
  destinations(context: TenantContext) {
    return runInTenant(context, (scope) => destinations(scope))
  }

  list(
    context: TenantContext,
    f: { status?: string; warehouseId?: string; q?: string; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const ids = await readableWarehouseIds(scope)
      if (!ids.length) return { items: [], total: 0 }
      const where = [
        'x.tenant_id = ?',
        '(x.source_warehouse_id = any(?::uuid[]) or x.dest_warehouse_id = any(?::uuid[]))',
      ]
      const params: unknown[] = [context.tenantId, ids, ids]
      if (f.status) {
        where.push('x.status = ?')
        params.push(f.status)
      }
      if (f.warehouseId) {
        where.push('(x.source_warehouse_id = ? or x.dest_warehouse_id = ?)')
        params.push(f.warehouseId, f.warehouseId)
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(
          `(lower(coalesce(x.number, '')) like ? or lower(coalesce(x.intercompany_ref, '')) like ?)`
        )
        params.push(like, like)
      }
      const cl = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `select x.*, x.requested_date::text as requested_text, sw.code as src_code, dw.code as dst_code,
            (select count(*)::int from stock_transfer_lines l where l.tenant_id = x.tenant_id and l.transfer_id = x.id) as line_count
           from stock_transfers x
           join warehouses sw on sw.tenant_id = x.tenant_id and sw.id = x.source_warehouse_id
           join warehouses dw on dw.tenant_id = x.tenant_id and dw.id = x.dest_warehouse_id
          where ${cl} order by x.created_at desc limit ? offset ?`,
        [...params, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from stock_transfers x where ${cl}`,
        params as never[]
      )
      return {
        items: (rows.rows as any[]).map((x) => ({
          id: x.id as string,
          number: (x.number as string) ?? null,
          status: x.status as TransferStatus,
          intercompany: Boolean(x.intercompany),
          source: { warehouse: { id: x.source_warehouse_id, code: x.src_code } },
          dest: { warehouse: { id: x.dest_warehouse_id, code: x.dst_code } },
          requestedDate: x.requested_text as string,
          lineCount: Number(x.line_count),
        })),
        total: (count.rows[0] as { n: number }).n,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const t = await loadTransfer(scope, id)
      await visible(scope, t)
      return transferView(scope, id)
    })
  }

  create(context: TenantContext, raw: any) {
    return runInTenant(context, async (scope) => {
      const head = await headerInput(scope, raw, true)
      const src = await need(scope, raw.sourceWarehouseId, 'manage', 'origem')
      const dst = (await destinations(scope)).find((w) => w.id === raw.destWarehouseId)
      if (!dst)
        fail([
          {
            path: 'destWarehouseId',
            code: 'NOT_FOUND',
            message: 'Armazém de destino não encontrado ou inactivo.',
          },
        ])
      const lines = await normalizeLines(
        scope,
        raw.sourceWarehouseId,
        raw.destWarehouseId,
        raw?.lines
      )
      const intercompany = src.access.legalEntityId !== dst!.legalEntityId
      const ins = await scope.trx.rawQuery(
        `insert into stock_transfers (tenant_id, source_warehouse_id, dest_warehouse_id, source_legal_entity_id,
            dest_legal_entity_id, intercompany, intercompany_ref, requested_date, expected_date, notes, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          raw.sourceWarehouseId,
          raw.destWarehouseId,
          src.access.legalEntityId,
          dst!.legalEntityId,
          intercompany,
          head.intercompanyRef,
          head.requestedDate,
          head.expectedDate,
          head.notes,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (ins.rows[0] as { id: string }).id
      await insertLines(scope, { id, src: raw.sourceWarehouseId, dst: raw.destWarehouseId }, lines)
      await audit(scope, {
        action: 'inventory.transfer.created',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: {
          source: raw.sourceWarehouseId,
          dest: raw.destWarehouseId,
          intercompany,
          lines: lines.length,
        },
      })
      return transferView(scope, id)
    })
  }

  update(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const t = await loadTransfer(scope, id, true)
      await need(scope, t.source_warehouse_id, 'manage', 'origem')
      versionCheck(t, expectedVersion)
      stateCheck(t, 'edit')
      const head = await headerInput(
        scope,
        { ...raw, requestedDate: raw?.requestedDate ?? t.requested_text },
        false
      )
      const lines = await normalizeLines(
        scope,
        t.source_warehouse_id,
        t.dest_warehouse_id,
        raw?.lines
      )
      await scope.trx.rawQuery(
        'delete from stock_transfer_lines where tenant_id = ? and transfer_id = ?',
        [context.tenantId, id]
      )
      await insertLines(scope, { id, src: t.source_warehouse_id, dst: t.dest_warehouse_id }, lines)
      await touch(scope, id, {
        requested_date: head.requestedDate,
        expected_date: head.expectedDate,
        intercompany_ref: head.intercompanyRef,
        notes: head.notes,
      })
      await audit(scope, {
        action: 'inventory.transfer.updated',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: { lines: lines.length },
      })
      return transferView(scope, id)
    })
  }

  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const t = await loadTransfer(scope, id, true)
      await need(scope, t.source_warehouse_id, 'manage', 'origem')
      versionCheck(t, expectedVersion)
      stateCheck(t, 'submit')
      await touch(scope, id, {
        status: 'REQUESTED',
        submitted_by: context.userId,
        submitted_at: new Date(),
      })
      await audit(scope, {
        action: 'inventory.transfer.submitted',
        entityType: 'stock_transfer',
        entityId: id,
      })
      return transferView(scope, id)
    })
  }

  /** Aprovação (origem) ou aceitação (destino, só intragrupo). Completa, numera e reserva na origem. */
  approve(context: TenantContext, id: string, expectedVersion: number, side: 'source' | 'dest') {
    return runInTenant(context, async (scope) => {
      const t = await loadTransfer(scope, id, true)
      await need(
        scope,
        side === 'source' ? t.source_warehouse_id : t.dest_warehouse_id,
        'approve',
        side === 'source' ? 'origem' : 'destino'
      )
      versionCheck(t, expectedVersion)
      stateCheck(t, side === 'source' ? 'approve' : 'accept')
      if (side === 'dest' && !t.intercompany)
        throw ApiError.conflict(
          'NOT_INTERCOMPANY',
          'Só as transferências entre entidades legais têm aceitação do destino.'
        )
      if (selfApproval(t.submitted_by, context.userId))
        throw ApiError.forbidden(
          'SELF_APPROVAL',
          'Quem pediu a transferência não a pode aprovar nem aceitar.'
        )
      if (side === 'source' && t.approved_at)
        throw ApiError.conflict('ALREADY_APPROVED', 'Já aprovada pela origem.')
      if (side === 'dest' && t.accepted_at)
        throw ApiError.conflict('ALREADY_ACCEPTED', 'Já aceite pelo destino.')
      const set: Record<string, unknown> =
        side === 'source'
          ? { approved_by: context.userId, approved_at: new Date() }
          : { accepted_by: context.userId, accepted_at: new Date() }
      const complete = approvalComplete({
        intercompany: Boolean(t.intercompany),
        approved: side === 'source' || !!t.approved_at,
        accepted: side === 'dest' || !!t.accepted_at,
      })
      if (complete) Object.assign(set, await completeApproval(scope, t))
      await touch(scope, id, set)
      await audit(scope, {
        action: side === 'source' ? 'inventory.transfer.approved' : 'inventory.transfer.accepted',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: { complete, number: set.number ?? null },
      })
      return transferView(scope, id)
    })
  }

  reject(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const t = await loadTransfer(scope, id, true)
      const src = await rightsOn(scope, t.source_warehouse_id)
      const dst = await rightsOn(scope, t.dest_warehouse_id)
      if (!src?.approve && !(t.intercompany && dst?.approve))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova esta transferência.')
      versionCheck(t, expectedVersion)
      stateCheck(t, 'reject')
      await touch(scope, id, { status: 'REJECTED', reject_reason: reason })
      await audit(scope, {
        action: 'inventory.transfer.rejected',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: { reason },
      })
      return transferView(scope, id)
    })
  }

  /** Separação: quantidades efectivamente separadas na origem (menos do que o pedido é permitido). */
  pick(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const t = await loadTransfer(scope, id, true)
      await need(scope, t.source_warehouse_id, 'manage', 'origem')
      versionCheck(t, expectedVersion)
      stateCheck(t, 'pick')
      const lines = await lineRows(scope, id)
      const given = new Map<string, any>()
      for (const x of Array.isArray(raw?.lines) ? raw.lines : [])
        if (isUuid(x?.lineId)) given.set(x.lineId, x)
      const issues: ErrorDetail[] = []
      const ups: { id: string; q: bigint }[] = []
      lines.forEach((l, i) => {
        const g = given.get(l.id)
        const q = g ? scaled(g.pickedQuantity, SCALE) : 0n
        const max = dec(l.quantity)
        if (q === null || q > max)
          return issues.push({
            path: `lines.${i}.pickedQuantity`,
            code: 'INVALID',
            message: 'Separado entre 0 e o pedido.',
          })
        if (l.track_serials && q !== 0n && q !== max)
          return issues.push({
            path: `lines.${i}.pickedQuantity`,
            code: 'INVALID',
            message: 'Linhas com séries separam-se por inteiro.',
          })
        ups.push({ id: l.id, q })
      })
      fail(issues)
      if (!ups.some((u) => u.q > 0n))
        fail([
          { path: 'lines', code: 'NOTHING_PICKED', message: 'Separe pelo menos uma quantidade.' },
        ])
      for (const u of ups)
        await scope.trx.rawQuery(
          'update stock_transfer_lines set picked_quantity = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?',
          [txt(u.q), context.tenantId, u.id] as never[]
        )
      await touch(scope, id, { status: 'PICKED', picked_by: context.userId, picked_at: new Date() })
      await audit(scope, {
        action: 'inventory.transfer.picked',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: { short: ups.filter((u, i) => u.q < dec(lines[i].quantity)).length },
      })
      return transferView(scope, id)
    })
  }

  /** Expedição: sai da origem (consumindo a reserva toda), fica em trânsito no destino. */
  dispatch(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const key = keyCheck(raw?.idempotencyKey)
      const t = await loadTransfer(scope, id, true)
      await need(scope, t.source_warehouse_id, 'manage', 'origem')
      if (await eventDone(scope, id, `dispatch-${key}`)) return transferView(scope, id)
      versionCheck(t, expectedVersion)
      stateCheck(t, 'dispatch')
      const ref = text(raw?.intercompanyRef, 60) ?? t.intercompany_ref
      if (t.intercompany && !ref)
        fail([
          {
            path: 'intercompanyRef',
            code: 'REQUIRED',
            message:
              'Entre entidades legais indique a referência do documento comercial (venda/compra intragrupo).',
          },
        ])
      const lines = await lineRows(scope, id)
      const ship = lines.map((l) => ({
        l,
        q: toShip({
          quantity: dec(l.quantity),
          picked: l.picked_quantity === null ? null : dec(l.picked_quantity),
        }),
      }))
      if (!ship.some((s) => s.q > 0n))
        fail([{ path: 'lines', code: 'NOTHING_TO_SHIP', message: 'Nada separado para expedir.' }])
      const stock: PostStockLineInput[] = []
      for (const { l, q } of ship) {
        // A reserva sai por inteiro (o que não segue fica livre de novo).
        if (l.source_bucket === 'UNRESTRICTED')
          stock.push({
            warehouseId: t.source_warehouse_id,
            locationId: null,
            productId: l.product_id,
            variantId: l.variant_id,
            bucket: 'RESERVED',
            quantity: `-${txt(dec(l.quantity))}`,
          })
        if (q === 0n) continue
        stock.push({
          warehouseId: t.source_warehouse_id,
          locationId: l.source_location_id,
          productId: l.product_id,
          variantId: l.variant_id,
          bucket: l.source_bucket,
          quantity: `-${txt(q)}`,
        })
        stock.push({
          warehouseId: t.dest_warehouse_id,
          locationId: null,
          productId: l.product_id,
          variantId: l.variant_id,
          bucket: 'IN_TRANSIT',
          quantity: txt(q),
        })
      }
      await post(
        scope,
        t,
        'DISPATCH',
        `dispatch-${key}`,
        stock,
        ship.filter((s) => s.q > 0n).map((s) => ({ lineId: s.l.id, quantity: s.q })),
        null
      )
      for (const { l, q } of ship)
        await scope.trx.rawQuery(
          'update stock_transfer_lines set shipped_quantity = ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?',
          [txt(q), context.tenantId, l.id] as never[]
        )
      await touch(scope, id, {
        status: 'IN_TRANSIT',
        dispatched_by: context.userId,
        dispatched_at: new Date(),
        carrier: text(raw?.carrier, 120),
        tracking_ref: text(raw?.trackingRef, 60),
        intercompany_ref: ref,
      })
      await audit(scope, {
        action: 'inventory.transfer.dispatched',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: { number: t.number, lines: ship.filter((s) => s.q > 0n).length },
      })
      return transferView(scope, id)
    })
  }

  /** Recepção (parcial ou total) no destino: sai do trânsito, entra na localização e estado de destino. */
  receive(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const key = keyCheck(raw?.idempotencyKey)
      const t = await loadTransfer(scope, id, true)
      await need(scope, t.dest_warehouse_id, 'manage', 'destino')
      if (await eventDone(scope, id, `receive-${key}`)) return transferView(scope, id)
      versionCheck(t, expectedVersion)
      stateCheck(t, 'receive')
      const lines = await lineRows(scope, id)
      const dst = await locationMap(scope, t.dest_warehouse_id)
      const given = new Map<string, any>()
      for (const x of Array.isArray(raw?.lines) ? raw.lines : [])
        if (isUuid(x?.lineId)) given.set(x.lineId, x)
      const issues: ErrorDetail[] = []
      const rec: { l: any; q: bigint; loc: string | null }[] = []
      lines.forEach((l, i) => {
        const g = given.get(l.id)
        if (!g) return
        const q = scaled(g.quantity, SCALE)
        const transit = dec(l.shipped_quantity) - dec(l.received_quantity) - dec(l.lost_quantity)
        if (q === null)
          return issues.push({
            path: `lines.${i}.quantity`,
            code: 'INVALID',
            message: 'Quantidade inválida.',
          })
        const msg = receiveIssue(q, transit)
        if (msg) return issues.push({ path: `lines.${i}.quantity`, code: 'INVALID', message: msg })
        if (l.track_serials && q !== 0n && q !== transit)
          return issues.push({
            path: `lines.${i}.quantity`,
            code: 'INVALID',
            message: 'Linhas com séries recebem-se por inteiro.',
          })
        let loc: string | null = l.dest_location_id
        if (g.destLocationId) {
          const x = isUuid(g.destLocationId) ? dst.get(g.destLocationId) : null
          if (!x || !x.holds_stock || x.status !== 'ACTIVE')
            return issues.push({
              path: `lines.${i}.destLocationId`,
              code: 'INVALID',
              message: 'Localização de destino inválida.',
            })
          loc = x.id
        }
        if (q > 0n) rec.push({ l, q, loc })
      })
      fail(issues)
      if (!rec.length)
        fail([{ path: 'lines', code: 'NOTHING_RECEIVED', message: 'Indique o que foi recebido.' }])
      const stock: PostStockLineInput[] = rec.flatMap(({ l, q, loc }) => [
        {
          warehouseId: t.dest_warehouse_id,
          locationId: null,
          productId: l.product_id,
          variantId: l.variant_id,
          bucket: 'IN_TRANSIT',
          quantity: `-${txt(q)}`,
        },
        {
          warehouseId: t.dest_warehouse_id,
          locationId: loc,
          productId: l.product_id,
          variantId: l.variant_id,
          bucket: l.source_bucket,
          quantity: txt(q),
        },
      ])
      await post(
        scope,
        t,
        'RECEIVE',
        `receive-${key}`,
        stock,
        rec.map((r) => ({ lineId: r.l.id, quantity: r.q, destLocationId: r.loc })),
        null
      )
      for (const r of rec)
        await scope.trx.rawQuery(
          'update stock_transfer_lines set received_quantity = received_quantity + ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?',
          [txt(r.q), context.tenantId, r.l.id] as never[]
        )
      const after = await lineRows(scope, id)
      const status = statusAfterReceipt(
        after.map((l) => ({
          shipped: dec(l.shipped_quantity),
          received: dec(l.received_quantity),
          lost: dec(l.lost_quantity),
        }))
      )
      await touch(scope, id, { status, completed_at: status === 'RECEIVED' ? new Date() : null })
      await audit(scope, {
        action: 'inventory.transfer.received',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: { lines: rec.length, status },
      })
      return transferView(scope, id)
    })
  }

  /** Fecha o que ainda está em trânsito como perda (com motivo, aprovação no destino). */
  close(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const key = keyCheck(raw?.idempotencyKey)
      const reason = text(raw?.reason, 300)
      if (!reason)
        fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo da perda.' }])
      const t = await loadTransfer(scope, id, true)
      await need(scope, t.dest_warehouse_id, 'approve', 'destino')
      if (await eventDone(scope, id, `loss-${key}`)) return transferView(scope, id)
      versionCheck(t, expectedVersion)
      stateCheck(t, 'close')
      const lines = await lineRows(scope, id)
      const lost = lines
        .map((l) => ({
          l,
          q: dec(l.shipped_quantity) - dec(l.received_quantity) - dec(l.lost_quantity),
        }))
        .filter((x) => x.q > 0n)
      if (!lost.length)
        fail([{ path: 'lines', code: 'NOTHING_IN_TRANSIT', message: 'Nada em trânsito.' }])
      await post(
        scope,
        t,
        'LOSS',
        `loss-${key}`,
        lost.map(({ l, q }) => ({
          warehouseId: t.dest_warehouse_id,
          locationId: null,
          productId: l.product_id,
          variantId: l.variant_id,
          bucket: 'IN_TRANSIT',
          quantity: `-${txt(q)}`,
        })),
        lost.map((x) => ({ lineId: x.l.id, quantity: x.q })),
        reason
      )
      for (const x of lost)
        await scope.trx.rawQuery(
          'update stock_transfer_lines set lost_quantity = lost_quantity + ?, updated_at = now(), version = version + 1 where tenant_id = ? and id = ?',
          [txt(x.q), context.tenantId, x.l.id] as never[]
        )
      await touch(scope, id, { status: 'RECEIVED', completed_at: new Date(), close_reason: reason })
      await audit(scope, {
        action: 'inventory.transfer.closed',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: { reason, lines: lost.length },
      })
      return transferView(scope, id)
    })
  }

  /** Anula antes da expedição; se já havia reserva, liberta-a. */
  cancel(context: TenantContext, id: string, raw: any, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const reason = text(raw?.reason, 300)
      if (!reason) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
      const t = await loadTransfer(scope, id, true)
      await need(scope, t.source_warehouse_id, 'manage', 'origem')
      versionCheck(t, expectedVersion)
      stateCheck(t, 'cancel')
      if (t.status === 'APPROVED' || t.status === 'PICKED') {
        const lines = reservable(await lineRows(scope, id))
        if (lines.length)
          await post(
            scope,
            t,
            'RELEASE',
            'release',
            reserveLines(t, lines, '-'),
            lines.map((l) => ({ lineId: l.id, quantity: dec(l.quantity) })),
            reason
          )
      }
      await touch(scope, id, { status: 'CANCELLED', cancel_reason: reason })
      await audit(scope, {
        action: 'inventory.transfer.cancelled',
        entityType: 'stock_transfer',
        entityId: id,
        metadata: { reason },
      })
      return transferView(scope, id)
    })
  }
}
