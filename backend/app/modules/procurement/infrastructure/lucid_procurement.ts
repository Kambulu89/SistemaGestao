import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type {
  PurchaseLineValues,
  PurchaseStatus,
  ReceiptLineValues,
  ReceiptStatus,
  RequisitionStatus,
  SupplierStatus,
  SupplierValues,
  ApprovalChange,
  ApprovalStatus,
  SupplierCategoryValues,
  SupplierRating,
  SupplyType,
} from '#modules/procurement/domain/procurement'
import type {
  PurchaseFilter,
  PurchaseLine,
  PurchaseOrder,
  PurchaseStore,
  Receipt,
  ReceiptFilter,
  ReceiptLine,
  ReceiptStore,
  Requisition,
  RequisitionFilter,
  RequisitionLine,
  RequisitionStore,
  Supplier,
  SupplierApprovalEvent,
  SupplierCategory,
  SupplierCategoryStore,
  SupplierFilter,
  SupplierStore,
  Totals,
} from '#modules/procurement/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

const constraintOf = (error: unknown): string | undefined =>
  (error as { constraint?: string } | null)?.constraint

/** Corre uma escrita com `expectedVersion`: sem linha afectada distingue «não existe» de «versão desactualizada». */
async function versioned(
  rows: { rows: unknown[] },
  current: () => Promise<{ version: number } | null>
): Promise<void> {
  if (rows.rows.length > 0) return
  const row = await current()
  if (!row) throw ApiError.notFound()
  throw ApiError.versionConflict(row.version)
}

// --- fornecedores -----------------------------------------------------------------------------------

interface SupplierRow {
  id: string
  party_id: string
  organization_id: string
  code: string
  payment_term_days: number
  currency: string
  status: SupplierStatus
  status_reason: string | null
  category_id: string | null
  supply_type: SupplyType
  critical: boolean
  rating: SupplierRating | null
  lead_time_days: number | null
  notes: string | null
  approval_status: ApprovalStatus
  approval_valid_until: string | null
  approval_conditions: string | null
  approval_requested_by_membership_id: string | null
  version: number
  created_at: Date
  updated_at: Date
  party_name: string
  tax_id: string | null
  category_name: string | null
}

/** `EXPIRED` não se grava: deriva de uma homologação em vigor cuja validade já passou. */
const EFFECTIVE_APPROVAL = `case
    when s.approval_status in ('APPROVED', 'CONDITIONALLY_APPROVED') and s.approval_valid_until < current_date
      then 'EXPIRED' else s.approval_status end`

/** Junta só para ler (nome e NIF da Party, nome da categoria): o fornecedor nunca escreve na Party. */
const SUPPLIER_FROM = `
    from suppliers s
    join parties p on p.tenant_id = s.tenant_id and p.id = s.party_id
    left join organization_parties op on op.tenant_id = s.tenant_id and op.party_id = s.party_id
    left join supplier_categories c on c.tenant_id = s.tenant_id and c.id = s.category_id`

const SUPPLIER_SELECT = `
  select s.id, s.party_id, s.organization_id, s.code, s.payment_term_days, s.currency, s.status, s.status_reason,
         s.category_id, s.supply_type, s.critical, s.rating, s.lead_time_days, s.notes,
         ${EFFECTIVE_APPROVAL} as approval_status, s.approval_valid_until::text as approval_valid_until,
         s.approval_conditions, s.approval_requested_by_membership_id,
         s.version, s.created_at, s.updated_at, p.display_name as party_name, op.tax_id, c.name as category_name
  ${SUPPLIER_FROM}`

const toSupplier = (r: SupplierRow): Supplier => ({
  id: r.id,
  partyId: r.party_id,
  organizationId: r.organization_id,
  code: r.code,
  paymentTermDays: r.payment_term_days,
  currency: r.currency,
  status: r.status,
  statusReason: r.status_reason,
  categoryId: r.category_id,
  supplyType: r.supply_type,
  critical: r.critical,
  rating: r.rating,
  leadTimeDays: r.lead_time_days,
  notes: r.notes,
  approvalStatus: r.approval_status,
  approvalValidUntil: r.approval_valid_until,
  approvalConditions: r.approval_conditions,
  approvalRequestedByMembershipId: r.approval_requested_by_membership_id,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  partyName: r.party_name,
  taxId: r.tax_id,
  categoryName: r.category_name,
})

export class LucidSupplierStore implements SupplierStore {
  async list(scope: TenantScope, filter: SupplierFilter) {
    const where = ['s.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.q) {
      const like = `%${escapeLike(filter.q.toLowerCase())}%`
      where.push(
        `(lower(p.display_name) like ? or lower(s.code) like ? or lower(coalesce(op.tax_id, '')) like ?)`
      )
      params.push(like, like, like)
    }
    for (const [column, value] of [
      ['s.status', filter.status],
      ['s.organization_id', filter.organizationId],
      ['s.category_id', filter.categoryId],
      [`(${EFFECTIVE_APPROVAL})`, filter.approvalStatus],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    if (filter.critical !== undefined) {
      where.push('s.critical = ?')
      params.push(filter.critical)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `${SUPPLIER_SELECT} where ${clause} order by lower(p.display_name), s.code limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total ${SUPPLIER_FROM} where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as SupplierRow[]).map(toSupplier),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `${SUPPLIER_SELECT} where s.tenant_id = ? and s.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as SupplierRow[]
    return row ? toSupplier(row) : null
  }

  async insert(scope: TenantScope, v: SupplierValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into suppliers (tenant_id, party_id, organization_id, code, payment_term_days, currency, status,
           status_reason, category_id, supply_type, critical, rating, lead_time_days, notes,
           created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          tenantOf(scope),
          v.partyId,
          v.organizationId,
          v.code,
          v.paymentTermDays,
          v.currency,
          v.status,
          v.statusReason,
          v.categoryId,
          v.supplyType,
          v.critical,
          v.rating,
          v.leadTimeDays,
          v.notes,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Supplier
    } catch (error) {
      const constraint = constraintOf(error)
      if (constraint === 'suppliers_code_unique') return 'CODE'
      if (constraint === 'suppliers_party_unique') return 'PARTY'
      throw error
    }
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: SupplierValues) {
    const result = await trxOf(scope).rawQuery(
      `update suppliers
          set payment_term_days = ?, currency = ?, status = ?, status_reason = ?, category_id = ?, supply_type = ?,
              critical = ?, rating = ?, lead_time_days = ?, notes = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.paymentTermDays,
        v.currency,
        v.status,
        v.statusReason,
        v.categoryId,
        v.supplyType,
        v.critical,
        v.rating,
        v.leadTimeDays,
        v.notes,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return (await this.find(scope, id)) as Supplier
  }

  async changeApproval(scope: TenantScope, id: string, expectedVersion: number, c: ApprovalChange) {
    const result = await trxOf(scope).rawQuery(
      `update suppliers
          set approval_status = ?, approval_valid_until = ?, approval_conditions = ?,
              approval_requested_by_membership_id = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        c.to,
        c.validUntil,
        c.conditions,
        c.requestedByMembershipId,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    await trxOf(scope).rawQuery(
      `insert into supplier_approval_events (tenant_id, supplier_id, action, from_status, to_status, reason,
         conditions, valid_until, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantOf(scope),
        id,
        c.action,
        c.from,
        c.to,
        c.reason,
        c.conditions,
        c.validUntil,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, id)) as Supplier
  }

  async approvalEvents(scope: TenantScope, supplierId: string): Promise<SupplierApprovalEvent[]> {
    const result = await trxOf(scope).rawQuery(
      `select id, supplier_id, action, from_status, to_status, reason, conditions, valid_until::text as valid_until,
              occurred_at, created_by_membership_id
         from supplier_approval_events
        where tenant_id = ? and supplier_id = ?
        order by occurred_at desc, id desc
        limit 200`,
      [tenantOf(scope), supplierId]
    )
    return (
      result.rows as {
        id: string
        supplier_id: string
        action: SupplierApprovalEvent['action']
        from_status: ApprovalStatus
        to_status: ApprovalStatus
        reason: string | null
        conditions: string | null
        valid_until: string | null
        occurred_at: Date
        created_by_membership_id: string | null
      }[]
    ).map((r) => ({
      id: r.id,
      supplierId: r.supplier_id,
      action: r.action,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reason: r.reason,
      conditions: r.conditions,
      validUntil: r.valid_until,
      occurredAt: r.occurred_at,
      actorMembershipId: r.created_by_membership_id,
    }))
  }
}

// --- categorias de fornecedor -------------------------------------------------------------------------

interface CategoryRow {
  id: string
  code: string
  name: string
  description: string | null
  active: boolean
  version: number
  created_at: Date
  updated_at: Date
}

const toCategory = (r: CategoryRow): SupplierCategory => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  active: r.active,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const CATEGORY_COLUMNS = 'id, code, name, description, active, version, created_at, updated_at'

export class LucidSupplierCategoryStore implements SupplierCategoryStore {
  async list(scope: TenantScope, filter: { q?: string; active?: boolean }) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.q) {
      const like = `%${escapeLike(filter.q.toLowerCase())}%`
      where.push('(lower(name) like ? or lower(code) like ?)')
      params.push(like, like)
    }
    if (filter.active !== undefined) {
      where.push('active = ?')
      params.push(filter.active)
    }
    const result = await trxOf(scope).rawQuery(
      `select ${CATEGORY_COLUMNS} from supplier_categories where ${where.join(' and ')}
        order by lower(name), code limit 500`,
      params as never[]
    )
    return (result.rows as CategoryRow[]).map(toCategory)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${CATEGORY_COLUMNS} from supplier_categories where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as CategoryRow[]
    return row ? toCategory(row) : null
  }

  async insert(scope: TenantScope, v: SupplierCategoryValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into supplier_categories (tenant_id, code, name, description, active, created_by_membership_id,
           updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?) returning ${CATEGORY_COLUMNS}`,
        [
          tenantOf(scope),
          v.code,
          v.name,
          v.description,
          v.active,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return toCategory(result.rows[0] as CategoryRow)
    } catch (error) {
      if (constraintOf(error) === 'supplier_categories_code_unique') return 'CODE' as const
      throw error
    }
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: SupplierCategoryValues) {
    const result = await trxOf(scope).rawQuery(
      `update supplier_categories
          set name = ?, description = ?, active = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? returning ${CATEGORY_COLUMNS}`,
      [
        v.name,
        v.description,
        v.active,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return toCategory(result.rows[0] as CategoryRow)
  }
}

// --- requisições ------------------------------------------------------------------------------------

interface RequisitionRow {
  id: string
  organization_id: string
  requested_by_membership_id: string
  number: string | null
  status: RequisitionStatus
  needed_on: string | null
  notes: string | null
  decided_by_membership_id: string | null
  decided_at: Date | null
  decision_reason: string | null
  purchase_order_id: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const REQUISITION_COLUMNS = `id, organization_id, requested_by_membership_id, number, status, needed_on::text as needed_on,
  notes, decided_by_membership_id, decided_at, decision_reason, purchase_order_id, version, created_at, updated_at`

const toRequisition = (r: RequisitionRow): Requisition => ({
  id: r.id,
  organizationId: r.organization_id,
  requestedByMembershipId: r.requested_by_membership_id,
  number: r.number,
  status: r.status,
  neededOn: r.needed_on,
  notes: r.notes,
  decidedByMembershipId: r.decided_by_membership_id,
  decidedAt: r.decided_at,
  decisionReason: r.decision_reason,
  purchaseOrderId: r.purchase_order_id,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface RequisitionLineRow {
  id: string
  requisition_id: string
  position: number
  variant_id: string
  description: string
  quantity: string
  version: number
  created_at: Date
  updated_at: Date
}
const REQUISITION_LINE_COLUMNS = `id, requisition_id, position, variant_id, description, quantity::text as quantity,
  version, created_at, updated_at`
const toRequisitionLine = (r: RequisitionLineRow): RequisitionLine => ({
  id: r.id,
  requisitionId: r.requisition_id,
  position: r.position,
  variantId: r.variant_id,
  description: r.description,
  quantity: r.quantity,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidRequisitionStore implements RequisitionStore {
  async list(scope: TenantScope, filter: RequisitionFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['status', filter.status],
      ['requested_by_membership_id', filter.requestedByMembershipId],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${REQUISITION_COLUMNS} from purchase_requisitions where ${clause}
        order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from purchase_requisitions where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as RequisitionRow[]).map(toRequisition),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${REQUISITION_COLUMNS} from purchase_requisitions where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as RequisitionRow[]
    return row ? toRequisition(row) : null
  }

  async insert(
    scope: TenantScope,
    v: {
      organizationId: string
      requestedByMembershipId: string
      neededOn: string | null
      notes: string | null
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into purchase_requisitions (tenant_id, organization_id, requested_by_membership_id, needed_on, notes,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.requestedByMembershipId,
        v.neededOn,
        v.notes,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Requisition
  }

  async updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: { neededOn: string | null; notes: string | null }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update purchase_requisitions set needed_on = ?, notes = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [v.neededOn, v.notes, actorOf(scope), tenantOf(scope), id, expectedVersion] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return (await this.find(scope, id)) as Requisition
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `delete from requisition_lines where tenant_id = ? and requisition_id = ?`,
      [tenantOf(scope), id]
    )
    await trxOf(scope).rawQuery(
      `delete from purchase_requisitions where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
  }

  async submit(scope: TenantScope, id: string, number: string) {
    await trxOf(scope).rawQuery(
      `update purchase_requisitions set status = 'SUBMITTED', number = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [number, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Requisition
  }

  async decide(
    scope: TenantScope,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    by: string,
    reason: string | null
  ) {
    await trxOf(scope).rawQuery(
      `update purchase_requisitions set status = ?, decided_by_membership_id = ?, decided_at = now(),
              decision_reason = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [status, by, reason, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return (await this.find(scope, id)) as Requisition
  }

  async markConverted(scope: TenantScope, id: string, orderId: string) {
    await trxOf(scope).rawQuery(
      `update purchase_requisitions set status = 'CONVERTED', purchase_order_id = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [orderId, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Requisition
  }

  async listLines(scope: TenantScope, requisitionId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${REQUISITION_LINE_COLUMNS} from requisition_lines
        where tenant_id = ? and requisition_id = ? order by position`,
      [tenantOf(scope), requisitionId]
    )
    return (result.rows as RequisitionLineRow[]).map(toRequisitionLine)
  }

  async findLine(scope: TenantScope, requisitionId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${REQUISITION_LINE_COLUMNS} from requisition_lines
        where tenant_id = ? and requisition_id = ? and id = ?`,
      [tenantOf(scope), requisitionId, lineId]
    )
    const [row] = result.rows as RequisitionLineRow[]
    return row ? toRequisitionLine(row) : null
  }

  async insertLine(
    scope: TenantScope,
    requisitionId: string,
    v: { variantId: string; description: string; quantity: string }
  ) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into requisition_lines (tenant_id, requisition_id, position, variant_id, description, quantity,
           created_by_membership_id, updated_by_membership_id)
         values (?, ?, (select coalesce(max(position), 0) + 1 from requisition_lines where tenant_id = ? and requisition_id = ?),
                 ?, ?, ?, ?, ?) returning id`,
        [
          tenantOf(scope),
          requisitionId,
          tenantOf(scope),
          requisitionId,
          v.variantId,
          v.description,
          v.quantity,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return (await this.findLine(
        scope,
        requisitionId,
        (result.rows[0] as { id: string }).id
      )) as RequisitionLine
    } catch (error) {
      if (constraintOf(error) === 'requisition_lines_variant_unique') return null
      throw error
    }
  }

  async removeLine(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from requisition_lines where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }
}

// --- encomendas a fornecedor ------------------------------------------------------------------------

interface PurchaseRow {
  id: string
  organization_id: string
  supplier_id: string
  requisition_id: string | null
  number: string | null
  order_date: string
  currency: string
  status: PurchaseStatus
  notes: string | null
  net_total: string
  tax_total: string
  total: string
  ordered_at: Date | null
  cancelled_at: Date | null
  cancel_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const PURCHASE_COLUMNS = `id, organization_id, supplier_id, requisition_id, number, order_date::text as order_date,
  currency, status, notes, net_total::text as net_total, tax_total::text as tax_total, total::text as total,
  ordered_at, cancelled_at, cancel_reason, version, created_at, updated_at`

const toPurchase = (r: PurchaseRow): PurchaseOrder => ({
  id: r.id,
  organizationId: r.organization_id,
  supplierId: r.supplier_id,
  requisitionId: r.requisition_id,
  number: r.number,
  orderDate: r.order_date,
  currency: r.currency,
  status: r.status,
  notes: r.notes,
  totals: { net: r.net_total, tax: r.tax_total, total: r.total },
  orderedAt: r.ordered_at,
  cancelledAt: r.cancelled_at,
  cancelReason: r.cancel_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface PurchaseLineRow {
  id: string
  order_id: string
  position: number
  variant_id: string
  description: string
  quantity: string
  unit_cost: string
  tax_rate: string
  net_amount: string
  tax_amount: string
  total: string
  version: number
  created_at: Date
  updated_at: Date
}
const PURCHASE_LINE_COLUMNS = `id, order_id, position, variant_id, description, quantity::text as quantity,
  unit_cost::text as unit_cost, tax_rate::text as tax_rate, net_amount::text as net_amount,
  tax_amount::text as tax_amount, total::text as total, version, created_at, updated_at`
const toPurchaseLine = (r: PurchaseLineRow): PurchaseLine => ({
  id: r.id,
  orderId: r.order_id,
  position: r.position,
  variantId: r.variant_id,
  description: r.description,
  quantity: r.quantity,
  unitCost: r.unit_cost,
  taxRate: r.tax_rate,
  netAmount: r.net_amount,
  taxAmount: r.tax_amount,
  total: r.total,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidPurchaseStore implements PurchaseStore {
  async list(scope: TenantScope, filter: PurchaseFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['supplier_id', filter.supplierId],
      ['status', filter.status],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    if (filter.q) {
      where.push(`lower(coalesce(number, '')) like ?`)
      params.push(`%${escapeLike(filter.q.toLowerCase())}%`)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${PURCHASE_COLUMNS} from purchase_orders where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from purchase_orders where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as PurchaseRow[]).map(toPurchase),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${PURCHASE_COLUMNS} from purchase_orders where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as PurchaseRow[]
    return row ? toPurchase(row) : null
  }

  async insert(
    scope: TenantScope,
    v: {
      organizationId: string
      supplierId: string
      requisitionId: string | null
      orderDate: string
      currency: string
      notes: string | null
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into purchase_orders (tenant_id, organization_id, supplier_id, requisition_id, order_date, currency, notes,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.supplierId,
        v.requisitionId,
        v.orderDate,
        v.currency,
        v.notes,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as PurchaseOrder
  }

  async updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: { orderDate: string; notes: string | null }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update purchase_orders set order_date = ?, notes = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [v.orderDate, v.notes, actorOf(scope), tenantOf(scope), id, expectedVersion] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return (await this.find(scope, id)) as PurchaseOrder
  }

  async setTotals(scope: TenantScope, id: string, totals: Totals) {
    await trxOf(scope).rawQuery(
      `update purchase_orders set net_total = ?, tax_total = ?, total = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [totals.net, totals.tax, totals.total, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as PurchaseOrder
  }

  async confirm(scope: TenantScope, id: string, number: string) {
    await trxOf(scope).rawQuery(
      `update purchase_orders set status = 'ORDERED', number = ?, ordered_at = now(), updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [number, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as PurchaseOrder
  }

  async setStatus(scope: TenantScope, id: string, status: 'ORDERED' | 'PARTIAL' | 'RECEIVED') {
    await trxOf(scope).rawQuery(
      `update purchase_orders set status = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [status, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as PurchaseOrder
  }

  async cancel(scope: TenantScope, id: string, reason: string) {
    await trxOf(scope).rawQuery(
      `update purchase_orders set status = 'CANCELLED', cancelled_at = now(), cancel_reason = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [reason, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as PurchaseOrder
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from purchase_lines where tenant_id = ? and order_id = ?`, [
      tenantOf(scope),
      id,
    ])
    await trxOf(scope).rawQuery(`delete from purchase_orders where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async listLines(scope: TenantScope, orderId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${PURCHASE_LINE_COLUMNS} from purchase_lines where tenant_id = ? and order_id = ? order by position`,
      [tenantOf(scope), orderId]
    )
    return (result.rows as PurchaseLineRow[]).map(toPurchaseLine)
  }

  async findLine(scope: TenantScope, orderId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${PURCHASE_LINE_COLUMNS} from purchase_lines where tenant_id = ? and order_id = ? and id = ?`,
      [tenantOf(scope), orderId, lineId]
    )
    const [row] = result.rows as PurchaseLineRow[]
    return row ? toPurchaseLine(row) : null
  }

  async insertLine(
    scope: TenantScope,
    orderId: string,
    description: string,
    v: PurchaseLineValues
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into purchase_lines (tenant_id, order_id, position, variant_id, description, quantity, unit_cost,
         tax_rate, net_amount, tax_amount, total, created_by_membership_id, updated_by_membership_id)
       values (?, ?, (select coalesce(max(position), 0) + 1 from purchase_lines where tenant_id = ? and order_id = ?),
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        orderId,
        tenantOf(scope),
        orderId,
        v.variantId,
        description,
        v.quantity,
        v.unitCost,
        v.taxRate,
        v.netAmount,
        v.taxAmount,
        v.total,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.findLine(
      scope,
      orderId,
      (result.rows[0] as { id: string }).id
    )) as PurchaseLine
  }

  async removeLine(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from purchase_lines where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async lock(scope: TenantScope, orderId: string) {
    await trxOf(scope).rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
      `${tenantOf(scope)}:purchase:${orderId}`,
    ])
  }
}

// --- recepções --------------------------------------------------------------------------------------

interface ReceiptRow {
  id: string
  organization_id: string
  purchase_order_id: string
  warehouse_id: string | null
  number: string | null
  status: ReceiptStatus
  supplier_document: string | null
  notes: string | null
  received_at: Date | null
  reversed_at: Date | null
  reverse_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const RECEIPT_COLUMNS = `id, organization_id, purchase_order_id, warehouse_id, number, status, supplier_document, notes,
  received_at, reversed_at, reverse_reason, version, created_at, updated_at`
const toReceipt = (r: ReceiptRow): Receipt => ({
  id: r.id,
  organizationId: r.organization_id,
  purchaseOrderId: r.purchase_order_id,
  warehouseId: r.warehouse_id,
  number: r.number,
  status: r.status,
  supplierDocument: r.supplier_document,
  notes: r.notes,
  receivedAt: r.received_at,
  reversedAt: r.reversed_at,
  reverseReason: r.reverse_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface ReceiptLineRow {
  id: string
  receipt_id: string
  purchase_line_id: string
  quantity: string
  lot_code: string | null
  expires_on: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const RECEIPT_LINE_COLUMNS = `id, receipt_id, purchase_line_id, quantity::text as quantity, lot_code,
  expires_on::text as expires_on, version, created_at, updated_at`
const toReceiptLine = (r: ReceiptLineRow): ReceiptLine => ({
  id: r.id,
  receiptId: r.receipt_id,
  purchaseLineId: r.purchase_line_id,
  quantity: r.quantity,
  lotCode: r.lot_code,
  expiresOn: r.expires_on,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidReceiptStore implements ReceiptStore {
  async list(scope: TenantScope, filter: ReceiptFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['purchase_order_id', filter.purchaseOrderId],
      ['status', filter.status],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${RECEIPT_COLUMNS} from goods_receipts where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from goods_receipts where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as ReceiptRow[]).map(toReceipt),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${RECEIPT_COLUMNS} from goods_receipts where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as ReceiptRow[]
    return row ? toReceipt(row) : null
  }

  async insert(
    scope: TenantScope,
    v: {
      organizationId: string
      purchaseOrderId: string
      warehouseId: string | null
      supplierDocument: string | null
      notes: string | null
    }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into goods_receipts (tenant_id, organization_id, purchase_order_id, warehouse_id, supplier_document, notes,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.purchaseOrderId,
        v.warehouseId,
        v.supplierDocument,
        v.notes,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Receipt
  }

  async updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: { warehouseId: string | null; supplierDocument: string | null; notes: string | null }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update goods_receipts set warehouse_id = ?, supplier_document = ?, notes = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.warehouseId,
        v.supplierDocument,
        v.notes,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return (await this.find(scope, id)) as Receipt
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `delete from goods_receipt_lines where tenant_id = ? and receipt_id = ?`,
      [tenantOf(scope), id]
    )
    await trxOf(scope).rawQuery(`delete from goods_receipts where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async post(scope: TenantScope, id: string, number: string) {
    await trxOf(scope).rawQuery(
      `update goods_receipts set status = 'POSTED', number = ?, received_at = now(), updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [number, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Receipt
  }

  async reverse(scope: TenantScope, id: string, reason: string) {
    await trxOf(scope).rawQuery(
      `update goods_receipts set status = 'REVERSED', reversed_at = now(), reverse_reason = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [reason, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Receipt
  }

  async listLines(scope: TenantScope, receiptId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${RECEIPT_LINE_COLUMNS} from goods_receipt_lines where tenant_id = ? and receipt_id = ?
        order by created_at, id`,
      [tenantOf(scope), receiptId]
    )
    return (result.rows as ReceiptLineRow[]).map(toReceiptLine)
  }

  async findLine(scope: TenantScope, receiptId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${RECEIPT_LINE_COLUMNS} from goods_receipt_lines where tenant_id = ? and receipt_id = ? and id = ?`,
      [tenantOf(scope), receiptId, lineId]
    )
    const [row] = result.rows as ReceiptLineRow[]
    return row ? toReceiptLine(row) : null
  }

  async insertLine(scope: TenantScope, receiptId: string, v: ReceiptLineValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into goods_receipt_lines (tenant_id, receipt_id, purchase_line_id, quantity, lot_code, expires_on,
           created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          tenantOf(scope),
          receiptId,
          v.purchaseLineId,
          v.quantity,
          v.lotCode,
          v.expiresOn,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return (await this.findLine(
        scope,
        receiptId,
        (result.rows[0] as { id: string }).id
      )) as ReceiptLine
    } catch (error) {
      if (constraintOf(error) === 'goods_receipt_lines_unique') return null
      throw error
    }
  }

  async removeLine(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from goods_receipt_lines where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async receivedByLine(scope: TenantScope, orderId: string) {
    const result = await trxOf(scope).rawQuery(
      `select l.purchase_line_id, sum(l.quantity)::text as received
         from goods_receipt_lines l
         join goods_receipts r on r.tenant_id = l.tenant_id and r.id = l.receipt_id
        where l.tenant_id = ? and r.purchase_order_id = ? and r.status = 'POSTED'
        group by l.purchase_line_id`,
      [tenantOf(scope), orderId]
    )
    return new Map(
      (result.rows as { purchase_line_id: string; received: string }[]).map((r) => [
        r.purchase_line_id,
        r.received,
      ])
    )
  }
}
