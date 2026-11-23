import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { costCenterFacts, legalEntityFacts } from '#modules/organization/index'
import { rateOn, reserveDocumentNumber } from '#modules/settings/index'
import { supplierStanding } from '#modules/procurement/application/supplier_service'
import { allocateRequisition } from '#modules/procurement/application/requisition_service'
import {
  consumeContract,
  consumedByOrder,
  contractForOrder,
} from '#modules/procurement/application/contract_service'
import { committedValue } from '#modules/procurement/domain/contracts'
import {
  isDate,
  type Level,
  money,
  nextStep,
  parseScaled,
  requiredLevels,
  scaledText,
  toFunctional,
} from '#modules/procurement/domain/requisitions'
import {
  allocationDelta,
  APPROVAL_STATUSES,
  type ApprovalStatus,
  EDITABLE,
  INVOICE_STATUSES,
  type InvoiceStatus,
  normalizeOrderLines,
  ORDER_SERIES_TYPE,
  orderCan,
  orderLineAmounts,
  PAYMENT_METHODS,
  RECEIPT_STATUSES,
  type ReceiptStatus,
} from '#modules/procurement/domain/orders'
import { syncCommitments } from '#modules/procurement/application/finance_service'

/*
 * Ordens de compra (9.5). Permissões no âmbito da entidade legal: `procurement.orders.read`, `.manage` (criar,
 * alterar, pedir aprovação, emitir, rever, anular, fechar o resto) e `.approve` (decidir as etapas, que são as mesmas
 * das requisições, pelo total em moeda funcional — nunca quem pediu a aprovação nem duas etapas da mesma revisão).
 * A emissão afecta as linhas de requisição pelo contrato `allocateRequisition` (idempotente por linha e revisão); a
 * anulação e o fecho do resto devolvem o que não vem. Tudo auditado; aprovações, revisões e histórico só de acréscimo.
 */

const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const q6 = (v: unknown) => parseScaled(String(v ?? '0'), 6) ?? 0n
const c2 = (v: unknown) => parseScaled(String(v ?? '0'), 2) ?? 0n
const r3 = (v: unknown) => parseScaled(String(v ?? '0'), 3) ?? 0n
const today = () => new Date().toISOString().slice(0, 10)
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`)
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}
const isoDate = (v: unknown) => {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v as Date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface Scopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
}
async function scopesOf(scope: TenantScope): Promise<Scopes> {
  return {
    read: await permissionScope(scope, 'procurement.orders.read'),
    manage: await permissionScope(scope, 'procurement.orders.manage'),
    approve: await permissionScope(scope, 'procurement.orders.approve'),
  }
}
const covers = (s: PermissionScope, le: string) => s.tenant || s.legalEntityIds.has(le)
const rights = (s: Scopes, le: string) => {
  const manage = covers(s.manage, le)
  const approve = covers(s.approve, le)
  return { read: manage || approve || covers(s.read, le), manage, approve }
}

async function load(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) throw ApiError.notFound()
  const r = (
    await scope.trx.rawQuery(
      `select * from purchase_orders where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!r) throw ApiError.notFound()
  return r
}

async function authorized(
  scope: TenantScope,
  id: string,
  need: 'read' | 'manage' | 'approve',
  lock = false
) {
  const o = await load(scope, id, lock)
  const g = rights(await scopesOf(scope), o.legal_entity_id)
  if (!g.read) throw ApiError.notFound()
  if (need === 'manage' && !g.manage)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere ordens de compra desta entidade.')
  if (need === 'approve' && !g.approve)
    throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova ordens de compra desta entidade.')
  return { o, g }
}

const versionCheck = (o: any, expected: unknown) => {
  if (Number(o.version) !== Number(expected)) throw ApiError.versionConflict(Number(o.version))
}
const reasonOf = (v: unknown) => {
  const r = text(v)
  if (!r) fail([{ path: 'reason', code: 'REQUIRED', message: 'Indique o motivo.' }])
  if (r.length > 500) fail([{ path: 'reason', code: 'LENGTH', message: 'Até 500 caracteres.' }])
  return r
}

async function event(
  scope: TenantScope,
  id: string,
  kind: string,
  e: { revision?: number; reason?: string | null; details?: Record<string, unknown> } = {}
) {
  await scope.trx.rawQuery(
    `insert into purchase_order_events (tenant_id, order_id, kind, revision, reason, details, created_by, updated_by)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scope.context.tenantId,
      id,
      kind,
      e.revision ?? null,
      e.reason ?? null,
      e.details ? JSON.stringify(e.details) : null,
      scope.context.userId,
      scope.context.userId,
    ] as never[]
  )
}

async function setOrder(scope: TenantScope, id: string, set: Record<string, unknown>) {
  const keys = Object.keys(set)
  await scope.trx.rawQuery(
    `update purchase_orders set ${keys.map((k) => `${k} = ?, `).join('')}updated_by = ?, updated_at = now(),
        version = version + 1 where tenant_id = ? and id = ?`,
    [...keys.map((k) => set[k]), scope.context.userId, scope.context.tenantId, id] as never[]
  )
}

async function linesOfOrder(scope: TenantScope, id: string, lock = false) {
  return (
    await scope.trx.rawQuery(
      `select * from purchase_order_lines where tenant_id = ? and order_id = ? order by line_no${lock ? ' for update' : ''}`,
      [scope.context.tenantId, id]
    )
  ).rows as any[]
}

async function myRoleIds(scope: TenantScope) {
  const r = await scope.trx.rawQuery(
    `select role_id from membership_roles where tenant_id = ? and membership_id = ?`,
    [scope.context.tenantId, scope.context.membershipId]
  )
  return new Set((r.rows as any[]).map((x) => x.role_id as string))
}

async function decisionsOf(scope: TenantScope, id: string, round: number) {
  return (
    await scope.trx.rawQuery(
      `select a.*, u.full_name from purchase_order_approvals a left join users u on u.id = a.decided_by_user_id
        where a.tenant_id = ? and a.order_id = ? and a.round = ? order by a.sequence`,
      [scope.context.tenantId, id, round]
    )
  ).rows as any[]
}

/** Próxima etapa e se eu a posso decidir (as mesmas regras das requisições). */
async function stepFor(scope: TenantScope, o: any) {
  const decided = await decisionsOf(scope, o.id, Number(o.approval_round))
  return nextStep(
    (o.required_levels as Level[]) ?? [],
    decided.map((d) => ({
      sequence: Number(d.sequence),
      membershipId: d.decided_by_membership_id,
    })),
    {
      membershipId: scope.context.membershipId,
      isRequester: o.submitted_by_membership_id === scope.context.membershipId,
      roleIds: await myRoleIds(scope),
    }
  )
}

/** Cabeçalho: entidade (só ao criar), fornecedor homologado, filial, centro de custo, armazém, datas e condições. */
async function header(
  scope: TenantScope,
  s: Scopes,
  input: Record<string, unknown>,
  current: any | null
) {
  const t = scope.context.tenantId
  const issues: ErrorDetail[] = []
  let leId: string = current?.legal_entity_id ?? ''
  if (!current) {
    if (!isUuid(input.legalEntityId))
      issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Entidade legal.' })
    else {
      const le = await legalEntityFacts(scope, input.legalEntityId)
      if (!le)
        issues.push({ path: 'legalEntityId', code: 'NOT_FOUND', message: 'Entidade inexistente.' })
      else if (!covers(s.manage, le.id))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere ordens de compra desta entidade.')
      else leId = le.id
    }
  }
  const le = leId ? await legalEntityFacts(scope, leId) : null
  // Fornecedor: fixo depois da primeira emissão.
  let supplier: any = null
  const supplierId = current?.number ? current.supplier_id : input.supplierId
  if (!isUuid(supplierId))
    issues.push({ path: 'supplierId', code: 'REQUIRED', message: 'Fornecedor.' })
  else {
    const st = await supplierStanding(scope, supplierId)
    supplier = (
      await scope.trx.rawQuery(
        `select id, currency, payment_terms_days, payment_method, incoterm from suppliers where tenant_id = ? and id = ?`,
        [t, supplierId]
      )
    ).rows[0]
    if (!st || !supplier)
      issues.push({ path: 'supplierId', code: 'NOT_FOUND', message: 'Fornecedor inexistente.' })
    else if (!st.canOrder)
      issues.push({
        path: 'supplierId',
        code: 'NOT_QUALIFIED',
        message: 'Fornecedor não homologado ou com documentos obrigatórios fora de validade.',
      })
  }
  const ref = async (field: string, table: string, extra = '') => {
    const v = input[field]
    if (v === undefined || v === null || v === '') return null
    if (!isUuid(v)) {
      issues.push({ path: field, code: 'INVALID', message: 'Identificador inválido.' })
      return null
    }
    const row = (
      await scope.trx.rawQuery(`select * from ${table} where tenant_id = ? and id = ?${extra}`, [
        t,
        v,
      ])
    ).rows[0] as any
    if (!row || (leId && row.legal_entity_id !== leId) || (row.status && row.status !== 'ACTIVE')) {
      issues.push({
        path: field,
        code: 'NOT_FOUND',
        message: 'Inexistente, inactivo ou de outra entidade.',
      })
      return null
    }
    return row.id as string
  }
  const branchId = await ref('branchId', 'branches')
  let costCenterId: string | null = null
  if (input.costCenterId) {
    const cc = isUuid(input.costCenterId)
      ? (await costCenterFacts(scope, [input.costCenterId])).get(input.costCenterId)
      : undefined
    if (!cc || cc.legalEntityId !== leId || cc.status !== 'ACTIVE')
      issues.push({
        path: 'costCenterId',
        code: 'NOT_FOUND',
        message: 'Centro de custo inexistente, inactivo ou de outra entidade.',
      })
    else costCenterId = cc.id
  }
  const warehouseId = await ref('warehouseId', 'warehouses')
  const orderDate =
    input.orderDate === undefined || input.orderDate === '' ? today() : input.orderDate
  if (!isDate(orderDate))
    issues.push({ path: 'orderDate', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  const expected = input.expectedDate ? input.expectedDate : null
  if (expected !== null && (!isDate(expected) || (isDate(orderDate) && expected < orderDate)))
    issues.push({
      path: 'expectedDate',
      code: 'INVALID',
      message: 'Data de entrega igual ou posterior à da ordem.',
    })
  const currency = current?.number
    ? current.currency
    : text(input.currency).toUpperCase() ||
      current?.currency ||
      supplier?.currency ||
      le?.functionalCurrency ||
      ''
  if (!/^[A-Z]{3}$/.test(currency))
    issues.push({ path: 'currency', code: 'INVALID', message: 'Moeda: 3 letras.' })
  let terms: number | null = current
    ? (current.payment_terms_days ?? null)
    : (supplier?.payment_terms_days ?? null)
  if (
    input.paymentTermsDays !== undefined &&
    input.paymentTermsDays !== null &&
    input.paymentTermsDays !== ''
  ) {
    const n = Number(input.paymentTermsDays)
    if (!Number.isInteger(n) || n < 0 || n > 365)
      issues.push({
        path: 'paymentTermsDays',
        code: 'INVALID',
        message: 'Prazo de pagamento: 0 a 365 dias.',
      })
    else terms = n
  }
  const method = input.paymentMethod
    ? input.paymentMethod
    : current
      ? (current.payment_method ?? null)
      : (supplier?.payment_method ?? null)
  if (method !== null && !PAYMENT_METHODS.includes(method as never))
    issues.push({ path: 'paymentMethod', code: 'INVALID', message: 'Meio de pagamento inválido.' })
  const incoterm =
    text(input.incoterm).toUpperCase() || (current ? current.incoterm : supplier?.incoterm) || null
  if (incoterm && !/^[A-Z]{3}$/.test(incoterm))
    issues.push({ path: 'incoterm', code: 'INVALID', message: 'Incoterm: 3 letras.' })
  const str = (field: string, max: number) => {
    const v = text(input[field]) || null
    if (v && v.length > max)
      issues.push({ path: field, code: 'LENGTH', message: `Até ${max} caracteres.` })
    return v
  }
  const values = {
    legal_entity_id: leId,
    branch_id: branchId,
    supplier_id: supplierId as string,
    cost_center_id: costCenterId,
    warehouse_id: warehouseId,
    currency,
    order_date: orderDate,
    expected_date: expected,
    payment_terms_days: terms,
    payment_method: method,
    incoterm,
    delivery_terms: str('deliveryTerms', 500),
    delivery_address: str('deliveryAddress', 500),
    supplier_reference: str('supplierReference', 60),
    notes: str('notes', 4000),
    // Contrato: fixo depois da primeira emissão; validado em `contractOf`.
    contract_id: (current?.number
      ? current.contract_id
      : isUuid(input.contractId)
        ? input.contractId
        : null) as string | null,
  }
  if (input.contractId && !isUuid(input.contractId) && !current?.number)
    issues.push({ path: 'contractId', code: 'INVALID', message: 'Identificador inválido.' })
  return { issues, values }
}

/** O contrato da ordem (se houver): encaixe com a entidade, fornecedor, moeda e data; devolve os preços. */
async function contractOf(scope: TenantScope, v: Record<string, any>) {
  if (!v.contract_id) return null
  return contractForOrder(scope, v.contract_id, {
    legalEntityId: v.legal_entity_id,
    supplierId: v.supplier_id,
    currency: v.currency,
    orderDate: isoDate(v.order_date)!,
  })
}

/** Valor líquido em vigor da ordem (o que consome do contrato). */
async function orderCommitted(scope: TenantScope, id: string) {
  return committedValue(
    (await linesOfOrder(scope, id)).map((l) => ({
      quantity: q6(l.quantity),
      cancelled: q6(l.cancelled_quantity),
      net: c2(l.net_amount),
    }))
  )
}

/** Acerta o consumo do contrato da ordem com o valor em vigor (emissão, fecho do resto, anulação). */
async function syncContract(scope: TenantScope, o: any, key: string, target?: bigint) {
  if (!o.contract_id) return
  const want = target ?? (await orderCommitted(scope, o.id))
  const delta = want - (await consumedByOrder(scope, o.contract_id, o.id))
  await consumeContract(scope, {
    contractId: o.contract_id,
    orderId: o.id,
    orderRevision: Number(o.revision),
    amount: delta,
    key: `po:${o.id}:${key}`,
  })
}

/** Linhas: catálogo ou descrição livre, requisição aprovada da mesma entidade; existentes por id, sem baixar do recebido. */
async function linesOf(
  scope: TenantScope,
  leId: string,
  raw: unknown,
  existing: any[],
  contractPrices?: Map<string, bigint> | null
) {
  const t = scope.context.tenantId
  const { lines, issues } = normalizeOrderLines(raw)
  const byId = new Map(existing.map((l) => [l.id as string, l]))
  const out: any[] = []
  for (const [i, l] of lines.entries()) {
    const at = (field: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${field}`, code, message })
    const cur = l.id ? byId.get(l.id) : undefined
    if (l.id && !cur) at('id', 'NOT_FOUND', 'Linha que não é desta ordem.')
    let { productId, variantId, uomId, description } = l
    // Linha existente: o que não vem no pedido mantém-se (um PUT parcial não apaga o produto da linha).
    const src = (Array.isArray(raw) ? raw[i] : null) ?? {}
    if (cur) {
      if (!('productId' in src)) productId = cur.product_id
      if (!('variantId' in src)) variantId = cur.variant_id
      if (!('uomId' in src)) uomId = cur.uom_id
      if (!('description' in src)) description = cur.description
    }
    let requisitionLineId = cur ? cur.requisition_line_id : l.requisitionLineId
    if (requisitionLineId && !cur) {
      const x = (
        await scope.trx.rawQuery(
          `select rl.*, r.legal_entity_id, r.status as req_status from purchase_requisition_lines rl
             join purchase_requisitions r on r.tenant_id = rl.tenant_id and r.id = rl.requisition_id
            where rl.tenant_id = ? and rl.id = ?`,
          [t, requisitionLineId]
        )
      ).rows[0] as any
      if (!x || !['APPROVED', 'PARTIALLY_ORDERED'].includes(x.req_status))
        at('requisitionLineId', 'NOT_FOUND', 'Linha de requisição inexistente ou não aprovada.')
      else if (x.legal_entity_id !== leId)
        at('requisitionLineId', 'OTHER_LEGAL_ENTITY', 'A requisição é de outra entidade.')
      else {
        const open = q6(x.quantity) - q6(x.ordered_quantity) - q6(x.closed_quantity)
        if (l.quantity > open)
          at('quantity', 'OVER_OPEN', `A requisição só tem ${scaledText(open, 6)} em aberto.`)
        productId = x.product_id
        variantId = x.variant_id
        uomId = x.uom_id
        description ||= x.description
      }
    }
    if (cur && q6(cur.received_quantity) > 0n) {
      if (l.quantity < q6(cur.received_quantity))
        at(
          'quantity',
          'BELOW_RECEIVED',
          `Já foram recebidas ${scaledText(q6(cur.received_quantity), 6)}.`
        )
      if (productId !== cur.product_id || uomId !== cur.uom_id)
        at(
          'productId',
          'LINE_HAS_RECEIPTS',
          'Linha com recepções: o produto e a unidade não mudam.'
        )
    }
    if (cur && l.quantity < q6(cur.invoiced_quantity))
      at(
        'quantity',
        'BELOW_INVOICED',
        `Já foram facturadas ${scaledText(q6(cur.invoiced_quantity), 6)}.`
      )
    let productType: string | null = null
    if (productId) {
      const p = (
        await scope.trx.rawQuery(
          `select name, status, product_type, base_uom_id, purchase_uom_id from products where tenant_id = ? and id = ?`,
          [t, productId]
        )
      ).rows[0] as any
      if (!p || p.status !== 'ACTIVE' || p.product_type === 'KIT')
        at('productId', 'NOT_FOUND', 'Produto inexistente, inactivo ou kit.')
      else {
        productType = p.product_type
        description ||= p.name
        uomId ||= p.purchase_uom_id ?? p.base_uom_id
      }
      // Com contrato: o preço não passa o da tabela do contrato para este produto (ou variante).
      const cp =
        contractPrices?.get(`${productId}|${variantId ?? ''}`) ??
        contractPrices?.get(`${productId}|`)
      if (cp !== undefined && l.unitPrice > cp)
        at(
          'unitPrice',
          'PRICE_ABOVE_CONTRACT',
          `O contrato fixa ${scaledText(cp, 6)} para este produto.`
        )
    }
    if (description.length < 3)
      at('description', 'REQUIRED', 'Produto do catálogo ou descrição (3 a 300 caracteres).')
    let uomCode: string | null = null
    if (uomId) {
      const u = (
        await scope.trx.rawQuery(`select code, status from uoms where tenant_id = ? and id = ?`, [
          t,
          uomId,
        ])
      ).rows[0] as any
      if (!u || u.status !== 'ACTIVE') at('uomId', 'NOT_FOUND', 'Unidade inexistente ou inactiva.')
      else uomCode = u.code
    }
    out.push({
      ...l,
      productId,
      variantId,
      uomId,
      uomCode,
      description,
      requisitionLineId,
      productType,
      cur,
    })
  }
  fail(issues)
  return out
}

/** Grava as linhas (actualiza por id, acrescenta, remove as que saíram — devolvendo a afectação) e os totais. */
async function writeLines(scope: TenantScope, o: any, lines: any[], existing: any[]) {
  const t = scope.context.tenantId
  const u = scope.context.userId
  const keep = new Set(lines.filter((l) => l.cur).map((l) => l.cur.id as string))
  for (const x of existing.filter((e) => !keep.has(e.id))) {
    if (q6(x.received_quantity) > 0n || q6(x.invoiced_quantity) > 0n)
      fail([
        {
          path: 'lines',
          code: 'LINE_HAS_MOVEMENT',
          message: `A linha ${x.line_no} tem recepções ou facturas: não se retira.`,
        },
      ])
    if (q6(x.allocated_quantity) > 0n) {
      await allocateRequisition(scope, {
        lineId: x.requisition_line_id,
        quantity: `-${scaledText(q6(x.allocated_quantity), 6)}`,
        sourceType: 'PURCHASE_ORDER',
        sourceId: o.id,
        sourceLineId: x.id,
        idempotencyKey: `po:${x.id}:del:${o.revision}`,
      })
      await scope.trx.rawQuery(
        `update purchase_order_lines set allocated_quantity = 0 where tenant_id = ? and id = ?`,
        [t, x.id]
      )
    }
    await scope.trx.rawQuery(`delete from purchase_order_lines where tenant_id = ? and id = ?`, [
      t,
      x.id,
    ])
  }
  let next = existing.reduce((m, e) => Math.max(m, Number(e.line_no)), 0)
  const tot = { gross: 0n, discount: 0n, net: 0n, tax: 0n, total: 0n }
  for (const l of lines) {
    const a = orderLineAmounts(l.quantity, l.unitPrice, l.discountRate, l.taxRate)
    for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += a[k]
    const vals = [
      l.productId,
      l.variantId,
      l.description,
      l.uomId,
      l.uomCode,
      scaledText(l.quantity, 6),
      scaledText(l.unitPrice, 6),
      scaledText(l.discountRate, 3),
      scaledText(l.taxRate, 3),
      money(a.gross),
      money(a.discount),
      money(a.net),
      money(a.tax),
      money(a.total),
      l.expectedDate,
      l.notes,
    ]
    if (l.cur)
      await scope.trx.rawQuery(
        `update purchase_order_lines set product_id = ?, variant_id = ?, description = ?, uom_id = ?, uom_code = ?,
            quantity = ?, unit_price = ?, discount_rate = ?, tax_rate = ?, gross_amount = ?, discount_amount = ?,
            net_amount = ?, tax_amount = ?, total_amount = ?, expected_date = ?, notes = ?, updated_by = ?,
            updated_at = now(), version = version + 1 where tenant_id = ? and id = ?`,
        [...vals, u, t, l.cur.id] as never[]
      )
    else
      await scope.trx.rawQuery(
        `insert into purchase_order_lines (tenant_id, order_id, line_no, product_id, variant_id, description, uom_id,
            uom_code, quantity, unit_price, discount_rate, tax_rate, gross_amount, discount_amount, net_amount,
            tax_amount, total_amount, expected_date, notes, requisition_line_id, award_line_id, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t, o.id, ++next, ...vals, l.requisitionLineId, l.awardLineId ?? null, u, u] as never[]
      )
  }
  return {
    total_gross: money(tot.gross),
    total_discount: money(tot.discount),
    total_net: money(tot.net),
    total_tax: money(tot.tax),
    total_amount: money(tot.total),
  }
}

/** Armazém exigido quando há produtos armazenáveis (a recepção do 9.7 dá entrada nele). */
async function warehouseRule(scope: TenantScope, o: any) {
  const r = await scope.trx.rawQuery(
    `select count(*)::int as n from purchase_order_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where l.tenant_id = ? and l.order_id = ? and p.product_type = 'STOCKABLE'`,
    [scope.context.tenantId, o.id]
  )
  if (Number((r.rows[0] as any).n) > 0 && !o.warehouse_id)
    fail([
      {
        path: 'warehouseId',
        code: 'WAREHOUSE_REQUIRED',
        message: 'Há produtos armazenáveis: indique o armazém de entrega.',
      },
    ])
}

async function detail(scope: TenantScope, id: string) {
  const { o, g } = await authorized(scope, id, 'read')
  const t = scope.context.tenantId
  const info = (
    await scope.trx.rawQuery(
      `select le.code as le_code, bp.code as sup_code, bp.name as sup_name, b.code as branch_code, cc.code as cc_code,
          cc.name as cc_name, w.code as wh_code, w.name as wh_name, rq.number as rfq_number, rq.id as rfq_id, pc.number as contract_number, pc.title as contract_title,
          us.full_name as submitted_name, ui.full_name as issued_name
         from purchase_orders o
         join legal_entities le on le.tenant_id = o.tenant_id and le.id = o.legal_entity_id
         join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
         join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
         left join branches b on b.tenant_id = o.tenant_id and b.id = o.branch_id
         left join cost_centers cc on cc.tenant_id = o.tenant_id and cc.id = o.cost_center_id
         left join warehouses w on w.tenant_id = o.tenant_id and w.id = o.warehouse_id
         left join rfq_awards a on a.tenant_id = o.tenant_id and a.id = o.award_id
         left join purchase_contracts pc on pc.tenant_id = o.tenant_id and pc.id = o.contract_id
         left join rfqs rq on rq.tenant_id = a.tenant_id and rq.id = a.rfq_id
         left join users us on us.id = o.submitted_by
         left join users ui on ui.id = o.issued_by
        where o.tenant_id = ? and o.id = ?`,
      [t, id]
    )
  ).rows[0] as any
  const lines = (
    await scope.trx.rawQuery(
      `select l.*, p.sku, r.number as req_number, r.id as req_id from purchase_order_lines l
         left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
         left join purchase_requisition_lines rl on rl.tenant_id = l.tenant_id and rl.id = l.requisition_line_id
         left join purchase_requisitions r on r.tenant_id = rl.tenant_id and r.id = rl.requisition_id
        where l.tenant_id = ? and l.order_id = ? order by l.line_no`,
      [t, id]
    )
  ).rows as any[]
  const decided = await decisionsOf(scope, id, Number(o.approval_round))
  const revisions = (
    await scope.trx.rawQuery(
      `select r.revision, r.reason, r.total_amount, r.created_at, u.full_name from purchase_order_revisions r
         left join users u on u.id = r.created_by where r.tenant_id = ? and r.order_id = ? order by r.revision desc`,
      [t, id]
    )
  ).rows as any[]
  const events = (
    await scope.trx.rawQuery(
      `select e.*, u.full_name from purchase_order_events e left join users u on u.id = e.created_by
        where e.tenant_id = ? and e.order_id = ? order by e.created_at desc, e.id`,
      [t, id]
    )
  ).rows as any[]
  const approval = o.approval_status as ApprovalStatus
  const hasMovement = lines.some(
    (l) => q6(l.received_quantity) > 0n || q6(l.invoiced_quantity) > 0n
  )
  const can = orderCan({
    approval,
    issuedRevision: o.issued_revision === null ? null : Number(o.issued_revision),
    revision: Number(o.revision),
    receipt: o.receipt_status,
    invoice: o.invoice_status,
    closed: !!o.closed_at,
    hasMovement,
  })
  const step = approval === 'PENDING_APPROVAL' ? await stepFor(scope, o) : null
  const required = ((o.required_levels as Level[]) ?? []).map((l) => {
    const d = decided.find((x) => Number(x.sequence) === l.sequence)
    return {
      sequence: l.sequence,
      code: l.code,
      name: l.name,
      requiresRole: !!l.approverRoleId,
      decision: (d?.decision as string) ?? null,
      decidedBy: (d?.full_name as string) ?? null,
      decidedAt: d ? new Date(d.created_at).toISOString() : null,
      reason: (d?.reason as string) ?? null,
      current: step?.step?.sequence === l.sequence,
    }
  })
  return {
    id: o.id as string,
    version: Number(o.version),
    number: (o.number as string) ?? null,
    revision: Number(o.revision),
    issuedRevision: o.issued_revision === null ? null : Number(o.issued_revision),
    approvalStatus: approval,
    receiptStatus: o.receipt_status as ReceiptStatus,
    invoiceStatus: o.invoice_status as InvoiceStatus,
    closed: !!o.closed_at,
    legalEntity: { id: o.legal_entity_id as string, code: info.le_code as string },
    branch: o.branch_id ? { id: o.branch_id as string, code: info.branch_code as string } : null,
    supplier: {
      id: o.supplier_id as string,
      code: info.sup_code as string,
      name: info.sup_name as string,
    },
    costCenter: o.cost_center_id
      ? {
          id: o.cost_center_id as string,
          code: info.cc_code as string,
          name: info.cc_name as string,
        }
      : null,
    warehouse: o.warehouse_id
      ? { id: o.warehouse_id as string, code: info.wh_code as string, name: info.wh_name as string }
      : null,
    award: o.award_id
      ? {
          id: o.award_id as string,
          rfqId: info.rfq_id as string,
          rfqNumber: info.rfq_number as string,
        }
      : null,
    contract: o.contract_id
      ? {
          id: o.contract_id as string,
          number: info.contract_number as string,
          title: info.contract_title as string,
        }
      : null,
    currency: o.currency as string,
    exchangeRate: o.exchange_rate
      ? scaledText(parseScaled(String(o.exchange_rate), 10) ?? 0n, 10)
      : null,
    rateDate: isoDate(o.rate_date),
    orderDate: isoDate(o.order_date)!,
    expectedDate: isoDate(o.expected_date),
    paymentTermsDays: o.payment_terms_days ?? null,
    paymentMethod: (o.payment_method as string) ?? null,
    incoterm: (o.incoterm as string) ?? null,
    deliveryTerms: (o.delivery_terms as string) ?? null,
    deliveryAddress: (o.delivery_address as string) ?? null,
    supplierReference: (o.supplier_reference as string) ?? null,
    notes: (o.notes as string) ?? null,
    totalGross: money(c2(o.total_gross)),
    totalDiscount: money(c2(o.total_discount)),
    totalNet: money(c2(o.total_net)),
    totalTax: money(c2(o.total_tax)),
    totalAmount: money(c2(o.total_amount)),
    totalFunctional: o.total_functional === null ? null : money(c2(o.total_functional)),
    submittedAt: o.submitted_at ? new Date(o.submitted_at).toISOString() : null,
    submittedBy: (info.submitted_name as string) ?? null,
    approvedAt: o.approved_at ? new Date(o.approved_at).toISOString() : null,
    issuedAt: o.issued_at ? new Date(o.issued_at).toISOString() : null,
    issuedBy: (info.issued_name as string) ?? null,
    rejectReason: (o.reject_reason as string) ?? null,
    cancelReason: (o.cancel_reason as string) ?? null,
    closeReason: (o.close_reason as string) ?? null,
    lines: lines.map((l) => ({
      id: l.id as string,
      version: Number(l.version),
      lineNo: Number(l.line_no),
      product: l.product_id ? { id: l.product_id as string, sku: l.sku as string } : null,
      variantId: (l.variant_id as string) ?? null,
      description: l.description as string,
      uom: l.uom_id ? { id: l.uom_id as string, code: l.uom_code as string } : null,
      quantity: scaledText(q6(l.quantity), 6),
      unitPrice: scaledText(q6(l.unit_price), 6),
      discountRate: scaledText(r3(l.discount_rate), 3),
      taxRate: scaledText(r3(l.tax_rate), 3),
      grossAmount: money(c2(l.gross_amount)),
      discountAmount: money(c2(l.discount_amount)),
      netAmount: money(c2(l.net_amount)),
      taxAmount: money(c2(l.tax_amount)),
      totalAmount: money(c2(l.total_amount)),
      expectedDate: isoDate(l.expected_date),
      notes: (l.notes as string) ?? null,
      requisition: l.requisition_line_id
        ? {
            id: l.req_id as string,
            number: l.req_number as string,
            lineId: l.requisition_line_id as string,
          }
        : null,
      awardLineId: (l.award_line_id as string) ?? null,
      allocatedQuantity: scaledText(q6(l.allocated_quantity), 6),
      receivedQuantity: scaledText(q6(l.received_quantity), 6),
      invoicedQuantity: scaledText(q6(l.invoiced_quantity), 6),
      cancelledQuantity: scaledText(q6(l.cancelled_quantity), 6),
      openQuantity: scaledText(
        q6(l.quantity) - q6(l.received_quantity) - q6(l.cancelled_quantity),
        6
      ),
    })),
    approval: required,
    revisions: revisions.map((r) => ({
      revision: Number(r.revision),
      reason: r.reason as string,
      totalAmount: money(c2(r.total_amount)),
      at: new Date(r.created_at).toISOString(),
      by: (r.full_name as string) ?? null,
    })),
    history: events.map((e) => ({
      kind: e.kind as string,
      revision: e.revision ?? null,
      reason: (e.reason as string) ?? null,
      details: e.details ?? null,
      at: new Date(e.created_at).toISOString(),
      by: (e.full_name as string) ?? null,
    })),
    can: {
      edit: g.manage && can.edit,
      submit: g.manage && can.submit,
      decide: g.approve && can.decide && !!step?.allowed,
      decideBlockedBy: g.approve && can.decide && step && !step.allowed ? step.reason : null,
      issue: g.manage && can.issue,
      revise: g.manage && can.revise,
      close: g.manage && can.close,
      cancel: g.manage && can.cancel,
    },
  }
}

export type OrderDetail = Awaited<ReturnType<typeof detail>>

/** Afecta (ou devolve) à requisição a diferença entre o encomendado em vigor e o já afectado, linha a linha. */
async function syncAllocations(scope: TenantScope, o: any, key: string) {
  for (const l of await linesOfOrder(scope, o.id, true)) {
    if (!l.requisition_line_id) continue
    const delta = allocationDelta(
      q6(l.quantity),
      q6(l.cancelled_quantity),
      q6(l.allocated_quantity)
    )
    if (delta === 0n) continue
    await allocateRequisition(scope, {
      lineId: l.requisition_line_id,
      quantity: scaledText(delta, 6),
      sourceType: 'PURCHASE_ORDER',
      sourceId: o.id,
      sourceLineId: l.id,
      idempotencyKey: `po:${l.id}:${key}`,
    })
    await scope.trx.rawQuery(
      `update purchase_order_lines set allocated_quantity = ?, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?`,
      [scaledText(q6(l.allocated_quantity) + delta, 6), scope.context.tenantId, l.id] as never[]
    )
  }
}

/** Devolve à requisição tudo o que está afectado (anulação). */
async function releaseAll(scope: TenantScope, o: any) {
  for (const l of await linesOfOrder(scope, o.id, true)) {
    const a = q6(l.allocated_quantity)
    if (!l.requisition_line_id || a === 0n) continue
    await allocateRequisition(scope, {
      lineId: l.requisition_line_id,
      quantity: `-${scaledText(a, 6)}`,
      sourceType: 'PURCHASE_ORDER',
      sourceId: o.id,
      sourceLineId: l.id,
      idempotencyKey: `po:${l.id}:cancel`,
    })
    await scope.trx.rawQuery(
      `update purchase_order_lines set allocated_quantity = 0, updated_at = now(), version = version + 1
        where tenant_id = ? and id = ?`,
      [scope.context.tenantId, l.id]
    )
  }
}

export class PurchaseOrderService {
  list(
    context: TenantContext,
    f: {
      q?: string
      approvalStatus?: string
      receiptStatus?: string
      invoiceStatus?: string
      supplierId?: string
      awaitingMe?: boolean
      limit: number
      offset: number
    }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      const all = s.read.tenant || s.manage.tenant || s.approve.tenant
      const les = [
        ...new Set([
          ...s.read.legalEntityIds,
          ...s.manage.legalEntityIds,
          ...s.approve.legalEntityIds,
        ]),
      ]
      if (!all && !les.length) return { items: [], total: 0 }
      const where = ['o.tenant_id = ?']
      const params: unknown[] = [context.tenantId]
      if (!all) {
        where.push('o.legal_entity_id = any(?::uuid[])')
        params.push(les)
      }
      for (const [k, col, allowed] of [
        ['approvalStatus', 'o.approval_status', APPROVAL_STATUSES],
        ['receiptStatus', 'o.receipt_status', RECEIPT_STATUSES],
        ['invoiceStatus', 'o.invoice_status', INVOICE_STATUSES],
      ] as const) {
        const v = f[k]
        if (v && (allowed as readonly string[]).includes(v)) {
          where.push(`${col} = ?`)
          params.push(v)
        }
      }
      if (f.supplierId && isUuid(f.supplierId)) {
        where.push('o.supplier_id = ?')
        params.push(f.supplierId)
      }
      if (f.awaitingMe) where.push(`o.approval_status = 'PENDING_APPROVAL'`)
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        where.push(
          `(lower(coalesce(o.number, '')) like ? or lower(bp.name) like ? or lower(bp.code) like ?)`
        )
        params.push(like, like, like)
      }
      const from = `from purchase_orders o join suppliers s on s.tenant_id = o.tenant_id and s.id = o.supplier_id
        join business_partners bp on bp.tenant_id = s.tenant_id and bp.id = s.partner_id
        join legal_entities le on le.tenant_id = o.tenant_id and le.id = o.legal_entity_id
        where ${where.join(' and ')}`
      const rows = (
        await scope.trx.rawQuery(
          `select o.*, bp.code as sup_code, bp.name as sup_name, le.code as le_code ${from}
            order by o.created_at desc, o.id ${f.awaitingMe ? '' : 'limit ? offset ?'}`,
          (f.awaitingMe ? params : [...params, f.limit, f.offset]) as never[]
        )
      ).rows as any[]
      let items = rows
      let total = Number(
        (
          (await scope.trx.rawQuery(`select count(*)::int as n ${from}`, params as never[]))
            .rows[0] as any
        ).n
      )
      if (f.awaitingMe) {
        const keep: any[] = []
        for (const o of rows) {
          if (!covers(s.approve, o.legal_entity_id)) continue
          if ((await stepFor(scope, o)).allowed) keep.push(o)
        }
        total = keep.length
        items = keep.slice(f.offset, f.offset + f.limit)
      }
      return {
        items: items.map((o) => ({
          id: o.id as string,
          version: Number(o.version),
          number: (o.number as string) ?? null,
          revision: Number(o.revision),
          approvalStatus: o.approval_status as ApprovalStatus,
          receiptStatus: o.receipt_status as ReceiptStatus,
          invoiceStatus: o.invoice_status as InvoiceStatus,
          issued: o.issued_revision !== null,
          closed: !!o.closed_at,
          legalEntity: { id: o.legal_entity_id as string, code: o.le_code as string },
          supplier: {
            id: o.supplier_id as string,
            code: o.sup_code as string,
            name: o.sup_name as string,
          },
          orderDate: isoDate(o.order_date)!,
          expectedDate: isoDate(o.expected_date),
          currency: o.currency as string,
          totalAmount: money(c2(o.total_amount)),
          createdAt: new Date(o.created_at).toISOString(),
        })),
        total,
      }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, (scope) => detail(scope, id))
  }

  options(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!s.manage.tenant && !s.manage.legalEntityIds.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere ordens de compra.')
      const t = context.tenantId
      const q = (sql: string) => scope.trx.rawQuery(sql, [t]).then((r) => r.rows as any[])
      const les = (
        await q(
          `select id, code, functional_currency from legal_entities where tenant_id = ? order by code`
        )
      ).filter((l) => covers(s.manage, l.id))
      const suppliers: any[] = []
      for (const x of await q(
        `select s.id, s.currency, s.payment_terms_days, p.code, p.name from suppliers s join business_partners p
           on p.tenant_id = s.tenant_id and p.id = s.partner_id where s.tenant_id = ? and s.status = 'APPROVED' order by p.code`
      ))
        if ((await supplierStanding(scope, x.id))?.canOrder)
          suppliers.push({
            id: x.id,
            code: x.code,
            name: x.name,
            currency: x.currency,
            paymentTermsDays: x.payment_terms_days ?? null,
          })
      const leIds = new Set(les.map((l) => l.id))
      const byLe = (rows: any[]) =>
        rows
          .filter((r) => leIds.has(r.legal_entity_id))
          .map((r) => ({ id: r.id, code: r.code, name: r.name, legalEntityId: r.legal_entity_id }))
      return {
        legalEntities: les.map((l) => ({
          id: l.id,
          code: l.code,
          currency: l.functional_currency,
        })),
        suppliers,
        branches: byLe(
          await q(
            `select id, code, name, legal_entity_id from branches where tenant_id = ? and status = 'ACTIVE' order by code`
          )
        ),
        costCenters: byLe(
          await q(
            `select id, code, name, legal_entity_id from cost_centers where tenant_id = ? and status = 'ACTIVE' order by code`
          )
        ),
        warehouses: byLe(
          await q(
            `select id, code, name, legal_entity_id from warehouses where tenant_id = ? and status = 'ACTIVE' order by code`
          )
        ),
        // Contratos activos e em vigor hoje, com a tabela de preços (para sugerir o preço no formulário).
        contracts: await (async () => {
          const rows = (
            await scope.trx.rawQuery(
              `select id, number, title, legal_entity_id, supplier_id, currency, start_date, end_date,
                  (max_amount - consumed_amount)::text as remaining
                 from purchase_contracts where tenant_id = ? and status = 'ACTIVE'
                  and current_date between start_date and end_date order by number`,
              [t]
            )
          ).rows as any[]
          const prices = (
            await scope.trx.rawQuery(
              `select contract_id, product_id, variant_id, unit_price::text as unit_price from purchase_contract_prices
                where tenant_id = ? and contract_id = any(?::uuid[]) and product_id is not null`,
              [t, rows.map((r) => r.id)] as never[]
            )
          ).rows as any[]
          return rows
            .filter((r) => leIds.has(r.legal_entity_id))
            .map((r) => ({
              id: r.id as string,
              number: r.number as string,
              title: r.title as string,
              legalEntityId: r.legal_entity_id as string,
              supplierId: r.supplier_id as string,
              currency: r.currency as string,
              startDate: isoDate(r.start_date)!,
              endDate: isoDate(r.end_date)!,
              remaining: money(c2(r.remaining)),
              prices: prices
                .filter((p) => p.contract_id === r.id)
                .map((p) => ({
                  productId: p.product_id as string,
                  variantId: (p.variant_id as string) ?? null,
                  unitPrice: scaledText(q6(p.unit_price), 6),
                })),
            }))
        })(),
        uoms: await q(
          `select id, code, name from uoms where tenant_id = ? and status = 'ACTIVE' order by code`
        ),
        products: (
          await q(
            `select id, sku, name, product_type, coalesce(purchase_uom_id, base_uom_id) as uom_id from products
              where tenant_id = ? and status = 'ACTIVE' and product_type <> 'KIT' order by sku limit 1000`
          )
        ).map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          productType: p.product_type,
          uomId: p.uom_id,
        })),
      }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await scopesOf(scope)
      if (!s.manage.tenant && !s.manage.legalEntityIds.size)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere ordens de compra.')
      const h = await header(scope, s, input, null)
      fail(h.issues)
      const contract = await contractOf(scope, h.values)
      const lines = await linesOf(
        scope,
        h.values.legal_entity_id,
        input.lines,
        [],
        contract?.prices
      )
      const ins = await scope.trx.rawQuery(
        `insert into purchase_orders (tenant_id, ${Object.keys(h.values).join(', ')}, created_by, updated_by)
         values (?, ${Object.keys(h.values)
           .map(() => '?')
           .join(', ')}, ?, ?) returning *`,
        [context.tenantId, ...Object.values(h.values), context.userId, context.userId] as never[]
      )
      const o = ins.rows[0] as any
      const totals = await writeLines(scope, o, lines, [])
      await setOrder(scope, o.id, totals)
      await event(scope, o.id, 'CREATED', { revision: 0 })
      await audit(scope, {
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: o.id,
        changes: { totalAmount: { from: null, to: totals.total_amount } },
      })
      return detail(scope, o.id)
    })
  }

  update(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      if (!EDITABLE.includes(o.approval_status) || o.closed_at)
        throw ApiError.conflict('INVALID_STATE', 'Só se altera em rascunho ou recusada.')
      const s = await scopesOf(scope)
      const h = await header(scope, s, input, o)
      fail(h.issues)
      const existing = await linesOfOrder(scope, id, true)
      const contract = await contractOf(scope, { ...h.values, legal_entity_id: o.legal_entity_id })
      const lines = await linesOf(scope, o.legal_entity_id, input.lines, existing, contract?.prices)
      const values: Record<string, unknown> = { ...h.values }
      delete values.legal_entity_id
      await setOrder(scope, id, { ...values, approval_status: 'DRAFT', reject_reason: null })
      const totals = await writeLines(scope, o, lines, existing)
      await setOrder(scope, id, totals)
      await event(scope, id, 'UPDATED', { revision: Number(o.revision) })
      await audit(scope, {
        action: 'purchase_order.updated',
        entityType: 'purchase_order',
        entityId: id,
        changes: { totalAmount: { from: money(c2(o.total_amount)), to: totals.total_amount } },
      })
      return detail(scope, id)
    })
  }

  /** Pedir aprovação: fornecedor ainda apto, armazém quando preciso, câmbio do dia e etapas pelo total funcional. */
  submit(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      if (!EDITABLE.includes(o.approval_status) || o.closed_at)
        throw ApiError.conflict('INVALID_STATE', 'Só se pede aprovação de um rascunho ou recusada.')
      const t = context.tenantId
      if (!(await supplierStanding(scope, o.supplier_id))?.canOrder)
        throw ApiError.conflict('NOT_QUALIFIED', 'O fornecedor deixou de estar homologado.')
      if (!(await linesOfOrder(scope, id)).length)
        fail([{ path: 'lines', code: 'REQUIRED', message: 'A ordem não tem linhas.' }])
      await warehouseRule(scope, o)
      // Com contrato: ainda serve (estado, vigência) e tem saldo para o valor em vigor (garantido de vez na emissão).
      const contract = await contractOf(scope, o)
      if (contract) {
        const need =
          (await orderCommitted(scope, id)) - (await consumedByOrder(scope, contract.id, id))
        if (need > contract.remaining)
          throw new ApiError(
            409,
            'CONTRACT_EXCEEDED',
            `O contrato ${contract.number} só tem ${money(contract.remaining)} ${o.currency} disponíveis.`,
            [{ path: 'contractId', code: 'CONTRACT_EXCEEDED', message: money(contract.remaining) }]
          )
      }
      const le = (await legalEntityFacts(scope, o.legal_entity_id))!
      let rate = 10n ** 10n
      if (o.currency !== le.functionalCurrency) {
        const fx = await rateOn(scope, o.currency, le.functionalCurrency, today())
        if (!fx)
          throw ApiError.conflict(
            'NO_RATE',
            `Sem câmbio ${o.currency}→${le.functionalCurrency} até hoje: registe-o em Câmbios.`
          )
        rate = parseScaled(fx.rate, 10) ?? 0n
      }
      const functional = toFunctional(c2(o.total_amount), rate)
      const lv = await scope.trx.rawQuery(
        `select id, code, name, sequence, min_amount::text as min_amount, approver_role_id from purchase_approval_levels
          where tenant_id = ? and status = 'ACTIVE' and (legal_entity_id is null or legal_entity_id = ?)`,
        [t, o.legal_entity_id]
      )
      const required = requiredLevels(
        (lv.rows as any[]).map((x) => ({
          id: x.id,
          code: x.code,
          name: x.name,
          sequence: Number(x.sequence),
          approverRoleId: x.approver_role_id ?? null,
          minCents: c2(x.min_amount),
        })),
        functional
      )
      await setOrder(scope, id, {
        approval_status: 'PENDING_APPROVAL',
        approval_round: Number(o.approval_round) + 1,
        exchange_rate: scaledText(rate, 10),
        rate_date: today(),
        total_functional: money(functional),
        required_levels: JSON.stringify(required),
        submitted_at: new Date(),
        submitted_by: context.userId,
        submitted_by_membership_id: context.membershipId,
        reject_reason: null,
      })
      await event(scope, id, 'SUBMITTED', {
        revision: Number(o.revision),
        details: { totalFunctional: money(functional), levels: required.map((l) => l.code) },
      })
      await audit(scope, {
        action: 'purchase_order.submitted',
        entityType: 'purchase_order',
        entityId: id,
        changes: { approvalStatus: { from: o.approval_status, to: 'PENDING_APPROVAL' } },
      })
      return detail(scope, id)
    })
  }

  decide(
    context: TenantContext,
    id: string,
    decision: 'approve' | 'reject',
    input: Record<string, unknown>
  ) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'approve', true)
      versionCheck(o, input.expectedVersion)
      if (o.approval_status !== 'PENDING_APPROVAL')
        throw ApiError.conflict('INVALID_STATE', 'A ordem não está em aprovação.')
      const reason = decision === 'reject' ? reasonOf(input.reason) : text(input.reason) || null
      const n = await stepFor(scope, o)
      if (!n.step) throw ApiError.conflict('INVALID_STATE', 'Não há etapa por decidir.')
      if (!n.allowed) throw ApiError.forbidden(n.reason!, 'Não pode decidir esta etapa.')
      await scope.trx.rawQuery(
        `insert into purchase_order_approvals (tenant_id, order_id, revision, round, level_id, level_code, sequence,
            decision, decided_by_membership_id, decided_by_user_id, reason, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          id,
          o.revision,
          o.approval_round,
          n.step.id,
          n.step.code,
          n.step.sequence,
          decision === 'approve' ? 'APPROVE' : 'REJECT',
          context.membershipId,
          context.userId,
          reason,
          context.userId,
          context.userId,
        ] as never[]
      )
      const required = (o.required_levels as Level[]) ?? []
      const last = required[required.length - 1]?.sequence === n.step.sequence
      const to = decision === 'reject' ? 'REJECTED' : last ? 'APPROVED' : 'PENDING_APPROVAL'
      if (to !== 'PENDING_APPROVAL')
        await setOrder(scope, id, {
          approval_status: to,
          ...(to === 'APPROVED' ? { approved_at: new Date() } : { reject_reason: reason }),
        })
      else await setOrder(scope, id, {})
      await event(
        scope,
        id,
        decision === 'approve' ? (last ? 'APPROVED' : 'STEP_APPROVED') : 'REJECTED',
        {
          revision: Number(o.revision),
          reason,
          details: { step: n.step.code },
        }
      )
      await audit(scope, {
        action:
          decision === 'approve'
            ? last
              ? 'purchase_order.approved'
              : 'purchase_order.step_approved'
            : 'purchase_order.rejected',
        entityType: 'purchase_order',
        entityId: id,
        changes: { approvalStatus: { from: 'PENDING_APPROVAL', to } },
      })
      return detail(scope, id)
    })
  }

  /** Emitir: a primeira emissão dá o número (série da entidade, sem buracos); afecta as requisições. */
  issue(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      if (
        o.approval_status !== 'APPROVED' ||
        o.closed_at ||
        (Number(o.issued_revision) === Number(o.revision) && o.issued_revision !== null)
      )
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se emite uma ordem aprovada ainda não emitida nesta revisão.'
        )
      if (!(await supplierStanding(scope, o.supplier_id))?.canOrder)
        throw ApiError.conflict(
          'NOT_QUALIFIED',
          'O fornecedor deixou de estar homologado: não se emite.'
        )
      let number = o.number as string | null
      let seriesId = o.series_id as string | null
      if (!number) {
        const ser = await scope.trx.rawQuery(
          `select id from document_series where tenant_id = ? and legal_entity_id = ? and document_type = ? and status = 'ACTIVE'
              and (valid_from is null or valid_from <= ?::date) and (valid_to is null or valid_to >= ?::date)
              and (branch_id is null or branch_id is not distinct from ?)
            order by (branch_id is not null) desc, code limit 1`,
          [
            context.tenantId,
            o.legal_entity_id,
            ORDER_SERIES_TYPE,
            today(),
            today(),
            o.branch_id,
          ] as never[]
        )
        const series = ser.rows[0] as { id: string } | undefined
        if (!series)
          throw ApiError.conflict(
            'NO_SERIES',
            `Sem série documental ${ORDER_SERIES_TYPE} activa para a entidade legal: crie-a em Séries documentais.`
          )
        seriesId = series.id
        number = (await reserveDocumentNumber(scope, series.id, today())).formatted
      }
      await syncAllocations(scope, o, `r${o.revision}`)
      await syncContract(scope, o, `r${o.revision}`)
      const first = !o.number
      await setOrder(scope, id, {
        series_id: seriesId,
        number,
        issued_revision: o.revision,
        issued_at: new Date(),
        issued_by: context.userId,
      })
      await event(scope, id, first ? 'ISSUED' : 'REISSUED', {
        revision: Number(o.revision),
        details: { number },
      })
      await audit(scope, {
        action: 'purchase_order.issued',
        entityType: 'purchase_order',
        entityId: id,
        changes: {
          number: { from: o.number ?? null, to: number },
          revision: { from: null, to: Number(o.revision) },
        },
      })
      // Emitida: compromete a verba (a requisição já libertou o que esta ordem encomenda).
      await syncCommitments(scope, { orderIds: [id] }, { check: true })
      return detail(scope, id)
    })
  }

  /** Rever uma ordem emitida: guarda a versão emitida e abre a revisão seguinte em rascunho (nova aprovação e emissão). */
  revise(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const d = await detail(scope, id)
      if (!d.can.revise) {
        await authorized(scope, id, 'manage')
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se revê uma ordem aprovada e emitida, ainda não recebida por inteiro.'
        )
      }
      const o = await load(scope, id, true)
      versionCheck(o, input.expectedVersion)
      const reason = reasonOf(input.reason)
      const snapshot: Record<string, unknown> = { ...d }
      for (const k of ['history', 'revisions', 'can', 'approval']) delete snapshot[k]
      await scope.trx.rawQuery(
        `insert into purchase_order_revisions (tenant_id, order_id, revision, reason, total_amount, snapshot, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          context.tenantId,
          id,
          o.revision,
          reason,
          o.total_amount,
          JSON.stringify(snapshot),
          context.userId,
          context.userId,
        ] as never[]
      )
      await setOrder(scope, id, {
        approval_status: 'DRAFT',
        revision: Number(o.revision) + 1,
        approved_at: null,
      })
      await event(scope, id, 'REVISED', { revision: Number(o.revision) + 1, reason })
      await audit(scope, {
        action: 'purchase_order.revised',
        entityType: 'purchase_order',
        entityId: id,
        changes: { revision: { from: Number(o.revision), to: Number(o.revision) + 1 } },
      })
      return detail(scope, id)
    })
  }

  cancel(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const d = await detail(scope, id)
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      if (!d.can.cancel)
        throw ApiError.conflict(
          'INVALID_STATE',
          'Não se anula: já tem recepções ou facturas (feche o resto).'
        )
      const reason = reasonOf(input.reason)
      await releaseAll(scope, o)
      await syncContract(scope, o, 'cancel', 0n)
      await setOrder(scope, id, { approval_status: 'CANCELLED', cancel_reason: reason })
      await event(scope, id, 'CANCELLED', { revision: Number(o.revision), reason })
      await audit(scope, {
        action: 'purchase_order.cancelled',
        entityType: 'purchase_order',
        entityId: id,
        changes: { approvalStatus: { from: o.approval_status, to: 'CANCELLED' } },
      })
      await syncCommitments(scope, { orderIds: [id] })
      return detail(scope, id)
    })
  }

  /** Fechar o resto: o que falta receber passa a cancelado e volta às requisições. */
  close(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const d = await detail(scope, id)
      const { o } = await authorized(scope, id, 'manage', true)
      versionCheck(o, input.expectedVersion)
      if (!d.can.close)
        throw ApiError.conflict(
          'INVALID_STATE',
          'Só se fecha o resto de uma ordem emitida parcialmente recebida.'
        )
      const reason = reasonOf(input.reason)
      for (const l of await linesOfOrder(scope, id, true)) {
        const rest = q6(l.quantity) - q6(l.received_quantity) - q6(l.cancelled_quantity)
        if (rest > 0n)
          await scope.trx.rawQuery(
            `update purchase_order_lines set cancelled_quantity = ?, updated_at = now(), version = version + 1
              where tenant_id = ? and id = ?`,
            [scaledText(q6(l.cancelled_quantity) + rest, 6), context.tenantId, l.id] as never[]
          )
      }
      await syncAllocations(scope, o, 'close')
      await syncContract(scope, o, 'close')
      await setOrder(scope, id, {
        closed_at: new Date(),
        close_reason: reason,
        receipt_status: 'RECEIVED',
      })
      await event(scope, id, 'CLOSED', { revision: Number(o.revision), reason })
      await audit(scope, {
        action: 'purchase_order.closed',
        entityType: 'purchase_order',
        entityId: id,
        changes: { receiptStatus: { from: o.receipt_status, to: 'RECEIVED' } },
      })
      await syncCommitments(scope, { orderIds: [id] })
      return detail(scope, id)
    })
  }

  /** Ordens em rascunho a partir de uma adjudicação aprovada: uma por fornecedor, com os preços da proposta. */
  fromAward(context: TenantContext, awardId: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(awardId)) throw ApiError.notFound()
      const t = context.tenantId
      const a = (
        await scope.trx.rawQuery(
          `select a.*, r.legal_entity_id from rfq_awards a join rfqs r on r.tenant_id = a.tenant_id and r.id = a.rfq_id
            where a.tenant_id = ? and a.id = ? for update of a`,
          [t, awardId]
        )
      ).rows[0] as any
      if (!a) throw ApiError.notFound()
      const s = await scopesOf(scope)
      const g = rights(s, a.legal_entity_id)
      if (!g.read) throw ApiError.notFound()
      if (!g.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere ordens de compra desta entidade.')
      if (a.status !== 'APPROVED')
        throw ApiError.conflict('INVALID_STATE', 'Só uma adjudicação aprovada dá ordens de compra.')
      const done = await scope.trx.rawQuery(
        `select 1 from purchase_order_lines l join purchase_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
           join rfq_award_lines al on al.tenant_id = l.tenant_id and al.id = l.award_line_id
          where l.tenant_id = ? and al.award_id = ? and o.approval_status <> 'CANCELLED' limit 1`,
        [t, awardId]
      )
      if (done.rows.length)
        throw ApiError.conflict(
          'AWARD_ALREADY_ORDERED',
          'Esta adjudicação já tem ordens de compra (anule-as para refazer).'
        )
      const lines = (
        await scope.trx.rawQuery(
          `select al.*, l.product_id, l.variant_id, l.description, l.uom_id, l.requisition_line_id, ql.tax_rate,
              ql.delivery_days as line_days, ql.description as alt_description, q.delivery_days, q.payment_terms_days,
              q.supplier_reference
             from rfq_award_lines al join rfq_lines l on l.tenant_id = al.tenant_id and l.id = al.rfq_line_id
             join rfq_quote_lines ql on ql.tenant_id = al.tenant_id and ql.id = al.quote_line_id
             join rfq_quotes q on q.tenant_id = al.tenant_id and q.id = al.quote_id
            where al.tenant_id = ? and al.award_id = ? order by l.line_no`,
          [t, awardId]
        )
      ).rows as any[]
      const bySupplier = new Map<string, any[]>()
      for (const l of lines)
        bySupplier.set(l.supplier_id, [...(bySupplier.get(l.supplier_id) ?? []), l])
      const ids: string[] = []
      for (const [supplierId, ls] of bySupplier) {
        const days = Math.max(...ls.map((l) => Number(l.line_days ?? l.delivery_days ?? 0)))
        const h = await header(
          scope,
          s,
          {
            legalEntityId: a.legal_entity_id,
            supplierId,
            currency: ls[0].currency,
            paymentTermsDays: ls[0].payment_terms_days ?? undefined,
            expectedDate: addDays(today(), days),
            supplierReference: ls[0].supplier_reference ?? undefined,
          },
          null
        )
        fail(h.issues)
        const ins = await scope.trx.rawQuery(
          `insert into purchase_orders (tenant_id, ${Object.keys(h.values).join(', ')}, award_id, created_by, updated_by)
           values (?, ${Object.keys(h.values)
             .map(() => '?')
             .join(', ')}, ?, ?, ?) returning *`,
          [t, ...Object.values(h.values), awardId, context.userId, context.userId] as never[]
        )
        const o = ins.rows[0] as any
        const prepared = await linesOf(
          scope,
          a.legal_entity_id,
          ls.map((l) => ({
            productId: l.product_id,
            variantId: l.variant_id,
            description: l.alt_description
              ? `${l.description} — ${l.alt_description}`
              : l.description,
            uomId: l.uom_id,
            quantity: scaledText(q6(l.quantity), 6),
            unitPrice: scaledText(q6(l.unit_price), 6),
            taxRate: scaledText(r3(l.tax_rate), 3),
            requisitionLineId: l.requisition_line_id,
          })),
          []
        )
        prepared.forEach((p, i) => (p.awardLineId = ls[i].id))
        const totals = await writeLines(scope, o, prepared, [])
        await setOrder(scope, o.id, totals)
        await event(scope, o.id, 'CREATED', { revision: 0, details: { awardId } })
        await audit(scope, {
          action: 'purchase_order.created',
          entityType: 'purchase_order',
          entityId: o.id,
          changes: {
            awardId: { from: null, to: awardId },
            totalAmount: { from: null, to: totals.total_amount },
          },
        })
        ids.push(o.id)
      }
      return ids
    })
  }
}

/** Existe nesta empresa e o membro pode ler (anexos): `null` sem acesso. */
export async function purchaseOrderAccess(scope: TenantScope, id: string) {
  if (!isUuid(id)) return null
  const o = (
    await scope.trx.rawQuery(
      `select legal_entity_id from purchase_orders where tenant_id = ? and id = ?`,
      [scope.context.tenantId, id]
    )
  ).rows[0] as any
  if (!o) return null
  const g = rights(await scopesOf(scope), o.legal_entity_id)
  return g.read ? { read: true, write: g.manage } : null
}
