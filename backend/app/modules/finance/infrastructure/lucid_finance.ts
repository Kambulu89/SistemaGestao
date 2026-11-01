import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import {
  balanceOf,
  viewOf,
  type AccountValues,
  type ObligationKind,
  type ObligationStatus,
  type PaymentValues,
  type SupplierInvoiceHeaderValues,
  type SupplierInvoiceLineValues,
  type InvoiceTotals,
} from '#modules/finance/domain/finance'
import type {
  AccountFilter,
  AccountStore,
  CreditCustomer,
  CreditExposure,
  CreditStore,
  Discrepancy,
  Obligation,
  ObligationAllocation,
  ObligationCredit,
  ObligationFilter,
  ObligationInsert,
  ObligationStore,
  Payment,
  PaymentAllocation,
  PaymentFilter,
  PaymentStore,
  SupplierInvoice,
  SupplierInvoiceFilter,
  SupplierInvoiceLine,
  SupplierInvoiceStore,
  TreasuryAccount,
  TreasuryEntry,
} from '#modules/finance/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const constraintOf = (error: unknown): string | undefined =>
  (error as { constraint?: string } | null)?.constraint

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

async function versioned(
  rows: { rows: unknown[] },
  current: () => Promise<{ version: number } | null>
): Promise<void> {
  if (rows.rows.length > 0) return
  const row = await current()
  if (!row) throw ApiError.notFound()
  throw ApiError.versionConflict(row.version)
}

const dateText = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value)

// --- contas -----------------------------------------------------------------------------------------

interface AccountRow {
  id: string
  organization_id: string
  code: string
  name: string
  type: AccountValues['type']
  currency: string
  bank_name: string | null
  account_identifier: string | null
  active: boolean
  version: number
  created_at: Date
  updated_at: Date
  balance: string
}

const ACCOUNT_SELECT = `
  select a.id, a.organization_id, a.code, a.name, a.type, a.currency, a.bank_name, a.account_identifier, a.active,
         a.version, a.created_at, a.updated_at,
         coalesce((select sum(e.amount_signed) from treasury_entries e
                    where e.tenant_id = a.tenant_id and e.account_id = a.id), 0)::numeric(19,4) as balance
    from treasury_accounts a`

const toAccount = (r: AccountRow): TreasuryAccount => ({
  id: r.id,
  organizationId: r.organization_id,
  code: r.code,
  name: r.name,
  type: r.type,
  currency: r.currency,
  bankName: r.bank_name,
  accountIdentifier: r.account_identifier,
  active: r.active,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  balance: r.balance,
})

export class LucidAccountStore implements AccountStore {
  async list(scope: TenantScope, filter: AccountFilter) {
    const where = ['a.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.organizationId) {
      where.push('a.organization_id = ?')
      params.push(filter.organizationId)
    }
    if (filter.active !== undefined) {
      where.push('a.active = ?')
      params.push(filter.active)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `${ACCOUNT_SELECT} where ${clause} order by a.code limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from treasury_accounts a where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as AccountRow[]).map(toAccount),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    if (lock) {
      await trxOf(scope).rawQuery(
        `select 1 from treasury_accounts where tenant_id = ? and id = ? for update`,
        [tenantOf(scope), id]
      )
    }
    const result = await trxOf(scope).rawQuery(
      `${ACCOUNT_SELECT} where a.tenant_id = ? and a.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as AccountRow[]
    return row ? toAccount(row) : null
  }

  async insert(scope: TenantScope, v: AccountValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into treasury_accounts (tenant_id, organization_id, code, name, type, currency, bank_name,
           account_identifier, active, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          tenantOf(scope),
          v.organizationId,
          v.code,
          v.name,
          v.type,
          v.currency,
          v.bankName,
          v.accountIdentifier,
          v.active,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return (await this.find(scope, (result.rows[0] as { id: string }).id)) as TreasuryAccount
    } catch (error) {
      if (constraintOf(error) === 'treasury_accounts_code_unique') return 'CODE' as const
      throw error
    }
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: AccountValues) {
    const result = await trxOf(scope).rawQuery(
      `update treasury_accounts
          set name = ?, bank_name = ?, account_identifier = ?, active = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.name,
        v.bankName,
        v.accountIdentifier,
        v.active,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return (await this.find(scope, id)) as TreasuryAccount
  }
}

// --- obrigações -------------------------------------------------------------------------------------

interface ObligationRow {
  id: string
  organization_id: string
  party_id: string
  party_name: string
  source_type: string
  source_id: string
  installment_no: number
  original_amount: string
  currency: string
  due_on: string | Date
  status: ObligationStatus
  closed_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
  credits: string
  paid: string
}

const tableOf = (kind: ObligationKind) => (kind === 'receivable' ? 'receivables' : 'payables')
const allocationColumn = (kind: ObligationKind) =>
  kind === 'receivable' ? 'receivable_id' : 'payable_id'

/** Créditos aplicados e alocações confirmadas e não revertidas: o saldo deriva sempre destes dois somatórios. */
const obligationSelect = (kind: ObligationKind) => `
  select o.id, o.organization_id, o.party_id, p.display_name as party_name, o.source_type, o.source_id,
         o.installment_no, o.original_amount, o.currency, o.due_on, o.status, o.closed_at, o.version,
         o.created_at, o.updated_at,
         ${
           kind === 'receivable'
             ? `coalesce((select sum(c.amount) from credit_applications c
                           where c.tenant_id = o.tenant_id and c.receivable_id = o.id), 0)::numeric(19,4)`
             : `0::numeric(19,4)`
         } as credits,
         coalesce((select sum(a.target_amount)
                     from payment_allocations a
                     join payments pay on pay.tenant_id = a.tenant_id and pay.id = a.payment_id
                    where a.tenant_id = o.tenant_id and a.${allocationColumn(kind)} = o.id
                      and pay.status = 'CONFIRMED' and a.reversed_at is null), 0)::numeric(19,4) as paid
    from ${tableOf(kind)} o
    join parties p on p.tenant_id = o.tenant_id and p.id = o.party_id`

const toObligation =
  (kind: ObligationKind, today: string) =>
  (r: ObligationRow): Obligation => {
    const parts = { original: r.original_amount, credits: r.credits, paid: r.paid }
    const dueOn = dateText(r.due_on)
    return {
      id: r.id,
      kind,
      organizationId: r.organization_id,
      partyId: r.party_id,
      partyName: r.party_name,
      sourceType: r.source_type,
      sourceId: r.source_id,
      installmentNo: r.installment_no,
      originalAmount: r.original_amount,
      currency: r.currency,
      dueOn,
      status: r.status,
      closedAt: r.closed_at,
      credits: r.credits,
      paid: r.paid,
      balance: balanceOf(parts),
      view: viewOf(r.status, parts, dueOn, today),
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }

export class LucidObligationStore implements ObligationStore {
  async list(scope: TenantScope, kind: ObligationKind, filter: ObligationFilter) {
    const where = ['o.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['o.party_id', filter.partyId],
      ['o.organization_id', filter.organizationId],
      ['o.source_id', filter.sourceId],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    if (filter.dueBefore) {
      where.push('o.due_on <= ?')
      params.push(filter.dueBefore)
    }
    // A vista deriva de estado, vencimento e pagamentos: filtra-se sobre a consulta já calculada.
    const base = obligationSelect(kind)
    const wrapped = `select * from (${base} where ${where.join(' and ')}) x`
    const viewClause = this.viewClause(filter)
    const rows = await trxOf(scope).rawQuery(
      `${wrapped} ${viewClause.sql} order by x.due_on, x.created_at limit ? offset ?`,
      [...params, ...viewClause.params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from (${base} where ${where.join(' and ')}) x ${viewClause.sql}`,
      [...params, ...viewClause.params] as never[]
    )
    return {
      items: (rows.rows as ObligationRow[]).map(toObligation(kind, filter.today)),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  private viewClause(filter: ObligationFilter): { sql: string; params: unknown[] } {
    switch (filter.view) {
      case 'CLOSED':
        return { sql: `where x.status = 'CLOSED'`, params: [] }
      case 'CANCELLED':
        return { sql: `where x.status = 'CANCELLED'`, params: [] }
      case 'OVERDUE':
        return { sql: `where x.status = 'OPEN' and x.due_on < ?`, params: [filter.today] }
      case 'PARTIAL':
        return {
          sql: `where x.status = 'OPEN' and x.due_on >= ? and (x.credits + x.paid) > 0`,
          params: [filter.today],
        }
      case 'OPEN':
        return {
          sql: `where x.status = 'OPEN' and x.due_on >= ? and (x.credits + x.paid) = 0`,
          params: [filter.today],
        }
      default:
        return { sql: '', params: [] }
    }
  }

  async find(scope: TenantScope, kind: ObligationKind, id: string, today: string, lock = false) {
    if (lock) {
      await trxOf(scope).rawQuery(
        `select 1 from ${tableOf(kind)} where tenant_id = ? and id = ? for update`,
        [tenantOf(scope), id]
      )
    }
    const result = await trxOf(scope).rawQuery(
      `${obligationSelect(kind)} where o.tenant_id = ? and o.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as ObligationRow[]
    return row ? toObligation(kind, today)(row) : null
  }

  async findBySource(
    scope: TenantScope,
    kind: ObligationKind,
    sourceType: string,
    sourceId: string,
    today: string
  ) {
    const result = await trxOf(scope).rawQuery(
      `${obligationSelect(kind)} where o.tenant_id = ? and o.source_type = ? and o.source_id = ?
        order by o.installment_no limit 1`,
      [tenantOf(scope), sourceType, sourceId]
    )
    const [row] = result.rows as ObligationRow[]
    return row ? toObligation(kind, today)(row) : null
  }

  async insert(scope: TenantScope, kind: ObligationKind, v: ObligationInsert) {
    const result = await trxOf(scope).rawQuery(
      `insert into ${tableOf(kind)} (tenant_id, organization_id, party_id, source_type, source_id, installment_no,
         original_amount, currency, due_on, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, source_type, source_id, installment_no) do nothing returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.partyId,
        v.sourceType,
        v.sourceId,
        v.installmentNo,
        v.originalAmount,
        v.currency,
        v.dueOn,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (result.rows[0] as { id: string } | undefined)?.id ?? null
  }

  async setStatus(scope: TenantScope, kind: ObligationKind, id: string, status: ObligationStatus) {
    await trxOf(scope).rawQuery(
      `update ${tableOf(kind)}
          set status = ?, closed_at = case when ? = 'CLOSED' then now() else null end, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [status, status, actorOf(scope), tenantOf(scope), id] as never[]
    )
  }

  async allocations(scope: TenantScope, kind: ObligationKind, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select a.id, a.payment_id, pay.status as payment_status, a.target_amount as amount, a.reversed_at,
              pay.occurred_on
         from payment_allocations a
         join payments pay on pay.tenant_id = a.tenant_id and pay.id = a.payment_id
        where a.tenant_id = ? and a.${allocationColumn(kind)} = ?
        order by pay.occurred_on, a.created_at`,
      [tenantOf(scope), id]
    )
    return (
      result.rows as {
        id: string
        payment_id: string
        payment_status: ObligationAllocation['paymentStatus']
        amount: string
        reversed_at: Date | null
        occurred_on: string | Date
      }[]
    ).map((r): ObligationAllocation => ({
      id: r.id,
      paymentId: r.payment_id,
      paymentStatus: r.payment_status,
      amount: r.amount,
      reversedAt: r.reversed_at,
      occurredOn: dateText(r.occurred_on),
    }))
  }

  async credits(scope: TenantScope, receivableId: string) {
    const result = await trxOf(scope).rawQuery(
      `select id, source_type, source_id, amount, created_at from credit_applications
        where tenant_id = ? and receivable_id = ? order by created_at`,
      [tenantOf(scope), receivableId]
    )
    return (
      result.rows as {
        id: string
        source_type: string
        source_id: string
        amount: string
        created_at: Date
      }[]
    ).map((r): ObligationCredit => ({
      id: r.id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      amount: r.amount,
      createdAt: r.created_at,
    }))
  }

  async insertCredit(
    scope: TenantScope,
    v: { receivableId: string; sourceType: string; sourceId: string; amount: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into credit_applications (tenant_id, receivable_id, source_type, source_id, amount,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, source_type, source_id) do nothing returning id`,
      [
        tenantOf(scope),
        v.receivableId,
        v.sourceType,
        v.sourceId,
        v.amount,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return result.rows.length > 0
  }
}

// --- pagamentos -------------------------------------------------------------------------------------

interface PaymentRow {
  id: string
  organization_id: string
  direction: PaymentValues['direction']
  party_id: string
  party_name: string
  treasury_account_id: string
  amount: string
  currency: string
  method: PaymentValues['method']
  occurred_on: string | Date
  reference: string | null
  status: Payment['status']
  provider: string | null
  provider_reference: string | null
  confirmed_at: Date | null
  reversed_at: Date | null
  reverse_reason: string | null
  failure_reason: string | null
  version: number
  created_at: Date
  updated_at: Date
}

const PAYMENT_SELECT = `
  select pay.id, pay.organization_id, pay.direction, pay.party_id, p.display_name as party_name,
         pay.treasury_account_id, pay.amount, pay.currency, pay.method, pay.occurred_on, pay.reference, pay.status,
         pay.provider, pay.provider_reference, pay.confirmed_at, pay.reversed_at, pay.reverse_reason,
         pay.failure_reason, pay.version, pay.created_at, pay.updated_at
    from payments pay
    join parties p on p.tenant_id = pay.tenant_id and p.id = pay.party_id`

const toPayment = (r: PaymentRow): Payment => ({
  id: r.id,
  organizationId: r.organization_id,
  direction: r.direction,
  partyId: r.party_id,
  partyName: r.party_name,
  treasuryAccountId: r.treasury_account_id,
  amount: r.amount,
  currency: r.currency,
  method: r.method,
  occurredOn: dateText(r.occurred_on),
  reference: r.reference,
  status: r.status,
  provider: r.provider,
  providerReference: r.provider_reference,
  confirmedAt: r.confirmed_at,
  reversedAt: r.reversed_at,
  reverseReason: r.reverse_reason,
  failureReason: r.failure_reason,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toEntry = (r: {
  id: string
  account_id: string
  payment_id: string | null
  amount_signed: string
  occurred_on: string | Date
  reversal_of_id: string | null
  created_at: Date
}): TreasuryEntry => ({
  id: r.id,
  accountId: r.account_id,
  paymentId: r.payment_id,
  amountSigned: r.amount_signed,
  occurredOn: dateText(r.occurred_on),
  reversalOfId: r.reversal_of_id,
  createdAt: r.created_at,
})

export class LucidPaymentStore implements PaymentStore {
  async list(scope: TenantScope, filter: PaymentFilter) {
    const where = ['pay.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['pay.direction', filter.direction],
      ['pay.status', filter.status],
      ['pay.party_id', filter.partyId],
      ['pay.treasury_account_id', filter.treasuryAccountId],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `${PAYMENT_SELECT} where ${clause} order by pay.occurred_on desc, pay.created_at desc limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from payments pay where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as PaymentRow[]).map(toPayment),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    if (lock) {
      await trxOf(scope).rawQuery(
        `select 1 from payments where tenant_id = ? and id = ? for update`,
        [tenantOf(scope), id]
      )
    }
    const result = await trxOf(scope).rawQuery(
      `${PAYMENT_SELECT} where pay.tenant_id = ? and pay.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as PaymentRow[]
    return row ? toPayment(row) : null
  }

  async findByIdempotencyKey(scope: TenantScope, key: string) {
    const result = await trxOf(scope).rawQuery(
      `${PAYMENT_SELECT} where pay.tenant_id = ? and pay.idempotency_key = ?`,
      [tenantOf(scope), key]
    )
    const [row] = result.rows as PaymentRow[]
    return row ? toPayment(row) : null
  }

  async insert(scope: TenantScope, v: PaymentValues, idempotencyKey: string | null) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into payments (tenant_id, organization_id, direction, party_id, treasury_account_id, amount, currency,
           method, occurred_on, reference, idempotency_key, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          tenantOf(scope),
          v.organizationId,
          v.direction,
          v.partyId,
          v.treasuryAccountId,
          v.amount,
          v.currency,
          v.method,
          v.occurredOn,
          v.reference,
          idempotencyKey,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      const id = (result.rows[0] as { id: string }).id
      for (const a of v.allocations) {
        await trxOf(scope).rawQuery(
          `insert into payment_allocations (tenant_id, payment_id, receivable_id, payable_id, amount, target_currency,
             exchange_rate, target_amount, created_by_membership_id, updated_by_membership_id)
           values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          [
            tenantOf(scope),
            id,
            a.receivableId,
            a.payableId,
            a.amount,
            v.currency,
            a.amount,
            actorOf(scope),
            actorOf(scope),
          ] as never[]
        )
      }
      return (await this.find(scope, id)) as Payment
    } catch (error) {
      if (constraintOf(error) === 'payments_idempotency_unique') return 'KEY' as const
      throw error
    }
  }

  async allocations(scope: TenantScope, paymentId: string) {
    const result = await trxOf(scope).rawQuery(
      `select id, payment_id, receivable_id, payable_id, amount, reversed_at
         from payment_allocations where tenant_id = ? and payment_id = ? order by created_at, id`,
      [tenantOf(scope), paymentId]
    )
    return (
      result.rows as {
        id: string
        payment_id: string
        receivable_id: string | null
        payable_id: string | null
        amount: string
        reversed_at: Date | null
      }[]
    ).map((r): PaymentAllocation => ({
      id: r.id,
      paymentId: r.payment_id,
      receivableId: r.receivable_id,
      payableId: r.payable_id,
      amount: r.amount,
      reversedAt: r.reversed_at,
    }))
  }

  async setStatus(
    scope: TenantScope,
    id: string,
    patch:
      | { status: 'PENDING' }
      | { status: 'CONFIRMED' }
      | { status: 'FAILED'; reason: string }
      | { status: 'REVERSED'; reason: string }
  ) {
    await trxOf(scope).rawQuery(
      `update payments
          set status = ?,
              confirmed_at = case when ? = 'CONFIRMED' then now() else confirmed_at end,
              reversed_at = case when ? = 'REVERSED' then now() else reversed_at end,
              reverse_reason = case when ? = 'REVERSED' then ? else reverse_reason end,
              failure_reason = case when ? = 'FAILED' then ? else failure_reason end,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [
        patch.status,
        patch.status,
        patch.status,
        patch.status,
        'reason' in patch ? patch.reason : null,
        patch.status,
        'reason' in patch ? patch.reason : null,
        actorOf(scope),
        tenantOf(scope),
        id,
      ] as never[]
    )
    return (await this.find(scope, id)) as Payment
  }

  async markAllocationsReversed(scope: TenantScope, paymentId: string) {
    await trxOf(scope).rawQuery(
      `update payment_allocations set reversed_at = now(), updated_at = now(), version = version + 1
        where tenant_id = ? and payment_id = ? and reversed_at is null`,
      [tenantOf(scope), paymentId]
    )
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `delete from payment_allocations where tenant_id = ? and payment_id = ?`,
      [tenantOf(scope), id]
    )
    await trxOf(scope).rawQuery(`delete from payments where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }

  async insertEntry(
    scope: TenantScope,
    v: {
      accountId: string
      paymentId: string
      amountSigned: string
      occurredOn: string
      reversalOfId: string | null
      sourceKey: string
    }
  ) {
    await trxOf(scope).rawQuery(
      `insert into treasury_entries (tenant_id, account_id, payment_id, amount_signed, occurred_on, reversal_of_id,
         source_key, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantOf(scope),
        v.accountId,
        v.paymentId,
        v.amountSigned,
        v.occurredOn,
        v.reversalOfId,
        v.sourceKey,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
  }

  async entryOf(scope: TenantScope, paymentId: string) {
    const result = await trxOf(scope).rawQuery(
      `select id, account_id, payment_id, amount_signed, occurred_on, reversal_of_id, created_at
         from treasury_entries where tenant_id = ? and payment_id = ? and reversal_of_id is null`,
      [tenantOf(scope), paymentId]
    )
    const [row] = result.rows as Parameters<typeof toEntry>[0][]
    return row ? toEntry(row) : null
  }

  async entries(scope: TenantScope, accountId: string, limit: number, offset: number) {
    const rows = await trxOf(scope).rawQuery(
      `select id, account_id, payment_id, amount_signed, occurred_on, reversal_of_id, created_at
         from treasury_entries where tenant_id = ? and account_id = ?
        order by occurred_on desc, created_at desc, id limit ? offset ?`,
      [tenantOf(scope), accountId, limit, offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from treasury_entries where tenant_id = ? and account_id = ?`,
      [tenantOf(scope), accountId]
    )
    return {
      items: (rows.rows as Parameters<typeof toEntry>[0][]).map(toEntry),
      total: (count.rows[0] as { total: number }).total,
    }
  }
}

// --- facturas de fornecedor --------------------------------------------------------------------------

interface SupplierInvoiceRow {
  id: string
  organization_id: string
  supplier_id: string
  supplier_name: string
  external_number: string
  purchase_order_id: string | null
  invoice_date: string | Date
  due_on: string | Date
  currency: string
  net_amount: string
  tax_amount: string
  total: string
  status: SupplierInvoice['status']
  matching: Discrepancy[] | null
  override_reason: string | null
  validated_at: Date | null
  notes: string | null
  version: number
  created_at: Date
  updated_at: Date
}

const INVOICE_SELECT = `
  select i.id, i.organization_id, i.supplier_id, p.display_name as supplier_name, i.external_number,
         i.purchase_order_id, i.invoice_date, i.due_on, i.currency, i.net_amount, i.tax_amount, i.total, i.status,
         i.matching, i.override_reason, i.validated_at, i.notes, i.version, i.created_at, i.updated_at
    from supplier_invoices i
    join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id
    join parties p on p.tenant_id = s.tenant_id and p.id = s.party_id`

const toInvoice = (r: SupplierInvoiceRow): SupplierInvoice => ({
  id: r.id,
  organizationId: r.organization_id,
  supplierId: r.supplier_id,
  supplierName: r.supplier_name,
  externalNumber: r.external_number,
  purchaseOrderId: r.purchase_order_id,
  invoiceDate: dateText(r.invoice_date),
  dueOn: dateText(r.due_on),
  currency: r.currency,
  totals: { net: r.net_amount, tax: r.tax_amount, total: r.total },
  status: r.status,
  matching: r.matching,
  overrideReason: r.override_reason,
  validatedAt: r.validated_at,
  notes: r.notes,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidSupplierInvoiceStore implements SupplierInvoiceStore {
  async list(scope: TenantScope, filter: SupplierInvoiceFilter) {
    const where = ['i.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    for (const [column, value] of [
      ['i.supplier_id', filter.supplierId],
      ['i.status', filter.status],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    if (filter.q) {
      where.push(`lower(i.external_number) like ?`)
      params.push(`%${escapeLike(filter.q.toLowerCase())}%`)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `${INVOICE_SELECT} where ${clause} order by i.invoice_date desc, i.created_at desc limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from supplier_invoices i where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as SupplierInvoiceRow[]).map(toInvoice),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    if (lock) {
      await trxOf(scope).rawQuery(
        `select 1 from supplier_invoices where tenant_id = ? and id = ? for update`,
        [tenantOf(scope), id]
      )
    }
    const result = await trxOf(scope).rawQuery(
      `${INVOICE_SELECT} where i.tenant_id = ? and i.id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as SupplierInvoiceRow[]
    return row ? toInvoice(row) : null
  }

  async insert(scope: TenantScope, v: SupplierInvoiceHeaderValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into supplier_invoices (tenant_id, organization_id, supplier_id, external_number, purchase_order_id,
           invoice_date, due_on, currency, notes, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          tenantOf(scope),
          v.organizationId,
          v.supplierId,
          v.externalNumber,
          v.purchaseOrderId,
          v.invoiceDate,
          v.dueOn,
          v.currency,
          v.notes,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return (await this.find(scope, (result.rows[0] as { id: string }).id)) as SupplierInvoice
    } catch (error) {
      if (constraintOf(error) === 'supplier_invoices_external_unique') return 'NUMBER' as const
      throw error
    }
  }

  async updateHeader(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: SupplierInvoiceHeaderValues
  ) {
    try {
      const result = await trxOf(scope).rawQuery(
        `update supplier_invoices
            set external_number = ?, purchase_order_id = ?, invoice_date = ?, due_on = ?, notes = ?,
                status = 'DRAFT', matching = null, updated_at = now(), updated_by_membership_id = ?,
                version = version + 1
          where tenant_id = ? and id = ? and version = ? returning id`,
        [
          v.externalNumber,
          v.purchaseOrderId,
          v.invoiceDate,
          v.dueOn,
          v.notes,
          actorOf(scope),
          tenantOf(scope),
          id,
          expectedVersion,
        ] as never[]
      )
      await versioned(result, () => this.find(scope, id))
      return (await this.find(scope, id)) as SupplierInvoice
    } catch (error) {
      if (constraintOf(error) === 'supplier_invoices_external_unique') return 'NUMBER' as const
      throw error
    }
  }

  async lines(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select id, supplier_invoice_id, position, purchase_line_id, description, quantity, unit_price, tax_rate,
              net_amount, tax_amount, total, version, created_at, updated_at
         from supplier_invoice_lines where tenant_id = ? and supplier_invoice_id = ? order by position`,
      [tenantOf(scope), id]
    )
    return (
      result.rows as {
        id: string
        supplier_invoice_id: string
        position: number
        purchase_line_id: string | null
        description: string
        quantity: string
        unit_price: string
        tax_rate: string
        net_amount: string
        tax_amount: string
        total: string
        version: number
        created_at: Date
        updated_at: Date
      }[]
    ).map((r): SupplierInvoiceLine => ({
      id: r.id,
      supplierInvoiceId: r.supplier_invoice_id,
      position: r.position,
      purchaseLineId: r.purchase_line_id,
      description: r.description,
      quantity: r.quantity,
      unitPrice: r.unit_price,
      taxRate: r.tax_rate,
      netAmount: r.net_amount,
      taxAmount: r.tax_amount,
      total: r.total,
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  }

  async insertLine(scope: TenantScope, id: string, line: SupplierInvoiceLineValues) {
    await trxOf(scope).rawQuery(
      `insert into supplier_invoice_lines (tenant_id, supplier_invoice_id, position, purchase_line_id, description,
         quantity, unit_price, tax_rate, net_amount, tax_amount, total, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, (select coalesce(max(position), 0) + 1 from supplier_invoice_lines
                       where tenant_id = ? and supplier_invoice_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantOf(scope),
        id,
        tenantOf(scope),
        id,
        line.purchaseLineId,
        line.description,
        line.quantity,
        line.unitPrice,
        line.taxRate,
        line.netAmount,
        line.taxAmount,
        line.total,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
  }

  async removeLine(scope: TenantScope, id: string, lineId: string) {
    const result = await trxOf(scope).rawQuery(
      `delete from supplier_invoice_lines where tenant_id = ? and supplier_invoice_id = ? and id = ? returning id`,
      [tenantOf(scope), id, lineId]
    )
    return result.rows.length > 0
  }

  async setTotals(scope: TenantScope, id: string, totals: InvoiceTotals) {
    await trxOf(scope).rawQuery(
      `update supplier_invoices
          set net_amount = ?, tax_amount = ?, total = ?, status = 'DRAFT', matching = null, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [totals.net, totals.tax, totals.total, actorOf(scope), tenantOf(scope), id] as never[]
    )
  }

  async setValidation(
    scope: TenantScope,
    id: string,
    patch:
      | { status: 'VALIDATED'; matching: Discrepancy[] | null; overrideReason: string | null }
      | { status: 'DISPUTED'; matching: Discrepancy[] }
      | { status: 'VOID' }
  ) {
    const matching =
      'matching' in patch && patch.matching !== null ? JSON.stringify(patch.matching) : null
    await trxOf(scope).rawQuery(
      `update supplier_invoices
          set status = ?, matching = ?::jsonb, override_reason = ?,
              validated_at = case when ? = 'VALIDATED' then now() else null end,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [
        patch.status,
        matching,
        'overrideReason' in patch ? patch.overrideReason : null,
        patch.status,
        actorOf(scope),
        tenantOf(scope),
        id,
      ] as never[]
    )
    return (await this.find(scope, id)) as SupplierInvoice
  }

  async invoicedByPurchaseLine(
    scope: TenantScope,
    purchaseLineIds: readonly string[],
    exceptInvoiceId: string
  ) {
    const map = new Map<string, string>()
    if (purchaseLineIds.length === 0) return map
    const result = await trxOf(scope).rawQuery(
      `select l.purchase_line_id, sum(l.quantity)::numeric(19,6) as quantity
         from supplier_invoice_lines l
         join supplier_invoices i on i.tenant_id = l.tenant_id and i.id = l.supplier_invoice_id
        where l.tenant_id = ? and i.status = 'VALIDATED' and i.id <> ?
          and l.purchase_line_id = any(?::uuid[])
        group by l.purchase_line_id`,
      [tenantOf(scope), exceptInvoiceId, purchaseLineIds as string[]] as never[]
    )
    for (const row of result.rows as { purchase_line_id: string; quantity: string }[]) {
      map.set(row.purchase_line_id, row.quantity)
    }
    return map
  }

  async remove(scope: TenantScope, id: string) {
    await trxOf(scope).rawQuery(
      `delete from supplier_invoice_lines where tenant_id = ? and supplier_invoice_id = ?`,
      [tenantOf(scope), id]
    )
    await trxOf(scope).rawQuery(`delete from supplier_invoices where tenant_id = ? and id = ?`, [
      tenantOf(scope),
      id,
    ])
  }
}

// --- crédito ----------------------------------------------------------------------------------------

export class LucidCreditStore implements CreditStore {
  /** Leitura do cliente (junção só de leitura, tal como a Party nas compras): o limite pertence às vendas. */
  async customer(scope: TenantScope, customerId: string): Promise<CreditCustomer | null> {
    const result = await trxOf(scope).rawQuery(
      `select id, party_id, organization_id, credit_limit, currency, status
         from customers where tenant_id = ? and id = ?`,
      [tenantOf(scope), customerId]
    )
    const [row] = result.rows as {
      id: string
      party_id: string
      organization_id: string
      credit_limit: string
      currency: string
      status: string
    }[]
    return row
      ? {
          id: row.id,
          partyId: row.party_id,
          organizationId: row.organization_id,
          creditLimit: row.credit_limit,
          currency: row.currency,
          status: row.status,
        }
      : null
  }

  async lockCustomer(scope: TenantScope, customerId: string) {
    await trxOf(scope).rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
      `${tenantOf(scope)}:credit:${customerId}`,
    ])
  }

  async exposure(scope: TenantScope, customer: CreditCustomer): Promise<CreditExposure> {
    const receivables = await trxOf(scope).rawQuery(
      `select coalesce(sum(greatest(
                o.original_amount
                - coalesce((select sum(c.amount) from credit_applications c
                             where c.tenant_id = o.tenant_id and c.receivable_id = o.id), 0)
                - coalesce((select sum(a.target_amount) from payment_allocations a
                              join payments pay on pay.tenant_id = a.tenant_id and pay.id = a.payment_id
                             where a.tenant_id = o.tenant_id and a.receivable_id = o.id
                               and pay.status = 'CONFIRMED' and a.reversed_at is null), 0), 0)), 0)::numeric(19,4)
                as open_amount
         from receivables o
        where o.tenant_id = ? and o.organization_id = ? and o.party_id = ? and o.status = 'OPEN' and o.currency = ?`,
      [tenantOf(scope), customer.organizationId, customer.partyId, customer.currency]
    )
    const reservations = await trxOf(scope).rawQuery(
      `select coalesce(sum(remaining), 0)::numeric(19,4) as reserved
         from credit_reservations
        where tenant_id = ? and customer_id = ? and status = 'ACTIVE' and currency = ?`,
      [tenantOf(scope), customer.id, customer.currency]
    )
    const open = (receivables.rows[0] as { open_amount: string }).open_amount
    const reserved = (reservations.rows[0] as { reserved: string }).reserved
    const total = (BigInt(open.replace('.', '')) + BigInt(reserved.replace('.', ''))).toString()
    const padded = total.padStart(5, '0')
    return {
      openReceivables: open,
      reservations: reserved,
      exposure: `${padded.slice(0, -4)}.${padded.slice(-4)}`,
    }
  }

  async insertReservation(
    scope: TenantScope,
    v: {
      organizationId: string
      customerId: string
      orderId: string
      currency: string
      amount: string
    }
  ) {
    await trxOf(scope).rawQuery(
      `insert into credit_reservations (tenant_id, organization_id, customer_id, order_id, currency, amount,
         remaining, status, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
       on conflict (tenant_id, order_id) do update
         set amount = excluded.amount, remaining = excluded.remaining, status = 'ACTIVE', updated_at = now(),
             version = credit_reservations.version + 1`,
      [
        tenantOf(scope),
        v.organizationId,
        v.customerId,
        v.orderId,
        v.currency,
        v.amount,
        v.amount,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
  }

  async releaseReservation(scope: TenantScope, orderId: string) {
    await trxOf(scope).rawQuery(
      `update credit_reservations
          set remaining = 0, status = 'RELEASED', updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and order_id = ? and status = 'ACTIVE'`,
      [actorOf(scope), tenantOf(scope), orderId] as never[]
    )
  }

  async consumeReservation(scope: TenantScope, orderId: string, amount: string) {
    await trxOf(scope).rawQuery(
      `update credit_reservations
          set remaining = greatest(remaining - ?::numeric, 0),
              status = case when remaining - ?::numeric <= 0 then 'RELEASED' else 'ACTIVE' end,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and order_id = ? and status = 'ACTIVE'`,
      [amount, amount, actorOf(scope), tenantOf(scope), orderId] as never[]
    )
  }
}
