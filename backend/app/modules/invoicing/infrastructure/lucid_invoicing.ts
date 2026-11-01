import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import type { RoundingMode, Totals } from '#modules/orders/index'
import type {
  ContractStatus,
  ContractType,
  ContractValues,
  CreditNoteStatus,
  InvoiceLineValues,
  InvoiceStatus,
  RenewalMode,
} from '#modules/invoicing/domain/invoicing'
import type {
  Contract,
  ContractFilter,
  ContractStore,
  CreditedAmounts,
  CreditNote,
  CreditNoteLine,
  CreditNoteStore,
  CustomerSnapshot,
  Invoice,
  InvoiceFilter,
  InvoiceHeaderValues,
  InvoiceLine,
  InvoiceStore,
} from '#modules/invoicing/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

// --- contratos --------------------------------------------------------------------------------------

interface ContractRow {
  id: string
  organization_id: string
  party_id: string
  type: ContractType
  title: string
  number: string | null
  start_date: string
  end_date: string | null
  currency: string
  amount: string | null
  renewal_mode: RenewalMode
  notice_days: number
  status: Exclude<ContractStatus, 'EXPIRED'>
  notes: string | null
  activated_at: Date | null
  terminated_at: Date | null
  terminate_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const CONTRACT_COLUMNS = `id, organization_id, party_id, type, title, number, start_date::text as start_date,
  end_date::text as end_date, currency, amount, renewal_mode, notice_days, status, notes, activated_at, terminated_at,
  terminate_reason, version, created_at, updated_at`
const toContract = (r: ContractRow): Contract => ({
  id: r.id,
  organizationId: r.organization_id,
  partyId: r.party_id,
  type: r.type,
  title: r.title,
  number: r.number,
  startDate: r.start_date,
  endDate: r.end_date,
  currency: r.currency,
  amount: r.amount,
  renewalMode: r.renewal_mode,
  noticeDays: r.notice_days,
  status: r.status,
  notes: r.notes,
  activatedAt: r.activated_at,
  terminatedAt: r.terminated_at,
  terminateReason: r.terminate_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidContractStore implements ContractStore {
  async list(scope: TenantScope, filter: ContractFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.partyId) {
      where.push('party_id = ?')
      params.push(filter.partyId)
    }
    if (filter.type) {
      where.push('type = ?')
      params.push(filter.type)
    }
    if (filter.q) {
      where.push(`(lower(title) like ? or lower(coalesce(number, '')) like ?)`)
      const like = `%${escapeLike(filter.q.toLowerCase())}%`
      params.push(like, like)
    }
    // O estado efectivo: `EXPIRED` é um activo cujo fim já passou.
    if (filter.status === 'EXPIRED') {
      where.push(`status = 'ACTIVE' and end_date is not null and end_date < ?::date`)
      params.push(filter.today)
    } else if (filter.status === 'ACTIVE') {
      where.push(`status = 'ACTIVE' and (end_date is null or end_date >= ?::date)`)
      params.push(filter.today)
    } else if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${CONTRACT_COLUMNS} from contracts where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from contracts where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as ContractRow[]).map(toContract),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${CONTRACT_COLUMNS} from contracts where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as ContractRow[]
    return row ? toContract(row) : null
  }

  async insert(scope: TenantScope, v: ContractValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into contracts (tenant_id, organization_id, party_id, type, title, start_date, end_date, currency, amount,
         renewal_mode, notice_days, notes, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.partyId,
        v.type,
        v.title,
        v.startDate,
        v.endDate as never,
        v.currency,
        v.amount as never,
        v.renewalMode,
        v.noticeDays,
        v.notes as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Contract
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: ContractValues) {
    const result = await trxOf(scope).rawQuery(
      `update contracts
          set organization_id = ?, party_id = ?, type = ?, title = ?, start_date = ?, end_date = ?, currency = ?,
              amount = ?, renewal_mode = ?, notice_days = ?, notes = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.organizationId,
        v.partyId,
        v.type,
        v.title,
        v.startDate,
        v.endDate as never,
        v.currency,
        v.amount as never,
        v.renewalMode,
        v.noticeDays,
        v.notes as never,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }

  async activate(scope: TenantScope, id: string, number: string) {
    await trxOf(scope).rawQuery(
      `update contracts set status = 'ACTIVE', number = ?, activated_at = now(), updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [number, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Contract
  }

  async terminate(scope: TenantScope, id: string, reason: string) {
    await trxOf(scope).rawQuery(
      `update contracts set status = 'TERMINATED', terminated_at = now(), terminate_reason = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [reason, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Contract
  }
}

// --- facturas ---------------------------------------------------------------------------------------

interface InvoiceRow {
  id: string
  organization_id: string
  customer_id: string
  contract_id: string | null
  order_id: string | null
  number: string | null
  issued_on: string | null
  due_on: string
  currency: string
  exchange_rate: string
  customer_snapshot: CustomerSnapshot | null
  rounding_mode: RoundingMode | null
  net_total: string
  tax_total: string
  total: string
  status: InvoiceStatus
  fiscal_status: Invoice['fiscalStatus']
  issued_at: Date | null
  notes: string | null
  version: number
  created_at: Date
  updated_at: Date
}
const INVOICE_COLUMNS = `id, organization_id, customer_id, contract_id, order_id, number, issued_on::text as issued_on,
  due_on::text as due_on, currency, exchange_rate, customer_snapshot, rounding_mode, net_total, tax_total, total, status,
  fiscal_status, issued_at, notes, version, created_at, updated_at`
const toInvoice = (r: InvoiceRow): Invoice => ({
  id: r.id,
  organizationId: r.organization_id,
  customerId: r.customer_id,
  contractId: r.contract_id,
  orderId: r.order_id,
  number: r.number,
  issuedOn: r.issued_on,
  dueOn: r.due_on,
  currency: r.currency,
  exchangeRate: r.exchange_rate,
  customerSnapshot: r.customer_snapshot,
  roundingMode: r.rounding_mode,
  totals: { net: r.net_total, tax: r.tax_total, total: r.total },
  status: r.status,
  fiscalStatus: r.fiscal_status,
  issuedAt: r.issued_at,
  notes: r.notes,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface InvoiceLineRow {
  id: string
  invoice_id: string
  position: number
  sales_order_line_id: string | null
  variant_id: string | null
  description: string
  quantity: string
  unit_price: string
  discount_amount: string
  tax_code: string
  tax_rate: string
  exemption_reason: string | null
  net_amount: string
  tax_amount: string
  total: string
  version: number
  created_at: Date
  updated_at: Date
}
const LINE_COLUMNS = `id, invoice_id, position, sales_order_line_id, variant_id, description, quantity, unit_price,
  discount_amount, tax_code, tax_rate, exemption_reason, net_amount, tax_amount, total, version, created_at, updated_at`
const toLine = (r: InvoiceLineRow): InvoiceLine => ({
  id: r.id,
  invoiceId: r.invoice_id,
  position: r.position,
  salesOrderLineId: r.sales_order_line_id,
  variantId: r.variant_id,
  description: r.description,
  quantity: r.quantity,
  unitPrice: r.unit_price,
  discountAmount: r.discount_amount,
  taxCode: r.tax_code,
  taxRate: r.tax_rate,
  exemptionReason: r.exemption_reason,
  netAmount: r.net_amount,
  taxAmount: r.tax_amount,
  total: r.total,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidInvoiceStore implements InvoiceStore {
  async list(scope: TenantScope, filter: InvoiceFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['customer_id', filter.customerId],
      ['order_id', filter.orderId],
      ['contract_id', filter.contractId],
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
      `select ${INVOICE_COLUMNS} from invoices where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from invoices where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as InvoiceRow[]).map(toInvoice),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${INVOICE_COLUMNS} from invoices where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as InvoiceRow[]
    return row ? toInvoice(row) : null
  }

  async insert(scope: TenantScope, v: InvoiceHeaderValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into invoices (tenant_id, organization_id, customer_id, contract_id, order_id, due_on, currency, notes,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.customerId,
        v.contractId as never,
        v.orderId as never,
        v.dueOn,
        v.currency,
        v.notes as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Invoice
  }

  async updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: Pick<InvoiceHeaderValues, 'dueOn' | 'notes' | 'contractId'>
  ) {
    const result = await trxOf(scope).rawQuery(
      `update invoices set due_on = ?, notes = ?, contract_id = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.dueOn,
        v.notes as never,
        v.contractId as never,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ]
    )
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(row.version)
    return row
  }

  async setTotals(scope: TenantScope, id: string, totals: Totals) {
    await trxOf(scope).rawQuery(
      `update invoices set net_total = ?, tax_total = ?, total = ?, updated_at = now(), updated_by_membership_id = ?
        where tenant_id = ? and id = ?`,
      [totals.net, totals.tax, totals.total, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Invoice
  }

  async issue(
    scope: TenantScope,
    id: string,
    v: { number: string; issuedOn: string; snapshot: CustomerSnapshot; roundingMode: RoundingMode }
  ) {
    await trxOf(scope).rawQuery(
      `update invoices set status = 'ISSUED', number = ?, issued_on = ?, issued_at = now(), customer_snapshot = ?::jsonb,
              rounding_mode = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [
        v.number,
        v.issuedOn,
        JSON.stringify(v.snapshot),
        v.roundingMode,
        actorOf(scope),
        tenantOf(scope),
        id,
      ]
    )
    return (await this.find(scope, id)) as Invoice
  }

  async markCredited(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `update invoices set status = 'CREDITED', updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and status = 'ISSUED'`,
      [actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as Invoice
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `delete from invoice_lines where tenant_id = ? and invoice_id = ?`,
      [tenantOf(scope), id]
    )
    await trxOf(scope).rawQuery(`delete from invoices where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async listLines(scope: TenantScope, invoiceId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${LINE_COLUMNS} from invoice_lines where tenant_id = ? and invoice_id = ? order by position`,
      [tenantOf(scope), invoiceId]
    )
    return (result.rows as InvoiceLineRow[]).map(toLine)
  }

  async findLine(scope: TenantScope, invoiceId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${LINE_COLUMNS} from invoice_lines where tenant_id = ? and invoice_id = ? and id = ?`,
      [tenantOf(scope), invoiceId, lineId]
    )
    const [row] = result.rows as InvoiceLineRow[]
    return row ? toLine(row) : null
  }

  async insertLine(scope: TenantScope, invoiceId: string, v: InvoiceLineValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into invoice_lines (tenant_id, invoice_id, position, sales_order_line_id, variant_id, description, quantity,
         unit_price, discount_amount, tax_code, tax_rate, exemption_reason, net_amount, tax_amount, total,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, coalesce((select max(position) from invoice_lines where tenant_id = ? and invoice_id = ?), 0) + 1,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       returning ${LINE_COLUMNS}`,
      [
        tenantOf(scope),
        invoiceId,
        tenantOf(scope),
        invoiceId,
        v.salesOrderLineId as never,
        v.variantId as never,
        v.description,
        v.quantity,
        v.unitPrice,
        v.discountAmount,
        v.taxCode,
        v.taxRate,
        v.exemptionReason as never,
        v.netAmount,
        v.taxAmount,
        v.total,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    return toLine((result.rows as InvoiceLineRow[])[0] as InvoiceLineRow)
  }

  async removeLine(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from invoice_lines where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async billedByOrderLine(scope: TenantScope, orderId: string) {
    const result = await trxOf(scope).rawQuery(
      `select l.sales_order_line_id as line_id,
              sum(l.quantity) - coalesce(sum((
                select sum(c.quantity) from credit_note_lines c
                  join credit_notes n on n.tenant_id = c.tenant_id and n.id = c.credit_note_id
                 where c.tenant_id = l.tenant_id and c.invoice_line_id = l.id and n.status = 'ISSUED'
              )), 0) as billed
         from invoice_lines l
         join invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
        where l.tenant_id = ? and i.order_id = ? and i.status in ('ISSUED', 'CREDITED') and l.sales_order_line_id is not null
        group by l.sales_order_line_id`,
      [tenantOf(scope), orderId]
    )
    return new Map(
      (result.rows as { line_id: string; billed: string }[]).map((r) => [r.line_id, r.billed])
    )
  }

  async lock(scope: TenantScope, key: string) {
    await trxOf(scope).rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
      `${tenantOf(scope)}:${key}`,
    ])
  }
}

// --- notas de crédito -------------------------------------------------------------------------------

interface CreditNoteRow {
  id: string
  organization_id: string
  invoice_id: string
  number: string | null
  issued_on: string | null
  reason: string
  net_total: string
  tax_total: string
  total: string
  status: CreditNoteStatus
  issued_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}
const NOTE_COLUMNS = `id, organization_id, invoice_id, number, issued_on::text as issued_on, reason, net_total, tax_total,
  total, status, issued_at, version, created_at, updated_at`
const toNote = (r: CreditNoteRow): CreditNote => ({
  id: r.id,
  organizationId: r.organization_id,
  invoiceId: r.invoice_id,
  number: r.number,
  issuedOn: r.issued_on,
  reason: r.reason,
  totals: { net: r.net_total, tax: r.tax_total, total: r.total },
  status: r.status,
  issuedAt: r.issued_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface NoteLineRow {
  id: string
  credit_note_id: string
  invoice_line_id: string
  quantity: string
  amount: string
  tax_amount: string
  version: number
  created_at: Date
  updated_at: Date
}
const NOTE_LINE_COLUMNS =
  'id, credit_note_id, invoice_line_id, quantity, amount, tax_amount, version, created_at, updated_at'
const toNoteLine = (r: NoteLineRow): CreditNoteLine => ({
  id: r.id,
  creditNoteId: r.credit_note_id,
  invoiceLineId: r.invoice_line_id,
  quantity: r.quantity,
  amount: r.amount,
  taxAmount: r.tax_amount,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidCreditNoteStore implements CreditNoteStore {
  async list(
    scope: TenantScope,
    filter: { invoiceId?: string; status?: CreditNoteStatus; limit: number; offset: number }
  ) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.invoiceId) {
      where.push('invoice_id = ?')
      params.push(filter.invoiceId)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${NOTE_COLUMNS} from credit_notes where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from credit_notes where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as CreditNoteRow[]).map(toNote),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${NOTE_COLUMNS} from credit_notes where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as CreditNoteRow[]
    return row ? toNote(row) : null
  }

  async insert(
    scope: TenantScope,
    v: { organizationId: string; invoiceId: string; reason: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into credit_notes (tenant_id, organization_id, invoice_id, reason, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) returning id`,
      [tenantOf(scope), v.organizationId, v.invoiceId, v.reason, actorOf(scope), actorOf(scope)]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as CreditNote
  }

  async setReason(scope: TenantScope, id: string, reason: string) {
    await trxOf(scope).rawQuery(
      `update credit_notes set reason = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [reason, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as CreditNote
  }

  async setTotals(scope: TenantScope, id: string, totals: Totals) {
    await trxOf(scope).rawQuery(
      `update credit_notes set net_total = ?, tax_total = ?, total = ?, updated_at = now(), updated_by_membership_id = ?
        where tenant_id = ? and id = ?`,
      [totals.net, totals.tax, totals.total, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as CreditNote
  }

  async issue(scope: TenantScope, id: string, number: string, issuedOn: string) {
    await trxOf(scope).rawQuery(
      `update credit_notes set status = 'ISSUED', number = ?, issued_on = ?, issued_at = now(), updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [number, issuedOn, actorOf(scope), tenantOf(scope), id]
    )
    return (await this.find(scope, id)) as CreditNote
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `delete from credit_note_lines where tenant_id = ? and credit_note_id = ?`,
      [tenantOf(scope), id]
    )
    await trxOf(scope).rawQuery(`delete from credit_notes where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async listLines(scope: TenantScope, creditNoteId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${NOTE_LINE_COLUMNS} from credit_note_lines where tenant_id = ? and credit_note_id = ? order by created_at, id`,
      [tenantOf(scope), creditNoteId]
    )
    return (result.rows as NoteLineRow[]).map(toNoteLine)
  }

  async findLine(scope: TenantScope, creditNoteId: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${NOTE_LINE_COLUMNS} from credit_note_lines where tenant_id = ? and credit_note_id = ? and id = ?`,
      [tenantOf(scope), creditNoteId, lineId]
    )
    const [row] = result.rows as NoteLineRow[]
    return row ? toNoteLine(row) : null
  }

  async insertLine(
    scope: TenantScope,
    creditNoteId: string,
    v: { invoiceLineId: string; quantity: string; amount: string; taxAmount: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into credit_note_lines (tenant_id, credit_note_id, invoice_line_id, quantity, amount, tax_amount,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning ${NOTE_LINE_COLUMNS}`,
      [
        tenantOf(scope),
        creditNoteId,
        v.invoiceLineId,
        v.quantity,
        v.amount,
        v.taxAmount,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [row] = result.rows as NoteLineRow[]
    return row ? toNoteLine(row) : null
  }

  async removeLine(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(`delete from credit_note_lines where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async creditedByInvoiceLine(scope: TenantScope, invoiceId: string) {
    const result = await trxOf(scope).rawQuery(
      `select c.invoice_line_id, sum(c.quantity) as quantity, sum(c.amount) as net, sum(c.tax_amount) as tax
         from credit_note_lines c
         join credit_notes n on n.tenant_id = c.tenant_id and n.id = c.credit_note_id
        where c.tenant_id = ? and n.invoice_id = ? and n.status = 'ISSUED'
        group by c.invoice_line_id`,
      [tenantOf(scope), invoiceId]
    )
    return new Map<string, CreditedAmounts>(
      (
        result.rows as { invoice_line_id: string; quantity: string; net: string; tax: string }[]
      ).map((r) => [r.invoice_line_id, { quantity: r.quantity, net: r.net, tax: r.tax }])
    )
  }
}
