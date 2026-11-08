import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { covers, findRow, placementOf, scopeClause } from '#modules/hr/application/employee_service'
import { contractTermsAt } from '#modules/hr/application/career_service'
import { hrSettings } from '#modules/hr/application/recruitment_service'
import { cents, normalizeFields } from '#modules/hr/domain/recruitment'
import { moneyText } from '#modules/hr/domain/compensation'
import {
  LOAN_KINDS,
  type LoanKind,
  maxMonthlyDeduction,
  moneyLabel,
  monthLabel,
  percentLabel,
  periodEnd,
  periodStart,
  schedule,
} from '#modules/hr/domain/loans'

/*
 * Adiantamentos e empréstimos (7.6). Por colaborador, no âmbito da sua colocação: ver `hr.loans.read` (o próprio com
 * OWN), preparar, cancelar e registar pagamentos `hr.loans.manage`, aprovar `hr.loans.approve` sem ser quem preparou
 * nem o próprio. O plano de prestações nasce na aprovação e cada prestação liquida-se uma única vez (desconto no
 * processamento salarial, idempotente pela referência, ou pagamento directo). Os montantes nunca vão para a auditoria.
 */

const RESERVED = '[RESERVADO]'
const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const wrongState = (message: string): never => {
  throw ApiError.conflict('INVALID_STATE', message)
}
const today = () => new Date().toISOString().slice(0, 10)

interface LoanScopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
}

async function loanScopes(scope: TenantScope): Promise<LoanScopes> {
  const [read, manage, approve] = await Promise.all(
    ['hr.loans.read', 'hr.loans.manage', 'hr.loans.approve'].map((p) => permissionScope(scope, p))
  )
  return { read, manage, approve }
}

async function employeeFor(scope: TenantScope, s: LoanScopes, id: string, lock = false) {
  const e = isUuid(id) ? await findRow(scope, id, lock) : null
  if (!e) throw ApiError.notFound()
  const me = scope.context.membershipId
  const place = placementOf(e)
  const manage = covers(noOwn(s.manage), place, me)
  const approve = covers(noOwn(s.approve), place, me)
  if (!manage && !approve && !covers(s.read, place, me)) throw ApiError.notFound()
  return { e, manage, approve }
}

const LOAN_SELECT = `select l.*, l.first_period::text as first_text, e.code as employee_code,
    e.full_name as employee_name, e.legal_entity_id, e.branch_id, e.department_id, e.membership_id,
    u.full_name as decided_by_name, cu.full_name as created_by_name,
    coalesce(b.paid, 0)::text as paid_amount, coalesce(b.pending, 0)::text as outstanding_amount
  from employee_loans l
  join employees e on e.tenant_id = l.tenant_id and e.id = l.employee_id
  left join tenant_memberships dm on dm.tenant_id = l.tenant_id and dm.id = l.decided_by_membership_id
  left join users u on u.id = dm.user_id
  left join users cu on cu.id = l.created_by
  left join lateral (select sum(i.amount) filter (where i.status in ('DEDUCTED','PAID')) as paid,
      sum(i.amount) filter (where i.status = 'PENDING') as pending
    from employee_loan_installments i where i.tenant_id = l.tenant_id and i.loan_id = l.id) b on true`

async function findLoan(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${LOAN_SELECT} where l.tenant_id = ? and l.id = ?${lock ? ' for update of l' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

async function installmentsOf(scope: TenantScope, loanId: string) {
  const r = await scope.trx.rawQuery(
    `select i.*, i.due_period::text as due_text, i.settled_on::text as settled_text
       from employee_loan_installments i where i.tenant_id = ? and i.loan_id = ? order by i.sequence`,
    [scope.context.tenantId, loanId]
  )
  return (r.rows as any[]).map((i) => ({
    id: i.id as string,
    sequence: Number(i.sequence),
    duePeriod: i.due_text as string,
    amount: i.amount as string,
    status: i.status as 'PENDING' | 'DEDUCTED' | 'PAID' | 'CANCELLED',
    settlementReference: (i.settlement_reference as string) ?? null,
    settledOn: (i.settled_text as string) ?? null,
    settlementNote: (i.settlement_note as string) ?? null,
  }))
}

function loanView(l: any, installments: Awaited<ReturnType<typeof installmentsOf>>) {
  // Antes da aprovação mostra-se o plano que será criado (sem identificadores).
  const plan = installments.length
    ? installments
    : schedule(l.principal, Number(l.installments_count), l.first_text).map((x) => ({
        id: null,
        ...x,
        status: 'PLANNED' as const,
        settlementReference: null,
        settledOn: null,
        settlementNote: null,
      }))
  return {
    id: l.id as string,
    version: Number(l.version),
    code: l.code as string,
    employee: {
      id: l.employee_id as string,
      code: l.employee_code as string,
      fullName: l.employee_name as string,
    },
    kind: l.kind as LoanKind,
    currency: l.currency as string,
    principal: l.principal as string,
    installmentsCount: Number(l.installments_count),
    firstPeriod: l.first_text as string,
    reason: l.reason as string,
    status: l.status as string,
    paidAmount: moneyText(cents(l.paid_amount) ?? 0n),
    outstandingAmount: installments.length
      ? moneyText(cents(l.outstanding_amount) ?? 0n)
      : (l.principal as string),
    decidedBy: (l.decided_by_name as string) ?? null,
    decidedAt: l.decided_at ?? null,
    decisionComment: (l.decision_comment as string) ?? null,
    createdBy: (l.created_by_name as string) ?? null,
    createdAt: l.created_at,
    installments: plan,
  }
}

function loanInput(input: Record<string, unknown>) {
  const { values: v, issues } = normalizeFields(input, {
    principal: { kind: 'money', label: 'Montante' },
    installmentsCount: { kind: 'int', min: 1, max: 120, label: 'Prestações' },
    reason: { kind: 'longtext', min: 3, max: 2000, label: 'Motivo' },
  })
  if ('kind' in input) {
    if (!LOAN_KINDS.includes(input.kind as LoanKind))
      issues.push({ path: 'kind', code: 'INVALID', message: 'Adiantamento ou empréstimo.' })
    else v.kind = input.kind
  }
  if ('firstPeriod' in input) {
    const p = periodStart(input.firstPeriod)
    if (!p)
      issues.push({ path: 'firstPeriod', code: 'INVALID', message: 'Mês inválido (AAAA-MM).' })
    else v.firstPeriod = p
  }
  for (const k of ['kind', 'principal', 'installmentsCount', 'firstPeriod', 'reason'])
    if (v[k] === null || v[k] === undefined)
      if (!issues.some((i) => i.path === k))
        issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
  if (v.principal && (cents(v.principal) ?? 0n) <= 0n)
    issues.push({ path: 'principal', code: 'POSITIVE', message: 'O montante tem de ser positivo.' })
  if (v.kind === 'ADVANCE' && v.installmentsCount !== undefined && v.installmentsCount !== 1)
    issues.push({
      path: 'installmentsCount',
      code: 'ADVANCE_SINGLE',
      message: 'Um adiantamento recupera-se numa única prestação.',
    })
  // Cada prestação tem de ter pelo menos um cêntimo.
  if (
    v.principal &&
    typeof v.installmentsCount === 'number' &&
    (cents(v.principal) ?? 0n) < BigInt(v.installmentsCount)
  )
    issues.push({
      path: 'installmentsCount',
      code: 'TOO_SMALL',
      message: 'Montante insuficiente para tantas prestações.',
    })
  return { values: v, issues }
}

/**
 * Verificações que dependem do estado actual (ao submeter e de novo ao aprovar): o primeiro mês não é passado; o
 * número de prestações cabe no máximo configurado; há contrato em cada mês de desconto, na mesma moeda; e, havendo
 * limite configurado, a soma das prestações do mês (esta e as pendentes de outros empréstimos activos) não passa da
 * percentagem do salário base desse mês.
 */
async function stateIssues(scope: TenantScope, l: any) {
  const issues: ErrorDetail[] = []
  const settings = await hrSettings(scope)
  const count = Number(l.installments_count)
  if (l.first_text < periodStart(today())!)
    issues.push({
      path: 'firstPeriod',
      code: 'NOT_RETROACTIVE',
      message: 'O primeiro desconto não pode ser num mês já passado.',
    })
  if (settings.loanMaxInstallments !== null && count > settings.loanMaxInstallments)
    issues.push({
      path: 'installmentsCount',
      code: 'TOO_MANY_INSTALLMENTS',
      message: `No máximo ${settings.loanMaxInstallments} prestações (${settings.loanPolicyReference}).`,
    })
  const plan = schedule(l.principal, count, l.first_text)
  const others = await scope.trx.rawQuery(
    `select i.due_period::text as due_text, sum(i.amount)::text as total from employee_loan_installments i
       join employee_loans o on o.tenant_id = i.tenant_id and o.id = i.loan_id
      where i.tenant_id = ? and o.employee_id = ? and o.id <> ? and o.status = 'ACTIVE' and i.status = 'PENDING'
      group by i.due_period`,
    [scope.context.tenantId, l.employee_id, l.id]
  )
  const used = new Map(
    (others.rows as any[]).map((x) => [x.due_text as string, cents(x.total) ?? 0n])
  )
  for (const p of plan) {
    const terms =
      (await contractTermsAt(scope, l.employee_id, p.duePeriod)) ??
      (await contractTermsAt(scope, l.employee_id, periodEnd(p.duePeriod)))
    const month = monthLabel(p.duePeriod)
    if (!terms || (terms.endDate && terms.endDate < p.duePeriod)) {
      issues.push({
        path: 'installmentsCount',
        code: terms ? 'LOAN_BEYOND_CONTRACT' : 'NO_CONTRACT',
        message: `Sem contrato em vigor em ${month}: não há salário onde descontar.`,
      })
      break
    }
    if (terms.currency !== l.currency) {
      issues.push({
        path: 'currency',
        code: 'CURRENCY_MISMATCH',
        message: `O contrato é em ${terms.currency}.`,
      })
      break
    }
    if (settings.loanMaxInstallmentPercent !== null) {
      const max = maxMonthlyDeduction(terms.baseSalary, settings.loanMaxInstallmentPercent)
      const total = (used.get(p.duePeriod) ?? 0n) + (cents(p.amount) ?? 0n)
      if (total > max) {
        issues.push({
          path: 'principal',
          code: 'LIMIT_EXCEEDED',
          message: `Em ${month} os descontos (${moneyLabel(total)}) passam de ${percentLabel(settings.loanMaxInstallmentPercent)}% do salário base (${moneyLabel(max)}; ${settings.loanPolicyReference}).`,
        })
        break
      }
    }
  }
  return issues
}

async function setStatus(
  scope: TenantScope,
  l: any,
  status: string,
  extra: Record<string, unknown> = {},
  metadata: Record<string, unknown> | null = null
) {
  const cols = Object.keys(extra)
  await scope.trx.rawQuery(
    `update employee_loans set status = ?${cols.map((c) => `, ${c} = ?`).join('')}, version = version + 1,
       updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
    [
      status,
      ...cols.map((c) => extra[c]),
      scope.context.userId,
      scope.context.tenantId,
      l.id,
    ] as never[]
  )
  await audit(scope, {
    action: `hr.loans.${status.toLowerCase()}`,
    entityType: 'employee_loan',
    entityId: l.id,
    changes: { status: { from: l.status, to: status } },
    metadata: { employeeId: l.employee_id, code: l.code, ...(metadata ?? {}) },
  })
}

/** Fecha o empréstimo quando já não há prestações pendentes. */
async function settleIfDone(scope: TenantScope, loanId: string) {
  const l = await findLoan(scope, loanId, true)
  if (!l || l.status !== 'ACTIVE') return
  const r = await scope.trx.rawQuery(
    `select count(*)::int as n from employee_loan_installments where tenant_id = ? and loan_id = ? and status = 'PENDING'`,
    [scope.context.tenantId, loanId]
  )
  if ((r.rows[0] as { n: number }).n === 0) await setStatus(scope, l, 'SETTLED')
}

async function nextCode(scope: TenantScope, kind: LoanKind) {
  const prefix = `${kind === 'ADVANCE' ? 'ADI' : 'EMP'}-${today().slice(0, 4)}-`
  // Serializa a numeração por empresa e prefixo dentro da transacção.
  await scope.trx.rawQuery(`select pg_advisory_xact_lock(hashtext(?))`, [
    `${scope.context.tenantId}:${prefix}`,
  ])
  const r = await scope.trx.rawQuery(
    `select coalesce(max(substring(code from ${prefix.length + 1})::int), 0) + 1 as n from employee_loans
      where tenant_id = ? and code like ? and substring(code from ${prefix.length + 1}) ~ '^[0-9]+$'`,
    [scope.context.tenantId, `${prefix}%`]
  )
  return `${prefix}${String((r.rows[0] as { n: number }).n).padStart(4, '0')}`
}

// ---------------------------------------------------------------------------------------------------------------
// Ligação ao processamento salarial (7.7)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Prestações por descontar no mês `period` (primeiro dia): as do mês e as pendentes de meses anteriores (em atraso),
 * só de empréstimos activos. O processamento decide o que desconta e regista-o com `recordLoanDeduction`.
 */
export async function dueLoanInstallments(scope: TenantScope, employeeId: string, period: string) {
  const r = await scope.trx.rawQuery(
    `select i.id, i.loan_id, i.sequence, i.due_period::text as due_text, i.amount, l.code, l.kind, l.currency
       from employee_loan_installments i
       join employee_loans l on l.tenant_id = i.tenant_id and l.id = i.loan_id
      where i.tenant_id = ? and l.employee_id = ? and l.status = 'ACTIVE' and i.status = 'PENDING'
        and i.due_period <= ?::date
      order by i.due_period, l.code, i.sequence`,
    [scope.context.tenantId, employeeId, period]
  )
  return (r.rows as any[]).map((x) => ({
    installmentId: x.id as string,
    loanId: x.loan_id as string,
    loanCode: x.code as string,
    kind: x.kind as LoanKind,
    sequence: Number(x.sequence),
    duePeriod: x.due_text as string,
    overdue: (x.due_text as string) < period,
    amount: x.amount as string,
    currency: x.currency as string,
  }))
}

/**
 * Regista o desconto de uma prestação no processamento. Idempotente: repetir com a mesma referência não faz nada;
 * uma prestação já liquidada por outra via (ou noutro processamento) dá 409 `ALREADY_SETTLED` — nunca se desconta
 * duas vezes.
 */
export async function recordLoanDeduction(
  scope: TenantScope,
  installmentId: string,
  reference: string,
  settledOn: string
) {
  if (!isUuid(installmentId)) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select i.*, l.status as loan_status, l.employee_id, l.code from employee_loan_installments i
       join employee_loans l on l.tenant_id = i.tenant_id and l.id = i.loan_id
      where i.tenant_id = ? and i.id = ? for update of i`,
    [scope.context.tenantId, installmentId]
  )
  const i = r.rows[0] as any
  if (!i) throw ApiError.notFound()
  if (i.status === 'DEDUCTED' && i.settlement_reference === reference)
    return { installmentId, status: 'DEDUCTED' as const, alreadyRecorded: true }
  if (i.status !== 'PENDING' || i.loan_status !== 'ACTIVE')
    throw ApiError.conflict('ALREADY_SETTLED', 'Esta prestação já não está por descontar.')
  await scope.trx.rawQuery(
    `update employee_loan_installments set status = 'DEDUCTED', settlement_reference = ?, settled_on = ?,
       version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ? and status = 'PENDING'`,
    [reference, settledOn, scope.context.userId, scope.context.tenantId, installmentId]
  )
  await audit(scope, {
    action: 'hr.loans.installment_deducted',
    entityType: 'employee_loan',
    entityId: i.loan_id,
    metadata: {
      employeeId: i.employee_id,
      code: i.code,
      sequence: Number(i.sequence),
      reference,
      amount: RESERVED,
    },
  })
  await settleIfDone(scope, i.loan_id)
  return { installmentId, status: 'DEDUCTED' as const, alreadyRecorded: false }
}

// ---------------------------------------------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------------------------------------------

export class LoanService {
  /** Empréstimos do colaborador com saldos. */
  forEmployee(context: TenantContext, employeeId: string) {
    return runInTenant(context, async (scope) => {
      const s = await loanScopes(scope)
      const { e, manage, approve } = await employeeFor(scope, s, employeeId)
      const r = await scope.trx.rawQuery(
        `${LOAN_SELECT} where l.tenant_id = ? and l.employee_id = ? order by l.created_at desc limit 100`,
        [context.tenantId, e.id]
      )
      const items = []
      for (const l of r.rows as any[]) items.push(loanView(l, await installmentsOf(scope, l.id)))
      const active = items.filter((x) => x.status === 'ACTIVE')
      const outstanding = active.reduce((a, x) => a + (cents(x.outstandingAmount) ?? 0n), 0n)
      return {
        employee: { id: e.id, code: e.code, fullName: e.full_name },
        items,
        outstanding: active.length ? moneyText(outstanding) : null,
        access: { manage: manage && e.status !== 'TERMINATED', approve },
      }
    })
  }

  list(
    context: TenantContext,
    f: { status?: string; kind?: string; toApprove?: boolean; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await loanScopes(scope)
      const me = context.membershipId
      const parts: string[] = []
      const params: unknown[] = []
      for (const p of [s.read, noOwn(s.manage), noOwn(s.approve)]) {
        const c = scopeClause(p, me)
        if (c) {
          parts.push(c.sql)
          params.push(...c.params)
        }
      }
      if (!parts.length) return { items: [], total: 0 }
      const where = [`l.tenant_id = ?`, `(${parts.join(' or ')})`]
      const all: unknown[] = [context.tenantId, ...params]
      if (f.status) {
        where.push('l.status = ?')
        all.push(f.status)
      }
      if (f.kind) {
        where.push('l.kind = ?')
        all.push(f.kind)
      }
      if (f.toApprove) {
        const a = scopeClause(noOwn(s.approve), me)
        if (!a) return { items: [], total: 0 }
        where.push(
          `l.status = 'PENDING_APPROVAL'`,
          `l.created_by <> ?`,
          `(e.membership_id is null or e.membership_id <> ?)`,
          a.sql
        )
        all.push(context.userId, me, ...a.params)
      }
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${LOAN_SELECT} where ${clause} order by l.created_at desc limit ? offset ?`,
        [...all, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from employee_loans l
           join employees e on e.tenant_id = l.tenant_id and e.id = l.employee_id where ${clause}`,
        all as never[]
      )
      const items = []
      for (const l of rows.rows as any[]) {
        const view: Partial<ReturnType<typeof loanView>> = loanView(
          l,
          await installmentsOf(scope, l.id)
        )
        delete view.installments
        items.push(view)
      }
      return { items, total: (count.rows[0] as { n: number }).n }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const l = await findLoan(scope, id)
      if (!l) throw ApiError.notFound()
      const s = await loanScopes(scope)
      const { manage, approve } = await employeeFor(scope, s, l.employee_id)
      const settings = await hrSettings(scope)
      const pending = ['DRAFT', 'PENDING_APPROVAL'].includes(l.status)
      return {
        ...loanView(l, await installmentsOf(scope, id)),
        limits: {
          maxInstallmentPercent: settings.loanMaxInstallmentPercent,
          maxInstallments: settings.loanMaxInstallments,
          policyReference: settings.loanPolicyReference,
        },
        // Para quem pode agir: o que impediria hoje a submissão ou a aprovação.
        issues: pending && (manage || approve) ? await stateIssues(scope, l) : [],
        access: {
          manage,
          approve:
            approve &&
            l.status === 'PENDING_APPROVAL' &&
            l.created_by !== context.userId &&
            !(l.membership_id && l.membership_id === context.membershipId),
        },
      }
    })
  }

  create(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await loanScopes(scope)
      const { e, manage } = await employeeFor(scope, s, employeeId)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere empréstimos deste colaborador.')
      if (e.status === 'TERMINATED') wrongState('O colaborador já cessou funções.')
      const { values: v, issues } = loanInput(input)
      if (!('currency' in input)) {
        // Por omissão, a moeda do contrato em vigor no primeiro mês.
        const terms = v.firstPeriod
          ? await contractTermsAt(scope, e.id, v.firstPeriod as string)
          : null
        if (terms) v.currency = terms.currency
        else issues.push({ path: 'currency', code: 'REQUIRED', message: 'Obrigatório.' })
      } else {
        const c = normalizeFields(input, { currency: { kind: 'currency', label: 'Moeda' } })
        issues.push(...c.issues)
        v.currency = c.values.currency
        if (!v.currency && !c.issues.length)
          issues.push({ path: 'currency', code: 'REQUIRED', message: 'Obrigatório.' })
      }
      fail(issues)
      const code = await nextCode(scope, v.kind as LoanKind)
      const r = await scope.trx.rawQuery(
        `insert into employee_loans (tenant_id, employee_id, code, kind, currency, principal, installments_count,
           first_period, reason, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          e.id,
          code,
          v.kind,
          v.currency,
          v.principal,
          v.installmentsCount,
          v.firstPeriod,
          v.reason,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (r.rows[0] as { id: string }).id
      await audit(scope, {
        action: 'hr.loans.created',
        entityType: 'employee_loan',
        entityId: id,
        metadata: {
          employeeId: e.id,
          code,
          kind: v.kind,
          installmentsCount: v.installmentsCount,
          firstPeriod: v.firstPeriod,
          principal: RESERVED,
        },
      })
      return loanView(await findLoan(scope, id), [])
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const l = await findLoan(scope, id, true)
      if (!l) throw ApiError.notFound()
      const s = await loanScopes(scope)
      const { manage } = await employeeFor(scope, s, l.employee_id)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere empréstimos deste colaborador.')
      if (Number(l.version) !== expectedVersion) throw ApiError.versionConflict(Number(l.version))
      if (l.status !== 'DRAFT') wrongState('Só um pedido em rascunho se altera.')
      const merged = {
        kind: input.kind ?? l.kind,
        principal: input.principal ?? l.principal,
        installmentsCount: input.installmentsCount ?? Number(l.installments_count),
        firstPeriod: input.firstPeriod ?? l.first_text,
        reason: input.reason ?? l.reason,
      }
      const { values: v, issues } = loanInput(merged)
      if ('kind' in input && input.kind !== l.kind)
        issues.push({
          path: 'kind',
          code: 'IMMUTABLE',
          message: 'O tipo não muda (o código já o identifica); cancele e crie outro.',
        })
      fail(issues)
      await scope.trx.rawQuery(
        `update employee_loans set principal = ?, installments_count = ?, first_period = ?, reason = ?,
           version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [
          v.principal,
          v.installmentsCount,
          v.firstPeriod,
          v.reason,
          context.userId,
          context.tenantId,
          id,
        ] as never[]
      )
      await audit(scope, {
        action: 'hr.loans.updated',
        entityType: 'employee_loan',
        entityId: id,
        metadata: {
          code: l.code,
          installmentsCount: v.installmentsCount,
          firstPeriod: v.firstPeriod,
          principalChanged: v.principal !== l.principal,
        },
      })
      return loanView(await findLoan(scope, id), [])
    })
  }

  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const l = await findLoan(scope, id, true)
      if (!l) throw ApiError.notFound()
      const s = await loanScopes(scope)
      const { manage } = await employeeFor(scope, s, l.employee_id, true)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere empréstimos deste colaborador.')
      if (Number(l.version) !== expectedVersion) throw ApiError.versionConflict(Number(l.version))
      if (l.status !== 'DRAFT') wrongState('Só um pedido em rascunho se submete.')
      fail(await stateIssues(scope, l))
      await setStatus(scope, l, 'PENDING_APPROVAL')
      return loanView(await findLoan(scope, id), [])
    })
  }

  decide(
    context: TenantContext,
    id: string,
    approve: boolean,
    comment: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const l = await findLoan(scope, id, true)
      if (!l) throw ApiError.notFound()
      const s = await loanScopes(scope)
      const access = await employeeFor(scope, s, l.employee_id, true)
      if (!access.approve)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova empréstimos neste âmbito.')
      if (Number(l.version) !== expectedVersion) throw ApiError.versionConflict(Number(l.version))
      if (l.status !== 'PENDING_APPROVAL') wrongState('O pedido não aguarda aprovação.')
      if (l.created_by === context.userId)
        throw ApiError.forbidden('SEGREGATION', 'Quem prepara o pedido não o aprova.')
      if (l.membership_id && l.membership_id === context.membershipId)
        throw ApiError.forbidden('SEGREGATION', 'Ninguém aprova o seu próprio empréstimo.')
      if (!approve && !comment)
        fail([{ path: 'comment', code: 'REQUIRED', message: 'Indique o motivo da recusa.' }])
      const decision = {
        decided_by_membership_id: context.membershipId,
        decided_at: new Date().toISOString(),
        decision_comment: comment,
      }
      if (approve) {
        const issues = await stateIssues(scope, l)
        if (issues.length)
          throw new ApiError(
            409,
            'STALE_LOAN',
            'O pedido já não cumpre as regras em vigor; recuse-o e prepare outro.',
            issues
          )
        for (const p of schedule(l.principal, Number(l.installments_count), l.first_text))
          await scope.trx.rawQuery(
            `insert into employee_loan_installments (tenant_id, loan_id, sequence, due_period, amount, created_by,
               updated_by) values (?, ?, ?, ?, ?, ?, ?)`,
            [
              context.tenantId,
              l.id,
              p.sequence,
              p.duePeriod,
              p.amount,
              context.userId,
              context.userId,
            ]
          )
        await setStatus(scope, l, 'ACTIVE', decision)
      } else await setStatus(scope, l, 'REJECTED', decision, { comment })
      return loanView(await findLoan(scope, id), await installmentsOf(scope, id))
    })
  }

  cancel(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const l = await findLoan(scope, id, true)
      if (!l) throw ApiError.notFound()
      const s = await loanScopes(scope)
      const { manage } = await employeeFor(scope, s, l.employee_id)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere empréstimos deste colaborador.')
      if (Number(l.version) !== expectedVersion) throw ApiError.versionConflict(Number(l.version))
      if (!['DRAFT', 'PENDING_APPROVAL'].includes(l.status))
        wrongState('Um empréstimo activo não se cancela: liquida-se.')
      await setStatus(scope, l, 'CANCELLED')
      return loanView(await findLoan(scope, id), [])
    })
  }

  /** Pagamento directo de uma prestação pendente (por exemplo, amortização antecipada). */
  pay(
    context: TenantContext,
    id: string,
    installmentId: string,
    input: { reference: string; paidOn: string; note: string | null },
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const l = await findLoan(scope, id, true)
      if (!l) throw ApiError.notFound()
      const s = await loanScopes(scope)
      const { manage } = await employeeFor(scope, s, l.employee_id)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere empréstimos deste colaborador.')
      if (Number(l.version) !== expectedVersion) throw ApiError.versionConflict(Number(l.version))
      if (l.status !== 'ACTIVE') wrongState('Só um empréstimo activo recebe pagamentos.')
      if (input.paidOn > today())
        fail([{ path: 'paidOn', code: 'FUTURE', message: 'O pagamento não pode ser futuro.' }])
      if (!isUuid(installmentId)) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `update employee_loan_installments set status = 'PAID', settlement_reference = ?, settled_on = ?,
           settlement_note = ?, version = version + 1, updated_by = ?, updated_at = now()
         where tenant_id = ? and loan_id = ? and id = ? and status = 'PENDING' returning sequence`,
        [
          input.reference,
          input.paidOn,
          input.note,
          context.userId,
          context.tenantId,
          id,
          installmentId,
        ] as never[]
      )
      const row = r.rows[0] as { sequence: number } | undefined
      if (!row) {
        const exists = await scope.trx.rawQuery(
          `select 1 from employee_loan_installments where tenant_id = ? and loan_id = ? and id = ?`,
          [context.tenantId, id, installmentId]
        )
        if (!exists.rows.length) throw ApiError.notFound()
        throw ApiError.conflict('ALREADY_SETTLED', 'Esta prestação já está liquidada.')
      }
      // A versão do empréstimo muda em cada pagamento (concorrência optimista no detalhe).
      await scope.trx.rawQuery(
        `update employee_loans set version = version + 1, updated_by = ?, updated_at = now()
          where tenant_id = ? and id = ?`,
        [context.userId, context.tenantId, id]
      )
      await audit(scope, {
        action: 'hr.loans.installment_paid',
        entityType: 'employee_loan',
        entityId: id,
        metadata: {
          employeeId: l.employee_id,
          code: l.code,
          sequence: Number(row.sequence),
          reference: input.reference,
          amount: RESERVED,
        },
      })
      await settleIfDone(scope, id)
      return loanView(await findLoan(scope, id), await installmentsOf(scope, id))
    })
  }
}
